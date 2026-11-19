# -*- coding: utf-8 -*-
"""vector-memory 命令行

  python vsearch.py index [--force] [--only 源]  增量建/更新索引
  python vsearch.py search "查询" [-k 5] [--no-rerank] [--src memory] [--json]
  python vsearch.py status               索引 + 服务状态
  python vsearch.py serve --start|--stop  手动启停本地服务

用任何带 numpy 的 python 都能跑（默认不需要 torch；模型推理在 vecserve.py 的 python 里）。
"""
import os, sys, json, argparse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vindex


def cmd_index(cfg, a):
    only = [x.strip() for x in (getattr(a, "only", None) or "").split(",") if x.strip()] or None
    st = None
    # 单写者锁：两个索引进程同时写同一份索引会互相覆盖；中途被 SIGTERM 也只会留下临时文件，
    # 最终文件仍是旧的完整索引（审计 PY-01）。
    with vindex.index_lock(vindex.paths(cfg)):
        st = vindex.build_index(cfg, force=a.force, verbose=not a.quiet, only=only)
    if a.json:
        print(json.dumps(st, ensure_ascii=False))
    else:
        print("索引完成：%d 个文件（变更 %d）、%d 块（新增 %d / 复用 %d）、%d 维、%.1fs"
              % (st["files"], st["files_changed"], st["chunks"], st["new"], st["reused"], st["dim"], st["seconds"]))


def cmd_search(cfg, a):
    use_rerank = True if a.rerank else (False if a.no_rerank else None)
    srcs = [x.strip() for x in (a.srcs or "").split(",") if x.strip()] or None
    hits, info = vindex.search(cfg, a.query, k=a.k, use_rerank=use_rerank, src=a.src,
                               srcs=srcs, verbose=a.verbose)
    if a.json:
        print(json.dumps({"hits": hits, "info": info}, ensure_ascii=False, indent=1))
        return
    print(vindex.format_hits(hits))
    print("\n[%dms · %s · %d 块索引]" % (info["ms"], "已重排" if info.get("reranked") else "RRF 融合", _n_chunks(cfg)))


def _n_chunks(cfg):
    p = vindex.paths(cfg)
    try:
        with open(p["meta"], encoding="utf-8") as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def cmd_outline(cfg, a):
    res = vindex.outline(cfg, src=a.src, per_src=a.per_src)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
        return
    for s in res["sources"]:
        print("%s  %d 文件 / %d 块  (%d 个主题)" % (s["label"], s["files"], s["chunks"], s["topic_total"]))
        if s.get("clusters"):
            print("  目录：" + "、".join("%s(%d)" % (c["path"], c["chunks"]) for c in s["clusters"]))
        if s["topics"]:
            print("  主题：" + "、".join("%s(%d)" % (t["topic"], t["count"]) for t in s["topics"]))
    print("（共 %d 块，%dms）" % (res["chunks"], res["ms"]))


def cmd_status(cfg, a):
    p = vindex.paths(cfg)
    st = {}
    try:
        with open(os.path.join(p["dir"], "stats.json"), encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        pass
    h = vindex.health(cfg)
    out = {
        "data_dir": cfg["data_dir"],
        "index": st or "（还没建索引）",
        "service": h or "（未运行，首次检索会自动拉起）",
        "config": vindex.CFG_PATH,
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))


def cmd_serve(cfg, a):
    if a.stop:
        try:
            print(json.dumps(vindex._post(vindex.base_url(cfg) + "/shutdown", {}), ensure_ascii=False))
        except Exception as e:
            print("服务未在运行（%s）" % e)
        return
    h = vindex.ensure_service(cfg, verbose=True)
    print(json.dumps(h, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(prog="vsearch")
    ap.add_argument("--config", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("index", help="增量建索引")
    p.add_argument("--force", action="store_true", help="忽略缓存全量重建")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--only", default="", help="只更新指定源（项目标签或源名，逗号分隔）")
    p.set_defaults(fn=cmd_index)

    p = sub.add_parser("search", help="混合检索")
    p.add_argument("query")
    p.add_argument("-k", type=int, default=None)
    p.add_argument("--rerank", action="store_true", help="启用 Qwen3-Reranker 重排（CPU 上约 +8–20s/次）")
    p.add_argument("--no-rerank", action="store_true", help="强制不重排（默认即不重排）")
    p.add_argument("--src", default=None, help="只搜某一个源（memory / harness-project / 项目名）")
    p.add_argument("--srcs", default=None, help="逗号分隔的多个源，例如 memory,proj-e-demo")
    p.add_argument("--json", action="store_true")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("outline", help="主题地图（结构派生，不调模型）")
    p.add_argument("--src", default=None, help="只看某个源（源名或标签）")
    p.add_argument("--per-src", type=int, default=6, help="每个源列几个主题/目录，默认 6")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_outline)

    p = sub.add_parser("status", help="状态")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("serve", help="启停本地服务")
    p.add_argument("--start", action="store_true")
    p.add_argument("--stop", action="store_true")
    p.set_defaults(fn=cmd_serve)

    a = ap.parse_args()
    cfg = vindex.load_config(a.config)
    a.fn(cfg, a)


if __name__ == "__main__":
    main()
