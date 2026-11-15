# -*- coding: utf-8 -*-
"""vector-memory 核心库

职责：
  1. 增量索引：把登记的笔记目录切成 chunk，走本地 embedding 服务算向量，
     按 mtime+大小 增量更新，内容哈希缓存向量（改名/移动不重算）。
  2. 混合检索：BM25（中文按 字+双字 切分）+ 向量余弦 → RRF 融合 → 可选 Qwen3-Reranker 重排。
  3. 服务管理：按需拉起 / 复用本地 HTTP 服务（vecserve.py），不常驻也能用。

依赖：只用标准库 + numpy（CLI 侧）。真正的模型推理在 vecserve.py（另一个 python 环境）里。
"""
import os, sys, json, re, glob, time, math, hashlib, subprocess, urllib.request, urllib.error

import numpy as np

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(SKILL_DIR, "config.json")


# ---------------------------------------------------------------- config
def load_config(path=None):
    with open(path or CFG_PATH, encoding="utf-8") as f:
        return json.load(f)


def paths(cfg):
    d = cfg["data_dir"]
    out = {
        "root": d,
        "dir": os.path.join(d, "index"),
        "vectors": os.path.join(d, "index", "vectors.npy"),
        "meta": os.path.join(d, "index", "meta.jsonl"),
        "manifest": os.path.join(d, "index", "manifest.json"),
        "tokens": os.path.join(d, "index", "tokens.json"),
        "embcache": os.path.join(d, "index", "embcache.npz"),
        "log": os.path.join(d, "logs", "serve.log"),
        "pid": os.path.join(d, "serve.pid"),
    }
    os.makedirs(out["dir"], exist_ok=True)
    os.makedirs(os.path.dirname(out["log"]), exist_ok=True)
    return out


def sha1(text):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:20]


# ---------------------------------------------------------------- service
def base_url(cfg):
    s = cfg["service"]
    return "http://%s:%d" % (s.get("host", "127.0.0.1"), int(s.get("port", 8479)))


def _post(url, payload, timeout=300):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _get(url, timeout=2.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def health(cfg, timeout=1.5):
    try:
        return _get(base_url(cfg) + "/health", timeout=timeout)
    except Exception:
        return None


def _spawn_service(cfg, watch_pid=None):
    py = cfg["python"]
    if not os.path.exists(py):
        raise RuntimeError("找不到 python 解释器：%s（改 config.json 的 python 字段）" % py)
    flags = 0
    if os.name == "nt":
        # NO_WINDOW | NEW_PROCESS_GROUP：静默启动，不弹控制台窗口。
        # 注意：不要加 DETACHED_PROCESS——实测它会绕过 NO_WINDOW，
        # 让 Windows Terminal 给子进程开一个可见黑窗；父进程退出后子进程
        # 本来就会继续存活（Windows 不会级联杀子进程），不需要 DETACHED。
        flags = 0x08000000 | 0x00000200
    p = paths(cfg)
    cmd = [py, os.path.join(SKILL_DIR, "vecserve.py"), "--config", os.path.join(SKILL_DIR, "config.json")]
    if watch_pid:
        cmd += ["--watch-pid", str(int(watch_pid))]
    with open(p["log"], "ab") as lf:
        return subprocess.Popen(
            cmd,
            stdout=lf, stderr=lf, stdin=subprocess.DEVNULL,
            creationflags=flags, close_fds=True, cwd=SKILL_DIR,
        )


def _log_tail(cfg, limit=1200):
    try:
        with open(paths(cfg)["log"], "r", encoding="utf-8", errors="replace") as f:
            data = f.read()
        return data[-limit:].strip()
    except Exception:
        return "(暂无日志)"


def _watch_service(cfg, watch_pid):
    """让已在运行的服务认领宿主 PID（幂等；失败不影响检索）。"""
    try:
        h = health(cfg)
        if h and int(h.get("watch_pid") or 0) == int(watch_pid):
            return
        _post(base_url(cfg) + "/watch", {"pid": int(watch_pid)}, timeout=2.0)
    except Exception:
        pass


def ensure_service(cfg, verbose=False, watch_pid=None):
    """返回 /health 结果（embed 已就绪）；未运行则拉起守护进程。

    watch_pid = 宿主（DSH）进程 PID；服务会盯着它，宿主退出后自动关闭，
    避免关掉 DSH 后 Python 进程还驻留占内存。也可用环境变量
    VECTOR_MEMORY_WATCH_PID 传入。启动失败（例如端口被上一代实例占用）会
    自动重试，最多 3 次；每次失败都记下退出码与日志末尾，方便排查。
    """
    watch_pid = int(watch_pid or 0) or int(os.environ.get("VECTOR_MEMORY_WATCH_PID") or 0) or None
    h = health(cfg)
    if h and h.get("embed"):
        if watch_pid:
            _watch_service(cfg, watch_pid)
        return h
    if h and not h.get("embed") and verbose:
        print("[vec] 服务在启动中，等待模型加载…")

    proc = None
    spawned_at = 0.0
    attempts = 0
    deadline = time.time() + float(cfg["service"].get("start_timeout_sec", 90))
    while time.time() < deadline:
        # 注意：uv venv 的 python.exe 是转发壳，spawn 后它会立刻 exit 0，
        # 真正的解释器是它的子进程。所以只有「退出 + 健康检查也连不上」才算失败，
        # 否则会把一次正常启动误判成失败，重复拉起造成端口竞争。
        if (proc is not None and proc.poll() is not None
                and time.time() - spawned_at > 2.0 and health(cfg) is None):
            code = proc.returncode
            proc = None
            attempts += 1
            if attempts >= 3:
                raise RuntimeError(
                    "向量服务连续 %d 次启动失败（最后一次 exit %s）。日志末尾：\n%s"
                    % (attempts, code, _log_tail(cfg))
                )
            if verbose:
                print("[vec] 服务启动失败（exit %s），重试第 %d 次…" % (code, attempts))
        if proc is None:
            h = health(cfg)
            if h and h.get("embed"):
                if watch_pid:
                    _watch_service(cfg, watch_pid)
                return h
            if not h:  # 当前确实没有服务在跑，才拉起
                if verbose:
                    print("[vec] 启动本地向量服务…")
                proc = _spawn_service(cfg, watch_pid=watch_pid)
                spawned_at = time.time()
        time.sleep(0.4)
        h = health(cfg)
        if h and h.get("embed"):
            if watch_pid:
                _watch_service(cfg, watch_pid)
            return h
    raise RuntimeError(
        "向量服务启动超时（%ss），最后日志末尾：\n%s"
        % (cfg["service"].get("start_timeout_sec", 90), _log_tail(cfg))
    )


def embed_texts(cfg, texts, kind="document", verbose=False):
    """kind: query | document。返回 float32 [n, dim]（已 L2 归一化）。"""
    out = []
    batch = int(cfg["embed"].get("batch", 8))
    url = base_url(cfg) + "/embed"
    for i in range(0, len(texts), batch):
        part = texts[i:i + batch]
        try:
            r = _post(url, {"texts": part, "kind": kind})
        except urllib.error.URLError:
            ensure_service(cfg, verbose=verbose)
            r = _post(url, {"texts": part, "kind": kind})
        out.extend(r["vectors"])
        if verbose:
            print("[vec] embed %d/%d" % (min(i + batch, len(texts)), len(texts)))
    a = np.asarray(out, dtype=np.float32)
    if a.size:
        n = np.linalg.norm(a, axis=1, keepdims=True)
        a = a / np.maximum(n, 1e-9)
    return a


def rerank(cfg, query, docs, top_n=None, verbose=False):
    """返回与 docs 等长的分数列表（越高越相关）。"""
    url = base_url(cfg) + "/rerank"
    body = {"query": query, "docs": docs, "top_n": top_n or len(docs)}
    try:
        r = _post(url, body, timeout=600)
    except urllib.error.URLError:
        ensure_service(cfg, verbose=verbose)
        r = _post(url, body, timeout=600)
    return r["scores"], r.get("ms", 0)


# ---------------------------------------------------------------- chunking
def _title(text):
    m = re.match(r"^-\s*[\d\-年月日\s:（补记）]*(?:\d{4}-\d{2}-\d{2})?\s*(.*?)(?:。|：|$)", text)
    t = (m.group(1) if m else text).strip(" *#`")
    t = re.sub(r"\s+", " ", t)
    return t[:60]


def chunk_file(path, cfg, rel):
    """把一个 .md 切成 chunk 列表：[{text, line, heading}]"""
    min_chars = int(cfg["chunk"].get("min_chars", 40))
    max_chars = int(cfg["chunk"].get("max_chars", 1200))
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()

    # decisions.md：一条决策（以 "- " 开头的整行）就是一个 chunk，天然语义完整
    if os.path.basename(path) == "decisions.md":
        out = []
        for i, line in enumerate(raw.splitlines()):
            if line.startswith("- ") and len(line.strip()) >= min_chars:
                out.append({"text": line.strip(), "line": i + 1, "heading": _title(line)})
        return out

    out = []
    buf = []
    heading = ""
    start = 1

    def flush():
        if not buf:
            return
        text = " ".join(x.strip() for x in buf if x.strip()).strip()
        if len(text) >= min_chars:
            out.append({"text": text, "line": start, "heading": heading})

    for i, line in enumerate(raw.splitlines()):
        s = line.strip()
        if line.startswith("#"):
            flush()
            buf = [s]
            heading = s.strip("# ").strip()
            start = i + 1
            continue
        if s.startswith("- ") or s.startswith("* "):
            # 每条要点单独成块：语义更纯，检索更准（与 decisions.md 同理）
            flush()
            buf = [s]
            start = i + 1
            continue
        if not s:
            flush()
            buf = []
            continue
        if not buf:
            buf = []
            start = i + 1
        buf.append(s)
        if len(" ".join(buf)) > max_chars:
            flush()
            buf = []
    flush()
    return out


# 索引时永远跳过的噪音目录（项目可能在任意盘符，仓库里这类目录最容易把索引撑爆）
_DEFAULT_EXCLUDE_DIRS = [
    "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
    "venv", ".venv", "env", "__pycache__", ".idea", ".vscode", ".next", ".nuxt",
    "vendor", "coverage", ".pytest_cache", ".mypy_cache", "site-packages",
    ".cache", "bin", "obj", "deps",
]


def all_sources(cfg):
    """全局 sources（用户在 config 里登记的常驻目录）+ 动态注册的项目 sources。

    项目 source 由插件在会话里注册到 config.json 的 `projects` 数组，
    所以「跨盘项目」和内置记忆走同一条索引/检索链路，不需要第二套代码。
    """
    out = []
    for s in cfg.get("sources") or []:
        out.append(dict(s))
    for s in project_sources(cfg):
        if s.get("enabled") is False:
            continue
        out.append(dict(s))
    return [s for s in out if s.get("root") and os.path.isdir(s["root"])]


def project_sources(cfg):
    """动态注册的项目源。新键 project_sources；兼容早期的 projects 数组写法。"""
    for key in ("project_sources", "projects"):
        v = cfg.get(key)
        if isinstance(v, list):
            return v
    return []


def _src_label(src):
    root = os.path.abspath(src["root"])
    return src.get("label") or os.path.basename(root.rstrip("\\/")) or root[:2]


def iter_source_files(cfg):
    """遍历所有源文件。

    支持：扩展名白名单（默认 .md）、排除噪音目录、单文件大小上限、单源文件数上限。
    跨盘项目常见几万个文件，没有这些上限会在第一次索引时卡死。
    """
    seen = set()
    for src in all_sources(cfg):
        root = os.path.abspath(src["root"])
        exts = tuple(e.lower() for e in (src.get("extensions") or [".md"]))
        exclude = set(x.lower() for x in _DEFAULT_EXCLUDE_DIRS)
        exclude |= set(x.lower() for x in (src.get("exclude_dirs") or []))
        try:
            max_kb = int(src.get("max_file_kb") or (cfg.get("project_index") or {}).get("max_file_kb", 512))
        except Exception:
            max_kb = 512
        try:
            max_files = int(src.get("max_files") or (cfg.get("project_index") or {}).get("max_files", 200))
        except Exception:
            max_files = 200
        n = 0
        for pat in src.get("globs") or ["**/*.md"]:
            for p in glob.glob(os.path.join(root, pat), recursive=True):
                if n >= max_files:
                    break
                if not os.path.isfile(p):
                    continue
                if not p.lower().endswith(exts):
                    continue
                try:
                    parts = set(x.lower() for x in os.path.relpath(p, root).replace("\\", "/").split("/")[:-1])
                except Exception:
                    continue
                if parts & exclude:
                    continue
                try:
                    if os.path.getsize(p) > max_kb * 1024:
                        continue
                except OSError:
                    continue
                ap = os.path.abspath(p)
                if ap in seen:
                    continue
                seen.add(ap)
                n += 1
                yield src["name"], p


# ---------------------------------------------------------------- index io
def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _load_meta(p):
    if not os.path.exists(p["meta"]):
        return []
    rows = []
    with open(p["meta"], encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_index(cfg):
    p = paths(cfg)
    if not os.path.exists(p["vectors"]) or not os.path.exists(p["meta"]):
        raise RuntimeError("索引还不存在，先跑：python vsearch.py index")
    meta = _load_meta(p)
    vec = np.load(p["vectors"])
    ch = _load_json(p["tokens"], {}).get("ch", [])
    if len(meta) != len(vec) or len(ch) != len(meta):
        raise RuntimeError("索引文件不一致（meta=%d vectors=%d tokens=%d），跑 index --force 重建" % (len(meta), len(vec), len(ch)))
    return {"meta": meta, "vectors": vec, "ch": ch}


# ---------------------------------------------------------------- bm25
def _norm(s):
    return re.sub(r"[\s\W_]+", "", s.lower())


def _qtokens(qch):
    """字符 + 双字（对中文够用，且零依赖）"""
    return list(qch) + [qch[i:i + 2] for i in range(len(qch) - 1)]


class BM25:
    def __init__(self, docs_ch, k1=1.5, b=0.75):
        self.k1, self.b = k1, b
        self.docs = docs_ch
        self.N = len(docs_ch)
        dfs = {}
        lens = []
        for d in docs_ch:
            toks = set(_qtokens(d))
            for t in toks:
                dfs[t] = dfs.get(t, 0) + 1
            lens.append(len(d))
        self.df = dfs
        self.avgdl = (sum(lens) / self.N) if self.N else 1.0

    def scores(self, query):
        q = _norm(query)
        sc = np.zeros(self.N, dtype=np.float32)
        if not q:
            return sc
        for t in set(_qtokens(q)):
            df = self.df.get(t)
            if not df:
                continue
            idf = math.log(1 + (self.N - df + 0.5) / (df + 0.5))
            for i, d in enumerate(self.docs):
                c = d.count(t)
                if c:
                    dl = len(d)
                    sc[i] += idf * c * (self.k1 + 1) / (c + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
        return sc


# ---------------------------------------------------------------- build
def _src_of_path(cfg, path):
    """最长前缀匹配，把绝对路径归到某个源（与 rel() 同口径）。"""
    ap = os.path.abspath(path)
    best = None
    for src in all_sources(cfg):
        r = os.path.abspath(src["root"])
        if (ap == r or ap.startswith(r + os.sep)) and (best is None or len(r) > len(best[0])):
            best = (r, src)
    return best[1] if best else None


def build_index(cfg, force=False, verbose=True, only=None):
    """重建/增量更新索引。

    only: 只重算这些源（项目标签或源名）的块，其余源的 meta 与向量原样保留。
    用于"只索引某一个项目"，避免为了一个项目重算全部源。
    """
    t0 = time.time()
    p = paths(cfg)
    only_set = None
    if only:
        want = set(only)
        known = {}
        for src in all_sources(cfg):
            known[_src_label(src)] = src
            known[src.get("name", "")] = src
        picked = set()
        for name in want:
            src = known.get(name)
            if src is not None:
                picked.add(src.get("name") or _src_label(src))
        if not picked:
            raise RuntimeError("没有匹配的源：%s（可选：%s）" % (
                ", ".join(sorted(want)), ", ".join(sorted(set(_src_label(s) for s in all_sources(cfg))))))
        only_set = picked
        if verbose:
            print("[vec] 只更新源：%s" % ", ".join(sorted(only_set)))
    old_meta = [] if force else _load_meta(p)
    # 旧索引没有 emb 字段（切块/向量输入口径不同）→ 自动全量重建，避免新旧混用
    if old_meta and "emb" not in old_meta[0]:
        force = True
        old_meta = []
    old_vec = np.zeros((0, int(cfg["embed"]["dim"])), dtype=np.float32) if force or not os.path.exists(p["vectors"]) else np.load(p["vectors"])
    old_manifest = {} if force else _load_json(p["manifest"], {})
    kept_rows, kept_vecs = [], []
    if only_set:
        n = min(len(old_meta), len(old_vec))
        for i in range(n):
            m = old_meta[i]
            if m["src"] not in only_set:
                kept_rows.append(dict(m))
                kept_vecs.append(old_vec[i])
        old_manifest = {}
        for k, v in (_load_json(paths(cfg)["manifest"], {}) if not force else {}).items():
            src = _src_of_path(cfg, k)
            if src is None or (src.get("name") or _src_label(src)) not in only_set:
                old_manifest[k] = v

    # 内容哈希 -> 向量（跨文件复用，改名/移动不重算）
    emb = {}
    if not force and os.path.exists(p["embcache"]):
        z = np.load(p["embcache"], allow_pickle=False)
        for h, v in zip(z["hashes"].tolist(), z["vecs"]):
            emb[str(h)] = v

    # 旧的 hash -> (meta, 向量)
    old_by_hash = {}
    for i, m in enumerate(old_meta):
        if i < len(old_vec):
            old_by_hash[m["hash"]] = (m, old_vec[i])
            emb.setdefault(m["hash"], old_vec[i])
    for i, m in enumerate(kept_rows):
        emb.setdefault(m["hash"], kept_vecs[i])

    manifest, rows, toks = {}, list(kept_rows), [_norm(m.get("emb") or m["text"]) for m in kept_rows]
    need, need_pos = [], []          # 需要新算向量的文本
    stats = {"files": 0, "files_changed": 0, "chunks": 0, "reused": 0, "new": 0, "by_src": {}}
    if only_set:
        stats["only"] = sorted(only_set)

    def rel(p_):
        ap = os.path.abspath(p_)
        best = None
        for src in all_sources(cfg):
            r = os.path.abspath(src["root"])
            if (ap == r or ap.startswith(r + os.sep)) and (best is None or len(r) > len(best[0])):
                best = (r, src)
        if best:
            r, src = best
            return _src_label(src) + "/" + os.path.relpath(ap, r).replace(os.sep, "/")
        return os.path.basename(p_)

    files = sorted(iter_source_files(cfg))
    if only_set:
        def _name_of(path):
            src = _src_of_path(cfg, path)
            return (src.get("name") or _src_label(src)) if src else None
        files = [(name, path) for name, path in files if _name_of(path) in only_set]
    for src_name, path in files:
        st = os.stat(path)
        key = os.path.abspath(path)
        prev = old_manifest.get(key)
        stats["files"] += 1
        by = stats["by_src"].setdefault(src_name, {"files": 0, "chunks": 0})
        by["files"] += 1
        if prev and not force and prev.get("mtime_ns") == st.st_mtime_ns and prev.get("size") == st.st_size:
            hs = prev["hashes"]
            if all(h in old_by_hash for h in hs):
                for h in hs:
                    m = dict(old_by_hash[h][0])
                    rows.append(m)
                    toks.append(_norm(m.get("emb") or m["text"]))
                manifest[key] = prev
                stats["reused"] += len(hs)
                # 复用的文件也要记块数，否则增量索引后 stats.by_src.chunks 会全变 0
                by["chunks"] += len(hs)
                continue
        stats["files_changed"] += 1
        try:
            chs = chunk_file(path, cfg, rel(path))
        except Exception as e:
            if verbose:
                print("[vec] 跳过 %s：%s" % (path, e))
            continue
        hs = []
        rel_path = rel(path)
        by["chunks"] += len(chs)
        for c in chs:
            # 向量化时带上「文件 · 标题」上下文（轻量版 contextual retrieval），
            # 正文仍单独存，用于展示与引用。
            emb_text = rel_path + " | " + c["heading"] + " | " + c["text"] if c["heading"] else rel_path + " | " + c["text"]
            h = sha1(emb_text)
            hs.append(h)
            meta = {"hash": h, "src": src_name, "path": key, "rel": rel_path,
                    "line": c["line"], "heading": c["heading"], "text": c["text"], "emb": emb_text}
            rows.append(meta)
            toks.append(_norm(emb_text))
            if h in emb:
                stats["reused"] += 1
            else:
                need.append(emb_text)
                need_pos.append(len(rows) - 1)
                stats["new"] += 1
        manifest[key] = {"mtime_ns": st.st_mtime_ns, "size": st.st_size, "hashes": hs}

    if need:
        if verbose:
            print("[vec] 需要新算向量：%d 块（复用 %d 块）" % (len(need), stats["reused"]))
        ensure_service(cfg, verbose=verbose)
        vecs = embed_texts(cfg, need, kind="document", verbose=verbose)
        for pos, v in zip(need_pos, vecs):
            emb[rows[pos]["hash"]] = v

    if not rows:
        raise RuntimeError("没有可索引内容，检查 config.json 的 sources")

    dim = int(cfg["embed"]["dim"])
    mat = np.zeros((len(rows), dim), dtype=np.float32)
    for i, m in enumerate(rows):
        v = emb.get(m["hash"])
        if v is None:
            raise RuntimeError("内部错误：%s 缺向量" % m["hash"])
        mat[i] = v
    n = np.linalg.norm(mat, axis=1, keepdims=True)
    mat = mat / np.maximum(n, 1e-9)

    np.save(p["vectors"], mat)
    with open(p["meta"], "w", encoding="utf-8") as f:
        for m in rows:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    with open(p["tokens"], "w", encoding="utf-8") as f:
        json.dump({"ch": toks}, f, ensure_ascii=False)
    with open(p["manifest"], "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    cur = [m["hash"] for m in rows]
    np.savez(p["embcache"], hashes=np.array(cur), vecs=np.stack([emb[h] for h in cur]).astype(np.float32))

    by_src = {}
    seen = set()
    for m in rows:
        b = by_src.setdefault(m["src"], {"files": 0, "chunks": 0})
        b["chunks"] += 1
        key = (m["src"], m["rel"])
        if key not in seen:
            seen.add(key)
            b["files"] += 1
    stats["by_src"] = by_src
    stats["files"] = len(seen)
    stats.update({"chunks": len(rows), "dim": dim, "seconds": round(time.time() - t0, 1),
                  "built_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    with open(os.path.join(p["dir"], "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    return stats


# ---------------------------------------------------------------- search
def _rrf(scores, k=60):
    order = np.argsort(-scores)
    r = np.empty(len(scores), dtype=np.float32)
    r[order] = np.arange(1, len(scores) + 1)
    return 1.0 / (k + r)


def snippet(text, n):
    t = re.sub(r"\s+", " ", text).strip()
    return t if len(t) <= n else t[:n] + "…"


def search(cfg, query, k=None, use_rerank=None, src=None, srcs=None, verbose=False, idx=None):
    cfg_s = cfg["search"]
    k = int(k or cfg_s.get("k", 5))
    if use_rerank is None:
        use_rerank = bool(cfg_s.get("rerank", False))
    if idx is None:
        idx = load_index(cfg)
    meta, vec, ch = idx["meta"], idx["vectors"], idx["ch"]
    allow = set(x for x in ([src] if src else []) + list(srcs or []) if x)
    ok_src = [i for i, m in enumerate(meta) if (not allow or m["src"] in allow)]
    if not ok_src:
        return [], {"ms": 0}

    t0 = time.time()
    ensure_service(cfg, verbose=verbose)

    # 1) 稀疏
    bm = BM25([ch[i] for i in ok_src]).scores(query)
    # 2) 稠密
    qv = embed_texts(cfg, [query], kind="query", verbose=False)[0]
    de = (vec[ok_src] @ qv).astype(np.float32)
    # 3) RRF
    fused = _rrf(bm, cfg_s.get("rrf_k", 60)) + _rrf(de, cfg_s.get("rrf_k", 60))
    order = np.argsort(-fused)[: int(cfg_s.get("candidates", 30))]
    t_retrieve = time.time() - t0

    cands = []
    for r, j in enumerate(order):
        i = ok_src[j]
        m = meta[i]
        cands.append({"i": i, "rrf": float(fused[j]), "bm25": float(bm[j]), "cos": float(de[j]),
                      "src": m["src"], "rel": m["rel"], "line": m["line"],
                      "heading": m["heading"], "text": m["text"]})

    t_rerank, ms_rr = 0.0, 0
    if use_rerank:
        try:
            top = cands[: int(cfg_s.get("rerank_top", 8))]
            docs = [snippet(c["text"], 700) for c in top]
            scores, ms_rr = rerank(cfg, query, docs)
            for c, s in zip(top, scores):
                c["rerank"] = float(s)
            top.sort(key=lambda x: -x["rerank"])
            cands = top + cands[len(top):]
            t_rerank = (time.time() - t0) - t_retrieve
        except Exception as e:
            if verbose:
                print("[vec] 重排不可用，退回 RRF：%s" % e)

    hits = []
    for r, c in enumerate(cands[:k]):
        hits.append({
            "rank": r + 1,
            "score": round(float(c.get("rerank", c["rrf"])), 4),
            "src": c["src"], "path": c["rel"], "file": c["rel"], "line": c["line"],
            "heading": c["heading"], "snippet": snippet(c["text"], int(cfg_s.get("max_snippet", 260))),
            "cos": round(c["cos"], 3), "bm25": round(c["bm25"], 2),
        })
    return hits, {"ms": int((time.time() - t0) * 1000), "ms_retrieve": int(t_retrieve * 1000),
                  "ms_rerank": int(t_rerank * 1000), "ms_rerank_service": ms_rr,
                  "reranked": bool(t_rerank)}


def format_hits(hits, meta=None):
    if not hits:
        return "（没有命中）"
    lines = []
    for h in hits:
        lines.append("%d. %s:%d · %s" % (h["rank"], h["path"], h["line"], h["heading"]))
        lines.append("   " + h["snippet"])
    return "\n".join(lines)
