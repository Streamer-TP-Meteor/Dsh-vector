# -*- coding: utf-8 -*-
"""vector-memory 核心库

职责：
  1. 增量索引：把 memory/*.md、harness-project/**/*.md 切成 chunk，走本地 embedding 服务算向量，
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
# 最近一次真正加载的配置文件（含 --config 传入的）。拉服务/读日志都要用它，
# 否则「自定义配置 + 独立端口」会退化成主配置的 8479。
_LOADED_CFG_PATH = CFG_PATH


def load_config(path=None):
    global _LOADED_CFG_PATH
    p = os.path.abspath(path or CFG_PATH)
    with open(p, encoding="utf-8") as f:
        cfg = json.load(f)
    _LOADED_CFG_PATH = p
    return cfg


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
    cmd = [py, os.path.join(SKILL_DIR, "vecserve.py"), "--config", _LOADED_CFG_PATH]
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


# ---------------------------------------------------------------- code symbols
# 代码文件不做语义切块，只做「符号定位」：把每个顶层符号（函数/类/类型）连同上方的
# 注释和签名后几行正文拼成一块。这样「XX 在哪定义」这类问题靠 BM25 直接命中路径+符号名，
# 不依赖 embedding 的语义理解。实测：只收顶层能把符号量砍掉约 70%。
_CODE_LANG = {
    ".py": "python", ".pyw": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".cs": "csharp", ".gd": "gdscript", ".lua": "lua",
}

_RE_PY_DEF = re.compile(r"^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(", re.M)
_RE_PY_CLASS = re.compile(r"^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*(?:\(|:)", re.M)
_RE_JS_FUNC = re.compile(r"^([ \t]*)(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)[ \t]*[<(]", re.M)
_RE_JS_CLASS = re.compile(r"^([ \t]*)(?:export[ \t]+)?(?:default[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)", re.M)
_RE_JS_ARROW = re.compile(r"^([ \t]*)(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]{0,80})?=[ \t]*(?:async[ \t]*)?(?:\([^)\n]{0,200}\)|[A-Za-z_$][\w$]*)[ \t]*=>", re.M)
_RE_JS_ASSIGN = re.compile(r"^([ \t]*)(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]{0,80})?=[ \t]*(?:async[ \t]+)?function\b", re.M)
_RE_TS_TYPE = re.compile(r"^([ \t]*)(?:export[ \t]+)?(?:declare[ \t]+)?(?:interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)", re.M)
# C#：只收顶层类型（方法有缩进，天然被排除）；Unity 工程大量 .cs，类名定位够用
_RE_CS_TYPE = re.compile(r"^([ \t]*)(?:(?:public|internal|private|protected|static|sealed|abstract|partial|readonly)[ \t]+)*(?:class|struct|interface|enum|record)[ \t]+([A-Za-z_]\w*)", re.M)
# GDScript：Godot 工程，顶层 func / class_name
_RE_GD_FUNC = re.compile(r"^([ \t]*)func[ \t]+([A-Za-z_]\w*)[ \t]*\(", re.M)
_RE_GD_CLASS = re.compile(r"^([ \t]*)class_name[ \t]+([A-Za-z_]\w*)", re.M)
# Lua：顶层 function / local function
_RE_LUA_FUNC = re.compile(r"^([ \t]*)(?:local[ \t]+)?function[ \t]+([A-Za-z_][\w.:]*)", re.M)

_CODE_SPECS = {
    "python": [("def", _RE_PY_DEF), ("class", _RE_PY_CLASS)],
    "javascript": [("function", _RE_JS_FUNC), ("class", _RE_JS_CLASS),
                   ("const", _RE_JS_ARROW), ("const", _RE_JS_ASSIGN)],
    "typescript": [("function", _RE_JS_FUNC), ("class", _RE_JS_CLASS),
                   ("const", _RE_JS_ARROW), ("const", _RE_JS_ASSIGN),
                   ("type", _RE_TS_TYPE)],
    "csharp": [("type", _RE_CS_TYPE)],
    "gdscript": [("func", _RE_GD_FUNC), ("class_name", _RE_GD_CLASS)],
    "lua": [("function", _RE_LUA_FUNC)],
}


def _comment_lines(lines, lang):
    """逐行标记「处于注释中」，用于过滤注释里的假符号（如 `# def old_impl(x):`）。"""
    flags = [False] * len(lines)
    if lang == "python":
        in_doc = False
        for i, line in enumerate(lines):
            st = line.strip()
            if in_doc:
                flags[i] = True
                if st.count('"""') % 2 == 1 or st.count("'''") % 2 == 1:
                    in_doc = False
                continue
            if st.startswith("#"):
                flags[i] = True
                continue
            for q in ('"""', "'''"):
                if st.startswith(q) and st.count(q) % 2 == 1:
                    in_doc = True
                    flags[i] = True
                    break
        return flags
    if lang == "lua":
        for i, line in enumerate(lines):
            if line.strip().startswith("--"):
                flags[i] = True
        return flags
    in_block = False
    for i, line in enumerate(lines):
        st = line.strip()
        if in_block:
            flags[i] = True
            if "*/" in st:
                in_block = False
            continue
        if st.startswith("//") or st.startswith("*") or st.startswith("/**") or st.startswith("/*"):
            flags[i] = True
            if st.startswith("/*") and "*/" not in st:
                in_block = True
            continue
    return flags


def chunk_code(path, cfg, rel=""):
    """把代码文件切成「符号块」：[{text, line, heading}]，只收顶层符号。"""
    suffix = os.path.splitext(path)[1].lower()
    lang = _CODE_LANG.get(suffix)
    if not lang:
        return []
    opts = cfg.get("code") or {}
    cap = opts.get("max_symbols_per_file")
    if cap is None:
        cap = (cfg.get("project_index") or {}).get("max_symbols_per_file", 20)
    max_syms = int(cap or 20)
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    lines = raw.splitlines()
    if not lines:
        return []
    flags = _comment_lines(lines, lang)

    # 收集顶层符号（缩进 0 才算；C# 放宽到 4 空格，因为大量工程把类包在 namespace 里）
    indent_limit = 4 if lang == "csharp" else 0
    found = []
    for kind, rx in _CODE_SPECS.get(lang, []):
        for m in rx.finditer(raw):
            if len(m.group(1).expandtabs(4)) > indent_limit:
                continue
            ln = raw.count("\n", 0, m.start()) + 1
            if ln - 1 < len(flags) and flags[ln - 1]:
                continue
            found.append((ln, kind, m.group(2)))
    found.sort(key=lambda x: x[0])
    picked, seen = [], set()
    for ln, kind, name in found:
        if ln in seen:
            continue
        seen.add(ln)
        picked.append((ln, kind, name))
        if len(picked) >= max_syms:
            break
    if not picked:
        return []

    head_mark = ("#",) if lang == "python" else ("//", "*", "/*", "/**")
    out = []
    for ln, kind, name in picked:
        head = []
        j = ln - 2
        while j >= 0 and len(head) < 6:
            t = lines[j].strip()
            if not t:
                if head:
                    break
                j -= 1
                continue
            if t.startswith(head_mark) or t.startswith("@"):
                # 注释里顺手写的代码示例（如 `# def old_impl(x):`）不是文档，跳过
                if re.search(r"\b(?:def|class|function|func)\b", t):
                    j -= 1
                    continue
                head.insert(0, re.sub(r"^(?://+|#+|\*+|/\*+|\*/)\s?", "", t))
                j -= 1
                continue
            break
        body = [x.rstrip() for x in lines[ln - 1: ln + 4] if x.strip()]
        head_txt = " ".join(head).strip()
        text = " | ".join(x for x in [
            "%s · %s · %s %s" % (rel or os.path.basename(path), lang, kind, name),
            head_txt,
            " / ".join(body),
        ] if x)
        out.append({"text": text[:int(cfg["chunk"].get("max_chars", 1200))],
                    "line": ln, "heading": "%s %s" % (kind, name)})
    return out


_DATE_RE = re.compile(r"(20\d{2})-(\d{2})-(\d{2})")


def _split_long(blocks, cfg):
    """把超长块按句子边界细切（默认关闭）。

    动机：一条上千字的决策整块拿去算 cosine，跟一句短问句的相似度会被稀释；
    切成 ~split_chars 的子块分别算，命中率更高。子块共用原 line，所以引用仍指回整条；
    search() 里再按 (rel, line) 去重，避免 k 条结果全是同一条的碎片。
    """
    c = cfg.get("chunk") or {}
    if not c.get("split_long"):
        return blocks
    limit = int(c.get("split_chars", 700) or 700)
    if limit < 200:
        limit = 200
    out = []
    for b in blocks:
        text = b.get("text") or ""
        if len(text) <= int(limit * 1.5):
            out.append(b)
            continue
        parts = []
        buf = ""
        for piece in re.split(r"(?<=[。！？；!?;])", text):
            if not piece:
                continue
            if buf and len(buf) + len(piece) > limit:
                parts.append(buf)
                buf = piece
            else:
                buf += piece
        if buf:
            parts.append(buf)
        if len(parts) <= 1:
            out.append(b)
            continue
        for n, part in enumerate(parts):
            part = part.strip()
            if len(part) < 20:
                continue
            nb = dict(b)
            nb["text"] = part
            nb["ptext"] = text          # 父块全文：检索用子块、展示用父块
            nb["part"] = n + 1
            nb["of"] = len(parts)
            out.append(nb)
    return out


def _clamp_hard(text, cfg):
    """单块硬上限兜底（审计 PY-05）。

    切分（split_long）默认关着，因为实测切了反而掉点；但「一整条几千字都在一个块里」
    的极端输入仍要防：超硬上限就截断并标注，避免一次 embed 一个几 MB 的块把内存打爆。
    """
    limit = int((cfg.get("chunk") or {}).get("hard_max_chars", 8000) or 0)
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit] + "…（原文过长，已截断 %d 字）" % (len(text) - limit)


def chunk_file(path, cfg, rel):
    """把一个文件切成 chunk 列表：[{text, line, heading}]

    按扩展名分派：.docx / .pdf / 代码文件走各自的解析器，其余（.md/.mdx/.txt/.rst）走原来的按行切块。
    **必须在 open() 之前分派**：docx/pdf 是二进制，用 errors="replace" 打开不会报错，只会静静产出乱码块。
    """
    suffix = os.path.splitext(path)[1].lower()
    if suffix == ".docx":
        return chunk_docx(path, cfg)
    if suffix == ".pdf":
        return chunk_pdf(path, cfg)
    if suffix in _CODE_LANG:
        return chunk_code(path, cfg, rel)
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
        return _split_long(out, cfg)

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
    return _split_long(out, cfg)


# ---------------------------------------------------------------- docx
def _docx_paragraphs(path):
    """从 .docx 里按文档顺序抽段落文本。零依赖：docx 就是个 zip + XML。

    返回 [(段落文本, 段落序号)]。表格单元格里的文字也在 document.xml 里，按顺序收进来。
    """
    import zipfile
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(path) as z:
        try:
            data = z.read("word/document.xml")
        except KeyError:
            return []
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    root = ET.fromstring(data)
    out = []
    for idx, para in enumerate(root.iter(ns + "p")):
        parts = [node.text or "" for node in para.iter(ns + "t")]
        text = "".join(parts).strip()
        if text:
            out.append((text, idx + 1))
    return out


def chunk_docx(path, cfg):
    """把 .docx 切成 chunk：多个短段落合并成一块，长段落按 max_chars 硬切。"""
    min_chars = int(cfg["chunk"].get("min_chars", 40))
    max_chars = int(cfg["chunk"].get("max_chars", 1200))
    target = max(min_chars * 4, min(max_chars, 900))
    paras = _docx_paragraphs(path)
    if not paras:
        return []

    # 标题推断：短、无句号、不是以标点结尾的段落当标题（最多 60 字）
    heading = ""
    out = []
    buf = []
    start = 1
    first = paras[0][0]

    def flush():
        if not buf:
            return
        text = " ".join(buf).strip()
        if len(text) >= min_chars:
            out.append({"text": text, "line": start, "heading": heading})

    for pos, (text, line_no) in enumerate(paras):
        # 第一段短、不以句读结尾 → 当作整篇的标题（docx 里没有样式的可靠标题信息）
        if pos == 0 and len(text) <= 40 and not re.search(r"[。；;，,]$", text):
            heading = text[:60]
        if not buf:
            start = line_no
        buf.append(text)
        if len(" ".join(buf)) >= target:
            flush()
            buf = []
    flush()

    # 兜底：整篇只有一段超长文本时按 max_chars 硬切
    if not out:
        joined = " ".join(t for t, _ in paras)
        for i in range(0, len(joined), max_chars):
            piece = joined[i:i + max_chars].strip()
            if len(piece) >= min_chars:
                out.append({"text": piece, "line": 1, "heading": ""})
    return out


def _pdf_available():
    try:
        import pypdf  # noqa: F401
        return True
    except Exception:
        return False


def chunk_pdf(path, cfg):
    """把 .pdf 切成 chunk。需要 pypdf；没装就返回空（调用方会跳过并计数）。

    两个实测要点：
    - 中文论文/电子书常带「空密码加密」（只限制编辑不限制阅读），不解密 pypdf 会抛
      DependencyError: cryptography>=3.1 is required for AES algorithm；空密码 decrypt 即可。
    - 扫描件没有文本层，extract_text 返回空白，这类文件会产出 0 块 —— 属预期，不报错。
    """
    try:
        from pypdf import PdfReader
    except Exception:
        return []
    min_chars = int(cfg["chunk"].get("min_chars", 40))
    max_chars = int(cfg["chunk"].get("max_chars", 1200))
    try:
        max_pages = int(cfg["chunk"].get("max_pdf_pages", 400))
    except Exception:
        max_pages = 400
    try:
        reader = PdfReader(path)
    except Exception:
        return []
    try:
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception:
                return []
    except Exception:
        pass
    out = []
    for page_no, page in enumerate(reader.pages[:max_pages], start=1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            continue
        if not text:
            continue
        # 每页再按 max_chars 切，避免长页变成一个巨块
        for i in range(0, len(text), max_chars):
            piece = re.sub(r"\s+", " ", text[i:i + max_chars]).strip()
            if len(piece) >= min_chars:
                out.append({"text": piece, "line": page_no, "heading": f"第 {page_no} 页"})
    return out


# 索引时永远跳过的噪音目录（项目可能在任意盘符，仓库里这类目录最容易把索引撑爆）
_DEFAULT_EXCLUDE_DIRS = [
    "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
    "venv", ".venv", "env", "__pycache__", ".idea", ".vscode", ".next", ".nuxt",
    "vendor", "coverage", ".pytest_cache", ".mypy_cache", "site-packages",
    ".cache", "bin", "obj", "deps",
    "addons", "3rd_party", "third_party", "external",
]


def all_sources(cfg):
    """全局 sources（memory / harness-project）+ 动态注册的项目 sources。

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
    截断策略：候选先排序（浅目录优先、文档优先于代码），再取前 max_files 个。
    否则大项目的 addons/ 会先把名额占满，真正的文档与业务代码反而进不来。
    """
    seen = set()
    sources = all_sources(cfg)
    roots = [os.path.abspath(x["root"]) for x in sources]
    names = {os.path.abspath(x["root"]): x["name"] for x in sources}
    accept = dict((os.path.abspath(x["root"]),
                   tuple(e.lower() for e in (x.get("extensions") or [".md"])))
                  for x in sources)
    doc_exts = (".md", ".mdx", ".txt", ".rst", ".docx", ".pdf")
    for src in sources:
        root = os.path.abspath(src["root"])
        exts = accept[root]
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
        try:
            max_pdf_kb = int(src.get("max_pdf_kb") or (cfg.get("project_index") or {}).get("max_pdf_kb", 8192))
        except Exception:
            max_pdf_kb = 8192
        cand = []
        for pat in src.get("globs") or ["**/*.md"]:
            for p in glob.glob(os.path.join(root, pat), recursive=True):
                if not os.path.isfile(p):
                    continue
                low = p.lower()
                if not low.endswith(exts):
                    continue
                try:
                    rel = os.path.relpath(p, root).replace("\\", "/")
                except Exception:
                    continue
                if set(x.lower() for x in rel.split("/")[:-1]) & exclude:
                    continue
                try:
                    size = os.path.getsize(p)
                except OSError:
                    continue
                if size > max_kb * 1024:
                    # PDF 天然比文本大：65 页中文论文就 4~8MB，用同一 512KB 上限会把它们全部排除。
                    if not (low.endswith(".pdf") and size <= max_pdf_kb * 1024):
                        continue
                ap = os.path.abspath(p)
                if ap in seen:
                    continue
                # 嵌套源归属：最长前缀、且该根接受这种扩展名，才算它
                owner = None
                owner_len = -1
                alow = ap.lower()
                for other in roots:
                    olow = other.lower()
                    if not (alow == olow or alow.startswith(olow + os.sep)):
                        continue
                    if not alow.endswith(accept.get(other, (".md",))):
                        continue
                    if len(other) > owner_len:
                        owner_len = len(other)
                        owner = names[other]
                if owner is not None and owner != src["name"]:
                    continue
                cand.append((rel.count("/"), 0 if low.endswith(doc_exts) else 1, rel.lower(), ap, p))
        cand.sort()
        n = 0
        for _depth, _kind, _rel, ap, p in cand:
            if n >= max_files:
                break
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


# ---- 原子写 + 单写者锁 -------------------------------------------------------
# 审计 PY-01：以前五连写（vectors/meta/tokens/manifest/embcache）直接写最终路径，
# 而宿主侧 cancelJob 会发 SIGTERM，进程正好死在写盘中间 → 索引文件半截、下次启动读崩。
# 现在一律「写临时文件 → fsync → os.replace」：要么是旧索引，要么是新索引，不会有半截。
def _fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _tmp_path(path):
    return "%s.tmp-%d" % (path, os.getpid())


def atomic_write_text(path, text):
    tmp = _tmp_path(path)
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _fsync_dir(os.path.dirname(path) or ".")


def atomic_write_bytes(path, write_fn):
    """write_fn(fileobj) 负责把内容写进临时文件，写好后再原子替换。"""
    tmp = _tmp_path(path)
    try:
        with open(tmp, "wb") as f:
            write_fn(f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    _fsync_dir(os.path.dirname(path) or ".")


def text_writer(text):
    """给 atomic_write_group 用：把一段文本包成「往二进制文件里写」的函数。"""
    payload = text.encode("utf-8")
    return lambda f: f.write(payload)


def atomic_write_group(items):
    """items: [(path, write_fn)]。

    先把所有临时文件写完并 fsync，最后连续 os.replace。索引是 5 个文件一组，
    逐个「写完就换」会留下几毫秒的「新旧混搭」窗口；集中替换把这个窗口压到微秒级。
    """
    tmps = []
    try:
        for path, write_fn in items:
            tmp = _tmp_path(path)
            with open(tmp, "wb") as f:
                write_fn(f)
                f.flush()
                os.fsync(f.fileno())
            tmps.append((tmp, path))
        for tmp, path in tmps:
            os.replace(tmp, path)
    finally:
        for tmp, _ in tmps:
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
    for path, _ in items:
        _fsync_dir(os.path.dirname(path) or ".")


class IndexBusy(RuntimeError):
    pass


class index_lock(object):
    """进程级单写者锁：两个索引进程同时写同一份索引会互相覆盖（审计 PY-01/PY-04）。"""

    def __init__(self, p, stale_sec=1800):
        self.path = os.path.join(p["dir"], "index.lock")
        self.stale_sec = stale_sec
        self.held = False

    def __enter__(self):
        import errno

        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except OSError as exc:
            if exc.errno != errno.EEXIST:
                raise
            try:
                age = time.time() - os.path.getmtime(self.path)
            except OSError:
                age = 0.0
            if age < self.stale_sec:
                raise IndexBusy("已有索引进程在写（锁 %s，%.0fs 前创建）；等它结束或删掉这个锁文件" % (self.path, age))
            try:
                os.unlink(self.path)
            except OSError:
                pass
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, ("%d %s\n" % (os.getpid(), time.strftime("%Y-%m-%d %H:%M:%S"))).encode("utf-8"))
        os.close(fd)
        self.held = True
        return self

    def __exit__(self, *exc):
        if self.held:
            try:
                os.unlink(self.path)
            except OSError:
                pass
            self.held = False
        return False


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


# 查询里的"标识符"（符号名、类名、函数名）。代码块里 blocks 带 `路径 · 语言 · kind name`，
# 所以「XX 在哪定义的」这类问题靠字面命中比纯语义稳。实测（10 道代码题）基线 R@1 只有 10%，
# 加这个加成后大幅提升——见 evals/probe_code.py。
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_IDENT_STOP = {
    "class", "func", "function", "def", "const", "type", "interface", "enum", "struct",
    "var", "let", "new", "public", "private", "static", "async", "await", "return",
    "the", "and", "for", "with", "code", "file", "files", "line", "lines", "where",
    "what", "which", "how", "does", "did", "this", "that", "from", "into", "dsh",
    "python", "javascript", "typescript", "lua", "csharp", "gdscript", "json", "html",
}


def _query_idents(query):
    """抽出查询里可能是符号名的词（小写、去停用词、去纯数字）。"""
    out = []
    for tok in _IDENT_RE.findall(query or ""):
        low = tok.lower()
        if low in _IDENT_STOP or low.isdigit():
            continue
        if low not in out:
            out.append(low)
    return out[:6]


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
        # np.load 返回的是惰性 NpzFile，必须显式关闭：否则本进程一直持有这个文件句柄，
        # 后面 os.replace 覆盖它就会在 Windows 上 PermissionError（现场实测）。
        with np.load(p["embcache"], allow_pickle=False) as z:
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

    label_of = dict((src.get("name") or _src_label(src), _src_label(src))
                    for src in all_sources(cfg))

    def rel(p_, owner=None):
        """相对路径。owner 传入时用它（与 iter_source_files 同口径），
        否则退回最长前缀——两者口径必须一致，否则子源标签会覆盖父源文件。"""
        ap = os.path.abspath(p_)
        src = None
        if owner and owner in label_of:
            for cand in all_sources(cfg):
                if (cand.get("name") or _src_label(cand)) == owner:
                    src = cand
                    break
        if src is None:
            best = None
            for cand in all_sources(cfg):
                r = os.path.abspath(cand["root"])
                if (ap == r or ap.startswith(r + os.sep)) and (best is None or len(r) > len(best[0])):
                    best = (r, cand)
            if best:
                src = best[1]
        if src is not None:
            r = os.path.abspath(src["root"])
            return _src_label(src) + "/" + os.path.relpath(ap, r).replace(os.sep, "/")
        return os.path.basename(p_)

    files = sorted(iter_source_files(cfg))
    if only_set:
        files = [(name, path) for name, path in files if name in only_set]
    for src_name, path in files:
        st = os.stat(path)
        key = os.path.abspath(path)
        prev = old_manifest.get(key)
        rel_now = rel(path, src_name)
        stats["files"] += 1
        by = stats["by_src"].setdefault(src_name, {"files": 0, "chunks": 0})
        by["files"] += 1
        # 归属或相对路径变了也要重切：否则 meta 里的 rel/引用前缀会留在旧源名下
        same_owner = (prev or {}).get("src") == src_name and (prev or {}).get("rel") == rel_now
        if prev and same_owner and not force and prev.get("mtime_ns") == st.st_mtime_ns and prev.get("size") == st.st_size:
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
            chs = chunk_file(path, cfg, rel_now)
        except Exception as e:
            if verbose:
                print("[vec] 跳过 %s：%s" % (path, e))
            continue
        # 兜底硬上限：split_long 关着时也要防止单块过大（审计 PY-05）。
        for c in chs:
            c["text"] = _clamp_hard(c.get("text") or "", cfg)
        hs = []
        rel_path = rel_now
        by["chunks"] += len(chs)
        for c in chs:
            # 向量化时带上「文件 · 标题」上下文（轻量版 contextual retrieval），
            # 正文仍单独存，用于展示与引用。
            body = c["text"]
            # 代码块的正文本身已以 rel 开头，别再把路径前置一遍（会把语义稀释成路径匹配）
            if body.startswith(rel_path):
                emb_text = (c["heading"] + " | " + body) if c["heading"] else body
            else:
                emb_text = (rel_path + " | " + c["heading"] + " | " + body) if c["heading"] else (rel_path + " | " + body)
            h = sha1(emb_text)
            hs.append(h)
            meta = {"hash": h, "src": src_name, "path": key, "rel": rel_path,
                    "line": c["line"], "heading": c["heading"], "text": c["text"], "emb": emb_text}
            if c.get("ptext"):
                meta["ptext"] = c["ptext"]
            rows.append(meta)
            toks.append(_norm(emb_text))
            if h in emb:
                stats["reused"] += 1
            else:
                need.append(emb_text)
                need_pos.append(len(rows) - 1)
                stats["new"] += 1
        manifest[key] = {"mtime_ns": st.st_mtime_ns, "size": st.st_size,
                         "hashes": hs, "src": src_name, "rel": rel_now}

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

    cur = [m["hash"] for m in rows]
    stack = np.stack([emb[h] for h in cur]).astype(np.float32)

    def _write_npz(f):
        np.savez(f, hashes=np.array(cur), vecs=stack)

    # 五连写集中原子替换：要么全是旧索引，要么全是新索引，不会留下半截（审计 PY-01）。
    atomic_write_group([
        (p["meta"], text_writer("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in rows))),
        (p["tokens"], text_writer(json.dumps({"ch": toks}, ensure_ascii=False))),
        (p["manifest"], text_writer(json.dumps(manifest, ensure_ascii=False))),
        (p["embcache"], _write_npz),
        (p["vectors"], lambda f: np.save(f, mat)),
    ])

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
    atomic_write_text(os.path.join(p["dir"], "stats.json"), json.dumps(stats, ensure_ascii=False, indent=1))
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
    # 3.5) 标识符加成：查询里出现的符号名如果字面命中块内容（含 heading），抬一点分。
    #      量纲对齐 RRF（rank-1 的一路 ≈ 1/(rrf_k+1)），ident_boost=1.0 等于"命中一个符号 ≈ 某一路排第一"。
    ident_boost = float(cfg_s.get("ident_boost", 1.5) or 0)
    if ident_boost > 0:
        idents = _query_idents(query)
        if idents:
            unit = 1.0 / (float(cfg_s.get("rrf_k", 60)) + 1.0)
            add = np.zeros(len(ok_src), dtype=np.float32)
            for n, i in enumerate(ok_src):
                m = meta[i]
                blob = ((m.get("heading") or "") + " " + m.get("text", "")).lower()
                hits_n = 0
                for tok in idents:
                    if tok in blob:
                        hits_n += 1
                if hits_n:
                    add[n] = ident_boost * unit * min(hits_n, 3)
            fused = fused + add
    # dedupe by (rel, line)：长块细切后同一可能命中多块，只保留得分最高的一块，
    # 否则 k 条结果会全是同一条目的碎片。
    full = np.argsort(-fused)
    seen_key = set()
    picked = []
    want = int(cfg_s.get("candidates", 30))
    for j in full:
        m = meta[ok_src[j]]
        key = (m["rel"], m["line"])
        if key in seen_key:
            continue
        seen_key.add(key)
        picked.append(j)
        if len(picked) >= want:
            break
    order = np.array(picked, dtype=np.int64)
    t_retrieve = time.time() - t0

    cands = []
    for r, j in enumerate(order):
        i = ok_src[j]
        m = meta[i]
        cands.append({"i": i, "rrf": float(fused[j]), "bm25": float(bm[j]), "cos": float(de[j]),
                      "src": m["src"], "rel": m["rel"], "line": m["line"],
                      "heading": m["heading"], "text": m.get("ptext") or m["text"]})

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

    # 每条命中带一个日期：优先用正文里的日期（decisions.md 每条都以 - YYYY-MM-DD 开头），
    # 否则用文件 mtime。模型看到「这条写于 3 个月前」才会去想它是不是已经过时了。
    mtimes = {}
    try:
        man = _load_json(paths(cfg)["manifest"], {})
        for entry in (man or {}).values():
            rel = entry.get("rel")
            if rel and entry.get("mtime_ns"):
                mtimes[rel] = int(entry["mtime_ns"])
    except Exception:
        mtimes = {}

    def _date_of(rel, text):
        for mt in _DATE_RE.finditer(text or ""):
            year, month, day = int(mt.group(1)), int(mt.group(2)), int(mt.group(3))
            if 2000 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31:
                return "%04d-%02d-%02d" % (year, month, day)
        ns = mtimes.get(rel)
        if ns:
            try:
                return time.strftime("%Y-%m-%d", time.localtime(ns / 1e9))
            except Exception:
                return ""
        return ""

    hits = []
    for r, c in enumerate(cands[:k]):
        hits.append({
            "rank": r + 1,
            "score": round(float(c.get("rerank", c["rrf"])), 4),
            "src": c["src"], "path": c["rel"], "file": c["rel"], "line": c["line"],
            "heading": c["heading"], "snippet": snippet(c["text"], int(cfg_s.get("max_snippet", 260))),
            "cos": round(c["cos"], 3), "bm25": round(c["bm25"], 2),
            "date": _date_of(c["rel"], c["text"]),
        })
    return hits, {"ms": int((time.time() - t0) * 1000), "ms_retrieve": int(t_retrieve * 1000),
                  "ms_rerank": int(t_rerank * 1000), "ms_rerank_service": ms_rr,
                  "reranked": bool(t_rerank)}


def format_hits(hits, meta=None):
    if not hits:
        return "（没有命中）"
    lines = []
    for h in hits:
        stamp = ("（%s）" % h["date"]) if h.get("date") else ""
        lines.append("%d. %s:%d · %s%s" % (h["rank"], h["path"], h["line"], h["heading"], stamp))
        lines.append("   " + h["snippet"])
    return "\n".join(lines)


# ---------------------------------------------------------------- outline
# 「归纳层」：不调用任何模型，只从索引结构派生主题地图
#   - markdown 用 # 标题（chunker 已写进 heading）
#   - decisions.md 这类要点式文件，取块文本开头的 **粗体标题**
#   - 代码块取 heading（kind + 符号名）
# 每个主题都带一个可核对的 path:line，保证「归纳」也能回到原文。
_BOLD_RE = re.compile(r"\*\*(.{2,48}?)\*\*")
_TOPIC_SKIP = {"更新", "近期增量", "目录", "总结", "概述", "简介", "说明", "参考", "备注"}


def _clean_topic(raw):
    """把标题收拾成短主题：去编号前缀、去破折号/括号后的解释、压空白、限长。"""
    t = (raw or "").strip()
    t = re.sub(r"^#+\s*", "", t)
    t = re.sub(r"^(?:[0-9]+(?:\.[0-9]+)*\.?\s*|[A-Za-z][\.、)]\s*|P[0-9]\s*[—\-–]+\s*)", "", t)
    t = re.split(r"[—–（(，,;；|]", t)[0].strip()
    t = re.sub(r"\s+", " ", t)
    return t[:24].strip()


def _topic_of(meta_row):
    head = (meta_row.get("heading") or "").strip()
    if head:
        topic = _clean_topic(head)
        if len(topic) >= 2:
            return topic
    text = meta_row.get("text") or ""
    match = _BOLD_RE.search(text[:200])
    if match:
        topic = _clean_topic(match.group(1))
        if len(topic) >= 2:
            return topic
    flat = re.sub(r"\s+", " ", text).strip()
    return _clean_topic(flat[:40]) if flat else ""


def outline(cfg, src=None, per_src=6, min_count=1, idx=None):
    """返回 {sources:[{name,label,files,chunks,topics:[{topic,count,at}]}], ms, chunks}"""
    import time as _time
    t0 = _time.time()
    if idx is None:
        idx = load_index(cfg)
    meta = idx["meta"]
    stats = _load_json(os.path.join(paths(cfg)["dir"], "stats.json"), {})
    by_src = stats.get("by_src", {}) if isinstance(stats, dict) else {}
    labels = {s["name"]: _src_label(s) for s in all_sources(cfg)}

    groups = {}
    clusters = {}
    for row in meta:
        name = row.get("src")
        if not name:
            continue
        if src and name != src:
            continue
        rel = row.get("rel") or ""
        parts = rel.split("/")
        key = parts[-1] if len(parts) <= 2 else parts[1] + "/"
        bucket_c = clusters.setdefault(name, {})
        bucket_c[key] = bucket_c.get(key, 0) + 1
        topic = _topic_of(row)
        if not topic:
            continue
        bucket = groups.setdefault(name, {})
        item = bucket.get(topic)
        if item is None:
            item = {"count": 0, "at": "%s:%d" % (row.get("rel") or "", int(row.get("line") or 0))}
            bucket[topic] = item
        item["count"] += 1

    out = []
    fixed_names = {s["name"] for s in (cfg.get("sources") or [])}
    for name, bucket in groups.items():
        topics = [
            {"topic": topic, "count": item["count"], "at": item["at"]}
            for topic, item in bucket.items()
            if topic not in _TOPIC_SKIP and item["count"] >= min_count
        ]
        topics.sort(key=lambda x: (-x["count"], x["topic"]))
        meta_src = by_src.get(name, {})
        cluster_rows = sorted(clusters.get(name, {}).items(), key=lambda kv: -kv[1])
        out.append({
            "name": name,
            "label": labels.get(name, name),
            "kind": "fixed" if name in fixed_names else "project",
            "files": int(meta_src.get("files") or 0),
            "chunks": int(meta_src.get("chunks") or 0) or sum(t["count"] for t in topics),
            "topics": topics[: int(per_src)],
            "topic_total": len(topics),
            "clusters": [{"path": k, "chunks": v} for k, v in cluster_rows[: int(per_src)]],
        })
    # 手动登记的源（memory 等）永远排在自动登记的项目源前面：
    # 它们才是用户真正维护的知识，项目目录只是"当前正在干活的地方"，块数多但价值密度低。
    out.sort(key=lambda x: (0 if x.get("kind") == "fixed" else 1, -x["chunks"]))
    return {"sources": out, "chunks": len(meta), "ms": int((_time.time() - t0) * 1000)}
