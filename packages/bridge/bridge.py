"""
Looper bridge addon for mitmdump.
Dumb pipe: mitmproxy hooks -> unix socket NDJSON -> decision -> apply.
Fail-open on any error/timeout.
"""
import json, socket, os, time, base64, threading
from mitmproxy import http, ctx

SOCK = None
SEQ = 0
LOCK = threading.Lock()
TIMEOUT = 2.0
PENDING = {}

def load(loader):
    loader.add_option(name="looper_sock", typespec=str, default="", help="Looper unix socket path")
    # Body capture is read from LOOPER_CAPTURE_BODIES (env) — a second add_option
    # changes configure() timing and can leave looper_sock unset when it fires.

def connect():
    global SOCK
    path = ctx.options.looper_sock
    if not path or SOCK:
        return
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(path)
        SOCK = s
        send({"t":"hello","pid":os.getpid()})
        ctx.log.info(f"[looper] connected {path}")
    except Exception as e:
        SOCK = None
        ctx.log.warn(f"[looper] connect failed: {e}")

def configure(updated):
    global SOCK
    path = ctx.options.looper_sock
    if not path:
        return
    try:
        if SOCK:
            SOCK.close()
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(path)
        SOCK = s
        send({"t":"hello","pid":os.getpid()})
        ctx.log.info(f"[looper] connected {path}")
    except Exception as e:
        SOCK = None
        ctx.log.warn(f"[looper] connect failed: {e}")

def running():
    connect()

def send(msg):
    global SOCK
    if not SOCK:
        connect()
    if not SOCK:
        return False
    try:
        data = (json.dumps(msg) + "\n").encode()
        with LOCK:
            SOCK.sendall(data)
        return True
    except Exception as e:
        ctx.log.warn(f"[looper] send failed: {e}")
        try: SOCK.close()
        except Exception: pass
        SOCK = None
        return False

def recv_decision(flow_id):
    global SOCK
    if not SOCK:
        return {"action":"pass"}
    with LOCK:
        if flow_id in PENDING:
            dec = PENDING.pop(flow_id)
            if dec.get("action") == "claim":
                pass
            else:
                return dec
    deadline = time.time() + TIMEOUT
    claim_deadline = None
    buf = b""
    try:
        while True:
            wait = max(0.05, min(1.0, deadline - time.time()))
            if claim_deadline is not None:
                wait = max(0.05, min(wait, claim_deadline - time.time()))
            if time.time() > deadline:
                ctx.log.warn(f"[looper] decision timeout {flow_id}")
                return {"action":"pass"}
            if claim_deadline is not None and time.time() > claim_deadline:
                ctx.log.warn(f"[looper] claim timeout {flow_id}")
                return {"action":"pass"}
            SOCK.settimeout(wait)
            try:
                chunk = SOCK.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                msg = json.loads(line.decode())
                if msg.get("t") == "decision":
                    did = msg.get("id")
                    dec = msg.get("decision", {"action":"pass"})
                    if did == flow_id:
                        if dec.get("action") == "claim":
                            tmo = int(dec.get("timeoutMs", 30000))
                            claim_deadline = time.time() + max(0.1, tmo / 1000.0)
                            continue
                        return dec
                    with LOCK:
                        PENDING[did] = dec
    except Exception as e:
        ctx.log.warn(f"[looper] recv failed: {e}")
        return {"action":"pass"}

def flow_id(flow):
    fid = getattr(flow, "_looper_id", None)
    if not fid:
        fid = f"f_{int(time.time()*1000)}_{id(flow)}"
        flow._looper_id = fid
    return fid

def capture_bodies():
    # Env is authoritative: a second --set option changes configure() timing
    # and can leave looper_sock unset in the addon.
    env = os.environ.get("LOOPER_CAPTURE_BODIES")
    return env == "1"

def req_to_dict(flow):
    r = flow.request
    body = ""
    if capture_bodies():
        try:
            body = r.get_text(strict=False) or ""
        except Exception:
            try: body = base64.b64encode(r.raw_content or b"").decode()
            except Exception: body = ""
    return {
        "id": flow_id(flow),
        "method": r.method,
        "url": r.pretty_url,
        "headers": dict(r.headers),
        "body": body,
    }

def res_to_dict(flow):
    r = flow.response
    body = ""
    if capture_bodies():
        try:
            body = r.get_text(strict=False) or ""
        except Exception:
            try: body = base64.b64encode(r.raw_content or b"").decode()
            except Exception: body = ""
    return {
        "status": r.status_code,
        "headers": dict(r.headers),
        "body": body,
    }

def apply_request(flow, decision):
    a = decision.get("action")
    if a == "pass":
        return
    if a == "drop":
        flow.kill()
        return
    if a == "respond":
        res = decision.get("response", {})
        flow.response = http.Response.make(
            res.get("status", 200),
            res.get("body", ""),
            res.get("headers", {}),
        )
        return
    if a == "mutate":
        req = decision.get("request", {})
        if "method" in req: flow.request.method = req["method"]
        if "url" in req: flow.request.url = req["url"]
        if "headers" in req:
            for k,v in req["headers"].items(): flow.request.headers[k] = v
        if "body" in req: flow.request.text = req["body"]

def request(flow):
    connect()
    fid = flow_id(flow)
    msg = {"t":"request","id":fid,"req":req_to_dict(flow)}
    if send(msg):
        apply_request(flow, recv_decision(fid))

def make_stream(fid):
    def stream(chunks):
        # mitmproxy may pass bytes or iterable[bytes]
        if isinstance(chunks, (bytes, bytearray)):
            chunks = [bytes(chunks)]
        for chunk in chunks:
            if isinstance(chunk, int):
                chunk = bytes([chunk])
            if isinstance(chunk, str):
                chunk = chunk.encode()
            msg = {"t":"response_chunk","id":fid,"chunk":{"id":fid,"direction":"response","data":base64.b64encode(chunk).decode(),"done":False}}
            if send(msg):
                d = recv_decision(fid)
                a = d.get("action")
                if a == "drop":
                    return
                if a == "mutate":
                    new = d.get("chunk", {}).get("data")
                    if new:
                        try: chunk = base64.b64decode(new)
                        except Exception: chunk = new.encode()
            yield chunk
        send({"t":"response_chunk","id":fid,"chunk":{"id":fid,"direction":"response","data":"","done":True}})
    return stream

def responseheaders(flow):
    connect()
    fid = flow_id(flow)
    msg = {"t":"responseheaders","id":fid,"res":{"id":fid,"status":flow.response.status_code,"headers":dict(flow.response.headers)}}
    if send(msg):
        d = recv_decision(fid)
        a = d.get("action")
        if a == "stream":
            flow.response.stream = make_stream(fid)
        elif a == "buffer":
            flow.response.stream = False
        elif a == "drop":
            flow.kill()

def response(flow):
    connect()
    fid = flow_id(flow)
    # if streamed, we may have sent chunks; still send final
    msg = {"t":"response","id":fid,"res":res_to_dict(flow)}
    if send(msg):
        d = recv_decision(fid)
        a = d.get("action")
        if a == "mutate":
            res = d.get("response", {})
            if "status" in res: flow.response.status_code = res["status"]
            if "headers" in res:
                for k,v in res["headers"].items(): flow.response.headers[k] = v
            if "body" in res: flow.response.text = res["body"]
        elif a == "drop":
            flow.kill()
    send({"t":"done","id":fid})

def error(flow):
    connect()
    fid = flow_id(flow)
    send({"t":"error","id":fid,"error":str(flow.error)})
