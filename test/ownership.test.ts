import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAllowedPath, OwnershipBroker, parseShellWrites } from "../packages/core/src/workflows/ownership.ts";
import { preRunVerify, VerificationGate } from "../packages/core/src/workflows/verify-gate.ts";

const withTemp = async (fn: (base: string) => Promise<void> | void): Promise<void> => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "looper-gates-test-"));
  try { await fn(base); } finally { fs.rmSync(base, { recursive: true, force: true }); }
};

test("credential paths are blocked, including explicit protected roots", async () => {
  await withTemp((base) => {
    fs.mkdirSync(path.join(base, ".ssh"), { recursive: true });
    fs.mkdirSync(path.join(base, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(base, "secrets", "token.txt"), "x");
    const gate = { cwd: base, writableRoots: [base] };
    for (const p of [".env", ".env.local", "server.pem", "server.key", "_id_rsa", path.join(base, ".ssh", "id_ed25519")]) {
      expect(() => assertAllowedPath(p, gate), p).toThrow(/credential/i);
    }
    expect(() => assertAllowedPath("secrets/token.txt", { ...gate, credentialPaths: [path.join(base, "secrets")] })).toThrow(/credential/i);
    // Committed templates hold no secrets.
    expect(assertAllowedPath(".env.example", gate)).toContain(".env.example");
  });
});

test("symlink writes and escapes through a symlink are blocked", async () => {
  await withTemp((base) => {
    const checkout = path.join(base, "checkout");
    const outside = path.join(base, "outside");
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "target.txt"), "do not touch");
    fs.writeFileSync(path.join(checkout, "plain.txt"), "ok");
    fs.symlinkSync(outside, path.join(checkout, "escape"));
    fs.symlinkSync(path.join(checkout, "plain.txt"), path.join(checkout, "alias.txt"));

    expect(() => assertAllowedPath("escape/target.txt", { cwd: checkout, writableRoots: [checkout] })).toThrow(/escapes checkout/i);
    expect(() => assertAllowedPath("alias.txt", { cwd: checkout, writableRoots: [checkout] })).toThrow(/symlink/i);
    expect(assertAllowedPath("new/file.txt", { cwd: checkout, writableRoots: [checkout] })).toContain("new/file.txt");
  });
});

test("ownership leases conflict, refcount, and release", async () => {
  await withTemp((base) => {
    const broker = new OwnershipBroker({ cwd: base });
    const first = broker.acquire("alice", ["src/a.ts"]);
    expect(broker.conflicts("bob", ["src/a.ts"])).toBe(true);
    expect(broker.available(["src/a.ts"])).toBe(false);
    expect(broker.available(["src/b.ts"])).toBe(true);
    expect(() => broker.acquire("bob", ["src/a.ts"])).toThrow(/conflict/i);

    const second = broker.acquire("alice", ["src/a.ts"]);
    expect(broker.refCount("alice")).toBe(2);
    first.release();
    expect(broker.activeOwners).toContain("alice");
    second.release();
    expect(broker.activeOwners).not.toContain("alice");
    expect(broker.available(["src/a.ts"])).toBe(true);

    broker.acquire("carol", ["src/c.ts"], true);
    expect(broker.conflicts("dave", ["elsewhere.txt"])).toBe(true);
    expect(broker.release("carol")).toBe(1);
    expect(broker.conflicts("dave", ["elsewhere.txt"])).toBe(false);
  });
});

test("shell writes are parsed by segment, and git rewrites need an explicit allow flag", async () => {
  const rewrite = parseShellWrites("git checkout -- src/a.ts");
  expect(rewrite.writes).toBe(true);
  expect(rewrite.rewrites).toEqual([{ command: "checkout", paths: ["src/a.ts"] }]);
  expect(rewrite.blocked).toHaveLength(1);
  expect(parseShellWrites("git checkout -- src/a.ts", { allowGitRewrites: true }).allowed).toBe(true);
  expect(parseShellWrites("git stash list").writes).toBe(false);

  const redirect = parseShellWrites("echo hi > src/b.ts");
  expect(redirect.dests).toContain("src/b.ts");
  expect(redirect.allowed).toBe(true);
  expect(parseShellWrites('rg "git checkout" src/a.ts').writes).toBe(false);
  expect(parseShellWrites("sh -c 'echo hi > src/c.ts'").dests).toContain("src/c.ts");

  // The heredoc body is script text, not a sequence of shell commands.
  const heredoc = parseShellWrites("cat > script.sh <<'EOF'\nrm -rf somewhere\nEOF");
  expect(heredoc.dests).toContain("script.sh");
  expect(heredoc.dests).not.toContain("somewhere");
});

test("verification gate dedupes commands and emits one failure receipt", async () => {
  await withTemp(async (base) => {
    const calls: string[] = [];
    let receipts = 0;
    const runner = (command: string) => {
      calls.push(command);
      return command === "bad"
        ? { ok: false, exitCode: 1, output: "FAIL: assertion" }
        : { ok: true, exitCode: 0, output: "PASS" };
    };
    const gate = new VerificationGate({ runner, onReceipt: () => { receipts++; } });
    expect(gate.register(base, ["good", "good", "bad"])).toHaveLength(2);
    const first = await gate.run(base);
    const second = await gate.run(base);
    expect(calls).toEqual(["good", "bad"]);
    expect(receipts).toBe(1);
    expect(second).toBe(first);
    expect(first.terminal).toBe(true);
    expect(first.ok).toBe(false);
    expect(first.results).toHaveLength(2);
    expect(first.results.find((r) => r.command === "bad")?.output).toContain("FAIL");
  });
});

test("preRunVerify reports observed failures from an injected runner", async () => {
  await withTemp(async (base) => {
    let calls = 0;
    const out = await preRunVerify(base, ["test", "test", "lint"], {
      runner: (command) => { calls++; return { ok: command !== "lint", exitCode: command === "lint" ? 2 : 0, output: command === "lint" ? "lint failed" : "ok" }; },
    });
    expect(calls).toBe(2);
    expect(out.ok).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.receipt.terminal).toBe(true);
    expect(out.receipt.ok).toBe(false);
    expect(out.results.find((r) => r.command === "lint")?.exitCode).toBe(2);
  });
});

test("default runner executes a real command through child_process", async () => {
  await withTemp(async (base) => {
    const out = await preRunVerify(base, ["printf looper-verify"], { timeoutMs: 5_000 });
    expect(out.ok).toBe(true);
    expect(out.results[0]?.exitCode).toBe(0);
    expect(out.results[0]?.output).toContain("looper-verify");
  });
});
