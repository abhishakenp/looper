/**
 * Deterministic write gates. A harness must be able to refuse a dangerous edit
 * without asking a model whether it *looks* dangerous, so everything here is
 * path arithmetic and shell tokenisation — no inference, no environment calls
 * beyond the filesystem needed to resolve symlinks.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface AllowedPathOptions {
  /** Roots a write may land in. Relative roots resolve against `cwd`. */
  writableRoots: string[];
  /** Extra protected files or directory prefixes, absolute or cwd-relative. */
  credentialPaths?: string[];
  cwd: string;
}

const stripAt = (p: string): string => p.startsWith("@") ? p.slice(1) : p;

/** Canonical form for comparison: realpath where the file exists, otherwise the resolved ancestor plus the missing tail. */
export const canonicalPath = (path: string, cwd: string = process.cwd()): string => {
  const absolute = resolve(cwd, stripAt(path));
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : resolve(canonicalPath(parent, cwd), relative(parent, absolute));
};

export const pathInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

// The four home directories a tool must never be able to rewrite via a checkout-relative path.
const HOME_CREDENTIAL_DIRS = [
  resolve(homedir(), ".ssh"),
  resolve(homedir(), ".aws"),
  resolve(homedir(), ".config", "gh"),
  resolve(homedir(), ".mitmproxy"),
];
const SENSITIVE_NAME = /(?:\.env(?:\..*)?|credentials\.[^/\\]*|[^/\\]*secret[^/\\]*|[^/\\]*\.(?:pem|key|p12|pfx|jks|keystore|truststore)|[^/\\]*_(?:rsa|dsa|ecdsa|ed25519)|serviceAccountKey\.json|[^/\\]*-credentials\.json)$/i;
// Committed placeholders carry no secrets; the real `.env*` still does.
const ENV_TEMPLATE = /^(?:\.env|[^/\\]*\.env)\.(?:example|sample|template|dist)$/i;

export const isCredentialPath = (path: string, extra: string[] = []): boolean => {
  const absolute = resolve(path);
  const name = basename(absolute);
  if (HOME_CREDENTIAL_DIRS.some((dir) => pathInside(absolute, dir))) return true;
  if (!ENV_TEMPLATE.test(name) && SENSITIVE_NAME.test(name)) return true;
  // `.env` may be a directory holding per-environment files, not only a file.
  if (absolute.split(/[/\\]/).some((part) => part.startsWith(".env.") && !ENV_TEMPLATE.test(part))) return true;
  return extra.some((protectedPath) => pathInside(absolute, protectedPath) || pathInside(protectedPath, absolute));
};

const isSymlink = (path: string): boolean => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};

/**
 * Resolve `path` and refuse it unless it stays inside a writable root, is not a
 * credential, and is not a symbolic link. Returns the canonical target, so a
 * caller can use the same string for the actual write and for leases.
 */
export const assertAllowedPath = (path: string, opts: AllowedPathOptions): string => {
  const { cwd, writableRoots, credentialPaths = [] } = opts;
  const absolute = resolve(cwd, stripAt(path));
  const target = canonicalPath(path, cwd);
  const roots = writableRoots.map((root) => canonicalPath(root, cwd));
  const protectedPaths = credentialPaths.map((p) => canonicalPath(p, cwd));

  if (!roots.some((root) => pathInside(target, root))) throw new Error(`Path escapes checkout: ${path}`);
  if (isCredentialPath(absolute, protectedPaths) || isCredentialPath(target, protectedPaths)) {
    throw new Error(`Protected credential path: ${path}`);
  }
  if (isSymlink(absolute)) throw new Error("Symlink writes are not supported");
  return target;
};

// ─── refcounted ownership ─────────────────────────────────────────────────

export interface LeaseEntry {
  owner: string;
  paths: string[];
  exclusive: boolean;
  refs: number;
}

export interface LeaseHandle {
  readonly owner: string;
  readonly paths: readonly string[];
  release(): void;
}

interface BrokerOptions {
  cwd?: string;
}

/**
 * Tool boundary, not an OS sandbox: every writer has to participate. Leases are
 * refcounted so a nested acquire by the same owner cannot be released by a
 * sibling's disposer; `release(owner)` drops all of that owner's refs.
 */
export class OwnershipBroker {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly cwd: string;
  onChange?: () => void;

  constructor(opts: BrokerOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
  }

  private normalize(paths: string[]): string[] {
    return [...new Set(paths.map((p) => resolve(this.cwd, stripAt(p))))];
  }

  get activeOwners(): string[] { return [...this.leases.keys()]; }

  /** Live leases with their reference counts, for status and handover. */
  get allRefs(): LeaseEntry[] {
    return [...this.leases.values()].map((entry) => ({ ...entry, paths: [...entry.paths] }));
  }

  refCount(owner: string): number { return this.leases.get(owner)?.refs ?? 0; }

  /** Would a lease by `owner` collide with a different owner's live lease? */
  conflicts(owner: string, paths: string[], exclusive = false): boolean {
    const wanted = this.normalize(paths);
    for (const [name, held] of this.leases) {
      if (name === owner) continue;
      if (exclusive || held.exclusive || held.paths.some((a) => wanted.some((b) => pathInside(a, b) || pathInside(b, a)))) return true;
    }
    return false;
  }

  available(paths: string[], exclusive = false, owner = ""): boolean {
    return !this.conflicts(owner, paths, exclusive);
  }

  /** Fail fast: there is no queueing here, so an acquisition is deterministic. */
  acquire(owner: string, paths: string[], exclusive = false): LeaseHandle {
    const wanted = this.normalize(paths);
    if (!wanted.length) throw new Error(`Ownership lease for ${owner} names no paths`);
    const held = this.leases.get(owner);
    if (held && (exclusive || held.exclusive) && held.exclusive !== exclusive) {
      throw new Error(`Ownership mode conflict for ${owner}`);
    }
    if (!held && this.conflicts(owner, wanted, exclusive)) {
      throw new Error(`Ownership conflict: ${owner} cannot acquire ${wanted.join(", ")}`);
    }
    const entry: LeaseEntry = held ?? { owner, paths: [], exclusive, refs: 0 };
    entry.paths = [...new Set([...entry.paths, ...wanted])];
    entry.exclusive = entry.exclusive || exclusive;
    entry.refs++;
    this.leases.set(owner, entry);
    let released = false;
    return {
      owner,
      get paths() { return [...entry.paths]; },
      release: () => {
        if (released) return;
        released = true;
        const current = this.leases.get(owner);
        if (!current) return;
        if (--current.refs <= 0) {
          this.leases.delete(owner);
          this.onChange?.();
        }
      },
    };
  }

  /** Drop one ref from `owner`. Returns the refs still held. */
  releaseOne(owner: string): number {
    const entry = this.leases.get(owner);
    if (!entry) return 0;
    if (--entry.refs <= 0) {
      this.leases.delete(owner);
      this.onChange?.();
      return 0;
    }
    return entry.refs;
  }

  /** Drop every ref held by `owner`. Returns how many were released. */
  release(owner: string): number {
    const refs = this.refCount(owner);
    if (!refs) return 0;
    this.leases.delete(owner);
    this.onChange?.();
    return refs;
  }

  assertOwned(owner: string, path: string): void {
    const entry = this.leases.get(owner);
    const target = resolve(this.cwd, stripAt(path));
    if (!entry || (!entry.exclusive && !entry.paths.some((p) => pathInside(target, p)))) {
      throw new Error(`No active ownership for ${path}`);
    }
  }
}

// ─── shell write parsing ──────────────────────────────────────────────────

export interface ShellSegment {
  toks: string[];
  redirects: string[];
}

export type GitRewriteCommand = "checkout" | "restore" | "reset" | "stash" | "clean";

export interface GitRewrite {
  command: GitRewriteCommand;
  paths: string[];
}

export interface ParseShellWritesOptions {
  /** Explicit opt-in for checkout-wide git rewrites; false (default) blocks them. */
  allowGitRewrites?: boolean | GitRewriteCommand[];
}

export interface ShellWriteReport {
  command: string;
  segments: ShellSegment[];
  /** Created or overwritten. */
  dests: string[];
  /** Edited in place or removed. */
  operands: string[];
  rewrites: GitRewrite[];
  mutates: boolean;
  /** A script body that writes files (heredoc / -c / -e), not merely mentions a path. */
  script: boolean;
  writes: boolean;
  blocked: string[];
  allowed: boolean;
}

const SHELL = /^(?:ba|z|k|da)?sh$/;
const INTERPRETER = /^(?:python[\d.]*|node|bun|deno|ruby|perl|php)$/;
const SCRIPT_WRITE = /\bopen\([^)]*,\s*['"][^'"]*[wax+]|\.write\(|write_?(?:File|Text|Bytes)\w*\(|\b(?:appendFile|unlink|rmSync|renameSync|mkdirSync|copyFile)\w*\(|shutil\.|os\.(?:remove|rename|unlink|makedirs|system)|subprocess/i;
const GIT_REWRITES = new Set<GitRewriteCommand>(["checkout", "restore", "reset", "stash", "clean"]);
const STASH_READ_ONLY = new Set(["list", "show"]);
const STASH_SUBCOMMANDS = new Set(["list", "show", "pop", "apply", "drop", "push", "clear", "create", "branch", "store"]);

/** Delimiter of a real heredoc opened on this line: `<<` outside quotes and arithmetic, not `<<<`. */
const heredocDelim = (line: string): string | undefined => {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\\") { i++; continue; }
    if (c !== "<" || line[i + 1] !== "<" || line[i - 1] === "<") continue;
    if (line[i + 2] === "<") { i += 2; continue; }
    const opens = (line.slice(0, i).match(/\(\(/g) ?? []).length - (line.slice(0, i).match(/\)\)/g) ?? []).length;
    if (opens > 0) continue;
    return /^-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line.slice(i + 2))?.[2];
  }
  return undefined;
};

/** Split heredoc bodies out before tokenising, so script text is never read as commands. */
const splitHeredocs = (command: string): { stripped: string; docs: { head: string; body: string }[] } => {
  const lines: string[] = [];
  const docs: { head: string; body: string }[] = [];
  let end: string | undefined;
  for (const line of command.split("\n")) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined;
      else docs[docs.length - 1].body += `${line}\n`;
      continue;
    }
    lines.push(line);
    end = heredocDelim(line);
    if (end !== undefined) docs.push({ head: line, body: "" });
  }
  return { stripped: lines.join("\n"), docs };
};

/** Split on shell separators outside quotes; pull redirects out of the token stream. */
const parseSegments = (command: string): ShellSegment[] => {
  const segments: ShellSegment[] = [];
  let toks: string[] = [];
  let redirects: string[] = [];
  let cur = "";
  let has = false;
  let quoted = false;
  let redirectNext = false;
  let quote: string | undefined;
  const pushTok = (): void => {
    if (has) {
      if (redirectNext) redirects.push(cur.replace(/\)+$/, ""));
      else toks.push(cur);
      redirectNext = false;
    }
    cur = ""; has = false; quoted = false;
  };
  const pushSeg = (): void => {
    pushTok(); redirectNext = false;
    if (toks.length || redirects.length) segments.push({ toks, redirects });
    toks = []; redirects = [];
  };
  const s = splitHeredocs(command).stripped;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { quote = c; has = true; quoted = true; }
    else if (c === ">") {
      // fd dups (`2>`, `&>`) belong to the operator, not to a target path.
      if (has && !quoted && /^(?:\d|&)$/.test(cur)) { cur = ""; has = false; } else pushTok();
      if (s[i + 1] === ">") i++;
      if (s[i + 1] === "&") { i++; while (/[\d-]/.test(s[i + 1] ?? "")) i++; continue; }
      redirectNext = true;
    } else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (c === ";" || c === "\n" || c === "|" || (c === "&" && s[i + 1] === "&")) {
      if ((c === "|" && s[i + 1] === "|") || c === "&") i++;
      pushSeg();
    } else if (c === " " || c === "\t") pushTok();
    else { cur += c; has = true; }
  }
  pushSeg();
  return segments;
};

/** Command word after env assignments and transparent wrappers. */
const commandStart = (toks: string[]): number => {
  let i = 0;
  while (i < toks.length && (/^\w+=/.test(toks[i]) || ["rtk", "proxy", "sudo", "time", "command", "env", "nice"].includes(toks[i]))) i++;
  return i;
};

/**
 * Identify real write positions in a shell command: redirect targets, tee/touch
 * destinations, cp/mv ends, in-place edit operands, writing script bodies, and
 * checkout-wide git rewrites. A path merely named in a read or a quoted string
 * is not a write.
 */
export const parseShellWrites = (command: string, opts: ParseShellWritesOptions = {}): ShellWriteReport => {
  const segments = parseSegments(command);
  const dests: string[] = [];
  const operands: string[] = [];
  const rewrites: GitRewrite[] = [];
  let mutates = false;
  let script = false;

  const hit = (newDests: string[], newOperands: string[] = []): void => {
    dests.push(...newDests.filter((t) => t !== "/dev/null"));
    operands.push(...newOperands);
    mutates = true;
  };

  const segmentWrites = (toks: string[], redirects: string[]): void => {
    if (redirects.some((t) => t !== "/dev/null")) hit(redirects);
    const at = commandStart(toks);
    const cmd = toks[at]?.split("/").pop() ?? "";
    const rest = toks.slice(at + 1);
    const stdin = rest.findIndex((t) => t.startsWith("<"));
    const args = (stdin < 0 ? rest : rest.slice(0, stdin)).filter((a) => !a.startsWith("-"));
    if (cmd === "tee" || cmd === "touch") hit(args);
    else if (cmd === "cp" || cmd === "install") hit(args.slice(-1));
    else if (cmd === "mv") hit(args.slice(-1), args.slice(0, -1));
    else if (cmd === "rm" || cmd === "truncate" || cmd === "patch") hit([], args);
    else if (cmd === "mkdir") hit([]);
    else if (cmd === "sed" && rest.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) hit([], args);
    else if (cmd === "perl" && rest.some((a) => /^-[0-9nplasw]*i/.test(a))) hit([], args);
    else if (cmd === "git") {
      const sub = rest[rest[0] === "-C" ? 1 : 0];
      if (sub === "apply") hit([]);
      else if (GIT_REWRITES.has(sub as GitRewriteCommand) && !(sub === "stash" && STASH_READ_ONLY.has(rest[1]))) {
        const tail = rest.slice(rest[0] === "-C" ? 2 : 1);
        const paths = tail.filter((x) => !x.startsWith("-") && !(sub === "stash" && STASH_SUBCOMMANDS.has(x)));
        rewrites.push({ command: sub as GitRewriteCommand, paths });
      }
    } else if (cmd === "xargs") {
      let i = 0;
      while (i < rest.length && rest[i].startsWith("-")) i += /^-[InPLdsE]$/.test(rest[i]) ? 2 : 1;
      segmentWrites(rest.slice(i), []);
    } else if (cmd === "find") {
      if (rest.includes("-delete")) mutates = true;
      rest.forEach((t, i) => {
        if (t !== "-exec" && t !== "-execdir") return;
        const end = rest.findIndex((x, j) => j > i && (x === ";" || x === "+"));
        segmentWrites(rest.slice(i + 1, end < 0 ? undefined : end), []);
      });
    } else if (SHELL.test(cmd)) {
      const k = rest.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (k >= 0 && rest[k + 1] !== undefined) {
        const nested = parseShellWrites(rest[k + 1], opts);
        dests.push(...nested.dests); operands.push(...nested.operands); rewrites.push(...nested.rewrites);
        mutates ||= nested.mutates; script ||= nested.script;
      }
    } else if (INTERPRETER.test(cmd)) {
      const k = rest.findIndex((a) => a === "-c" || a === "-e" || a === "--eval");
      if (k >= 0 && rest[k + 1] !== undefined && SCRIPT_WRITE.test(rest[k + 1])) { script = true; mutates = true; }
    }
  };

  const { docs } = splitHeredocs(command);
  for (const { head, body } of docs) {
    const seg = parseSegments(head).find((x) => x.toks.some((t) => t.startsWith("<<")));
    const at = seg ? commandStart(seg.toks) : -1;
    const cmd = at >= 0 ? seg!.toks[at]?.split("/").pop() ?? "" : "";
    if (cmd && SHELL.test(cmd)) {
      const nested = parseShellWrites(body, opts);
      dests.push(...nested.dests); operands.push(...nested.operands); rewrites.push(...nested.rewrites);
      mutates ||= nested.mutates; script ||= nested.script;
    } else if (cmd && INTERPRETER.test(cmd) && SCRIPT_WRITE.test(body)) {
      script = true; mutates = true;
    }
  }
  for (const seg of segments) segmentWrites(seg.toks, seg.redirects);

  const allow = opts.allowGitRewrites;
  const blocked: string[] = rewrites
    .filter((r) => allow !== true && !(Array.isArray(allow) && allow.includes(r.command)))
    .map((r) => `git ${r.command} rewrites the checkout`);

  return {
    command,
    segments,
    dests: [...new Set(dests)],
    operands: [...new Set(operands)],
    rewrites,
    mutates,
    script,
    writes: mutates || rewrites.length > 0,
    blocked: [...new Set(blocked)],
    allowed: blocked.length === 0,
  };
};
