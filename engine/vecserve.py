# -*- coding: utf-8 -*-
"""本地向量服务（只监听 127.0.0.1）

  GET  /health          -> {ok, embed, rerank, model, dim, rss_mb}
  POST /embed           -> {texts:[...], kind:"query"|"document"} => {vectors, dim, ms}
  POST /rerank          -> {query, docs:[...]} => {scores, ms}
  GET  /stats           -> 运行统计
  POST /shutdown        -> 退出

由 vindex.ensure_service() 按需拉起（detached），也可以手动：python vecserve.py
"""
import os, sys, json, time, argparse, threading, ctypes

import numpy as np

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SKILL_DIR)

_lock = threading.Lock()
_state = {
    "cfg": None, "embed": None, "rerank": None,
    "embed_err": None, "rerank_err": None,
    "model_name": None, "dim": None,
    "t0": time.time(), "calls": 0, "last_ms": 0,
}


def rss_mb():
    try:
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        ps = ctypes.WinDLL("psapi"); k = ctypes.WinDLL("kernel32")
        ps.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        c = PMC(); c.cb = ctypes.sizeof(c)
        if ps.GetProcessMemoryInfo(k.GetCurrentProcess(), ctypes.byref(c), c.cb):
            return round(c.WorkingSetSize / 1048576.0, 1)
    except Exception:
        pass
    return None


def _load_embed(cfg):
    from sentence_transformers import SentenceTransformer
    import torch
    path = cfg["models"]["embed"]
    # CPU 上 bf16 反而更慢（实测 18s/批 vs fp32 6s/批），统一 fp32。
    m = SentenceTransformer(path, device="cpu")
    m.max_seq_length = 32768
    m.eval()
    return m


def _load_rerank(cfg):
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    path = cfg["models"]["rerank"]
    tok = AutoTokenizer.from_pretrained(path, padding_side="left")
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(path, dtype=torch.float32, low_cpu_mem_usage=True)
    model.eval()
    return {"tok": tok, "model": model,
            "yes": tok.convert_tokens_to_ids("yes"), "no": tok.convert_tokens_to_ids("no")}


def get_embed(cfg):
    if _state["embed"] is None and _state["embed_err"] is None:
        with _lock:
            if _state["embed"] is None and _state["embed_err"] is None:
                try:
                    t = time.time()
                    _state["embed"] = _load_embed(cfg)
                    _state["dim"] = _state["embed"].get_sentence_embedding_dimension()
                    print("[vecserve] embed 就绪 %.1fs dim=%s" % (time.time() - t, _state["dim"]), flush=True)
                except Exception as e:
                    _state["embed_err"] = "%s: %s" % (type(e).__name__, e)
                    print("[vecserve] embed 加载失败 %s" % _state["embed_err"], flush=True)
    return _state["embed"]


def get_rerank(cfg):
    if _state["rerank"] is None and _state["rerank_err"] is None:
        with _lock:
            if _state["rerank"] is None and _state["rerank_err"] is None:
                try:
                    t = time.time()
                    _state["rerank"] = _load_rerank(cfg)
                    print("[vecserve] rerank 就绪 %.1fs" % (time.time() - t), flush=True)
                except Exception as e:
                    _state["rerank_err"] = "%s: %s" % (type(e).__name__, e)
                    print("[vecserve] rerank 加载失败 %s" % _state["rerank_err"], flush=True)
    return _state["rerank"]


INSTR = "Given a web search query, retrieve relevant passages that answer the query"
R_PRE = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query '
         'and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
R_SUF = "<|im_end|>\n<|im_start|>assistant\n"


def do_embed(cfg, texts, kind):
    import torch
    m = get_embed(cfg)
    if m is None:
        raise RuntimeError(_state["embed_err"] or "embed 未就绪")
    has_prompt = bool(getattr(m, "prompts", None)) and "query" in (m.prompts or {})
    if kind == "query" and not has_prompt:
        instr = cfg["embed"].get("query_instruction", "")
        texts = [instr + t for t in texts]
    bs = int(cfg["embed"].get("batch", 4))
    # 按长度排序分批，避免长文被短文拖累（padding 浪费）
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    out = [None] * len(texts)
    with _lock:
        with torch.inference_mode():
            for j in range(0, len(order), bs):
                idxs = order[j:j + bs]
                part = [texts[i] for i in idxs]
                v = m.encode(part, batch_size=bs, normalize_embeddings=True, convert_to_numpy=True,
                             show_progress_bar=False,
                             prompt_name="query" if (kind == "query" and has_prompt) else None)
                v = np.asarray(v, dtype=np.float32)
                for r, i in enumerate(idxs):
                    out[i] = v[r]
    _state["last_embed_at"] = time.time()
    return np.vstack(out)


def do_rerank(cfg, query, docs, batch=4, max_len=1024):
    import torch
    r = get_rerank(cfg)
    if r is None:
        raise RuntimeError(_state["rerank_err"] or "rerank 未就绪")
    tok, model = r["tok"], r["model"]
    out = []
    with _lock:
        with torch.inference_mode():
            for i in range(0, len(docs), batch):
                part = docs[i:i + batch]
                texts = [R_PRE + "<Instruct>: " + INSTR + "\n<Query>: " + query + "\n<Document>: " + d + R_SUF for d in part]
                enc = tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=max_len)
                logits = model(**enc).logits[:, -1, :]
                two = logits[:, [r["no"], r["yes"]]].float()
                p_yes = torch.softmax(two, dim=-1)[:, 1]
                out.extend(p_yes.tolist())
    _state["last_rerank_at"] = time.time()
    return out



def _free_model(name):
    """Drop a lazily loaded model and return its memory to the OS."""
    obj = _state.get(name)
    if obj is None:
        return False
    _state[name] = None
    _state[name + "_err"] = None
    del obj
    try:
        import gc
        gc.collect()
        gc.collect()
    except Exception:
        pass
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass
    try:
        import msvcrt
        msvcrt.heapmin()
    except Exception:
        pass
    # Windows 的堆不会主动把空页还给系统：再把工作集清一遍，
    # 任务管理器里立刻下降（下次用到时按需换页回来）。
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32")
        psapi = ctypes.WinDLL("psapi")
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        h_proc = k32.GetCurrentProcess()
        psapi.EmptyWorkingSet.argtypes = [wintypes.HANDLE]
        psapi.EmptyWorkingSet(h_proc)
        k32.SetProcessWorkingSetSize.argtypes = [wintypes.HANDLE, ctypes.c_size_t, ctypes.c_size_t]
        k32.SetProcessWorkingSetSize(h_proc, ctypes.c_size_t(-1), ctypes.c_size_t(-1))
    except Exception:
        pass
    _state["last_unload_at"] = time.time()
    _state["unload_count"] = int(_state.get("unload_count") or 0) + 1
    print("[vecserve] idle unload %s" % name, flush=True)
    return True


def reclaim_loop(cfg):
    """Unload the optional reranker after idle time to keep RSS low."""
    svc = cfg.get("service") or {}
    rerank_idle = float(svc.get("rerank_idle_unload_min") or 5) * 60
    embed_idle = float(svc.get("embed_idle_unload_min") or 0) * 60
    while True:
        time.sleep(30)
        try:
            now = time.time()
            if rerank_idle > 0 and _state.get("rerank") is not None:
                last = _state.get("last_rerank_at") or _state.get("t0") or now
                if now - last >= rerank_idle:
                    _free_model("rerank")
            if embed_idle > 0 and _state.get("embed") is not None:
                last = _state.get("last_embed_at") or _state.get("t0") or now
                if now - last >= embed_idle:
                    _free_model("embed")
                    _state["dim"] = None
        except Exception as e:
            print("[vecserve] reclaim error %s: %s" % (type(e).__name__, e), flush=True)


# ---- 宿主存活看门狗（DSH 退出 → 服务自动关闭，避免空转占内存）----
_watch = {"pid": 0}
_watch_thread_started = False


def _proc_alive(pid):
    """进程是否仍存活（Windows：OpenProcess + WaitForSingleObject）。"""
    pid = int(pid or 0)
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.OpenProcess.restype = ctypes.c_void_p
            k32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
            k32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            k32.WaitForSingleObject.restype = ctypes.c_uint32
            k32.CloseHandle.argtypes = [ctypes.c_void_p]
            h = k32.OpenProcess(0x1000 | 0x00100000, False, pid)  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE
            if not h:
                return False
            try:
                return int(k32.WaitForSingleObject(h, 0)) == 0x00000102  # WAIT_TIMEOUT → 还活着
            finally:
                k32.CloseHandle(h)
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def watch_loop():
    while True:
        time.sleep(3.0)
        pid = _watch["pid"]
        if pid and not _proc_alive(pid):
            print("[vecserve] 宿主进程 %d 已退出，服务自动关闭" % pid, flush=True)
            os._exit(0)


def start_watch(pid):
    global _watch_thread_started
    pid = int(pid or 0)
    if pid > 0:
        _watch["pid"] = pid
    if not _watch_thread_started:
        _watch_thread_started = True
        threading.Thread(target=watch_loop, daemon=True).start()
    return _watch["pid"]


_index_cache = {"sig": None, "idx": None}


def _cached_index(vs, cfg):
    """常驻进程里缓存索引（vectors.npy 5MB 级），索引文件变了才重读。"""
    try:
        p = vs.paths(cfg)
        st = os.stat(p["vectors"])
        sig = (st.st_mtime_ns, st.st_size)
    except Exception:
        return None
    if _index_cache["sig"] != sig:
        try:
            idx = vs.load_index(cfg)
        except Exception:
            return None
        _index_cache["idx"] = idx
        _index_cache["sig"] = sig
    return _index_cache["idx"]

_vindex_mod = [None]


def _vindex():
    """检索逻辑复用 vindex.py，与 CLI 保持同一实现，避免两套代码分叉。"""
    if _vindex_mod[0] is None:
        import vindex as _v
        _vindex_mod[0] = _v
    return _vindex_mod[0]


def make_handler(cfg, server_holder):

    from http.server import BaseHTTPRequestHandler

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def handle(self):
            # 客户端中途断开（健康轮询超时、被 kill 的 CLI）会在写响应时抛 ConnectionResetError，
            # 那只是对端没了，不是服务故障。吞掉，免得日志被 62+ 条 Traceback 淹没。
            try:
                super().handle()
            except (ConnectionError, OSError):
                self.close_connection = True

        def _send(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (ConnectionError, OSError):
                self.close_connection = True

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

        def do_GET(self):
            if self.path.startswith("/health"):
                self._send({"ok": True, "embed": _state["embed"] is not None,
                            "rerank": _state["rerank"] is not None,
                            "embed_error": _state["embed_err"], "rerank_error": _state["rerank_err"],
                            "model": os.path.basename(cfg["models"]["embed"]), "dim": _state["dim"],
                            "rss_mb": rss_mb(), "uptime_s": int(time.time() - _state["t0"]),
                            "watch_pid": _watch["pid"]})
            elif self.path.startswith("/stats"):
                self._send({"calls": _state["calls"], "last_ms": _state["last_ms"],
                            "rss_mb": rss_mb(), "dim": _state["dim"],
                            "embed_ready": _state["embed"] is not None, "rerank_ready": _state["rerank"] is not None,
                            "unload_count": _state.get("unload_count") or 0,
                            "last_unload_at": _state.get("last_unload_at")})
            else:
                self._send({"error": "not found"}, 404)

        def do_POST(self):
            try:
                body = self._body()
                t = time.time()
                if self.path.startswith("/embed"):
                    v = do_embed(cfg, body.get("texts", []), body.get("kind", "document"))
                    ms = int((time.time() - t) * 1000)
                    _state["calls"] += 1; _state["last_ms"] = ms
                    self._send({"vectors": v.tolist(), "dim": int(v.shape[1]) if v.size else 0, "ms": ms})
                elif self.path.startswith("/rerank"):
                    s = do_rerank(cfg, body["query"], body.get("docs", []))
                    ms = int((time.time() - t) * 1000)
                    _state["calls"] += 1; _state["last_ms"] = ms
                    self._send({"scores": s, "ms": ms})
                elif self.path.startswith("/search"):
                    # 常驻进程内直接检索：省掉每次 spawn python 的约 250ms（每回合召回都走这条路）
                    vs = _vindex()
                    srcs = body.get("srcs")
                    if isinstance(srcs, str):
                        srcs = [x for x in srcs.split(",") if x]
                    res = vs.search(cfg, str(body.get("query") or ""),
                                    k=body.get("k"),
                                    use_rerank=body.get("rerank"),
                                    src=body.get("src"),
                                    srcs=srcs or None,
                                    verbose=False,
                                    idx=_cached_index(vs, cfg))
                    ms = int((time.time() - t) * 1000)
                    _state["calls"] += 1; _state["last_ms"] = ms
                    # vindex.search 返回 (hits, info) 元组
                    if isinstance(res, tuple) and len(res) == 2:
                        hits, info = res[0], dict(res[1] or {})
                    elif isinstance(res, dict):
                        hits, info = res.get("hits", []), dict(res.get("info") or {})
                    else:
                        hits, info = list(res or []), {}
                    info.setdefault("ms", ms)
                    # 回显请求参数，调用方据此确认服务端真的用了这次 query/k（不一致就回退 CLI）
                    self._send({"hits": list(hits), "info": info,
                                "query": str(body.get("query") or ""), "k": body.get("k")})
                elif self.path.startswith("/watch"):
                    self._send({"ok": True, "watch_pid": start_watch(body.get("pid"))})
                elif self.path.startswith("/shutdown"):
                    self._send({"ok": True})
                    threading.Thread(target=server_holder[0].shutdown, daemon=True).start()
                else:
                    self._send({"error": "not found"}, 404)
            except Exception as e:
                self._send({"error": "%s: %s" % (type(e).__name__, e)}, 500)

    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(SKILL_DIR, "config.json"))
    ap.add_argument("--watch-pid", type=int, default=0, help="宿主产物 PID；宿主退出后本服务自动关闭")
    args = ap.parse_args()
    cfg = json.load(open(args.config, encoding="utf-8"))
    _state["cfg"] = cfg
    if args.watch_pid:
        start_watch(args.watch_pid)

    import torch
    nth = int(cfg["service"].get("threads") or 12)
    torch.set_num_threads(max(1, min(nth, 32)))

    from http.server import ThreadingHTTPServer
    host = str(cfg["service"].get("host", "127.0.0.1"))
    port = int(cfg["service"].get("port", 8479))

    # 安全护栏：默认只允许回环地址。改成 0.0.0.0 之类的对外地址会让本机记忆
    # 暴露到局域网，必须由用户在配置里显式写 service.allow_remote=true 才放行。
    loopback = {"127.0.0.1", "localhost", "::1", "127.0.0.2"}
    if host not in loopback and not cfg["service"].get("allow_remote"):
        print(
            "[vecserve] 拒绝绑定 %s：这会把本地记忆暴露到网络。"
            "确实需要时，在 config.json 的 service 里加 \"allow_remote\": true。" % host,
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(2)

    holder = [None]
    srv = ThreadingHTTPServer((host, port), make_handler(cfg, holder))
    holder[0] = srv
    print("[vecserve] listening %s:%d pid=%d" % (host, port, os.getpid()), flush=True)
    # 预热：先在后台把 embed 模型加载好，健康检查在就绪前返回 embed:false
    threading.Thread(target=get_embed, args=(cfg,), daemon=True).start()
    threading.Thread(target=reclaim_loop, args=(cfg,), daemon=True).start()
    try:
        srv.serve_forever()
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
