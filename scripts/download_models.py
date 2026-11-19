# -*- coding: utf-8 -*-
"""Pre-download the embedding / reranker models into a local directory.

Used by scripts/setup.ps1, but it also works on its own:

    python scripts/download_models.py --embed Qwen/Qwen3-Embedding-0.6B \
        --dest D:\\vector-memory-models --mirror https://hf-mirror.com

Downloading at install time is optional: if the models are absent, the engine
falls back to the Hugging Face repo id and downloads them on first use (with the
same mirror if HF_ENDPOINT is set). Doing it here just moves that wait out of
the first search.
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", default="Qwen/Qwen3-Embedding-0.6B")
    ap.add_argument("--rerank", default="", help="可留空：重排模型是可选组件")
    ap.add_argument("--dest", required=True, help="模型落地目录")
    ap.add_argument("--mirror", default="", help="例如 https://hf-mirror.com")
    ap.add_argument(
        "--revision",
        default=os.environ.get("HF_REVISION", ""),
        help="钉住仓库的 commit/tag（强烈建议；空=跟随 main，上游被改写时会静默换模型）",
    )
    args = ap.parse_args()

    if args.mirror:
        os.environ["HF_ENDPOINT"] = args.mirror
        print("[models] HF_ENDPOINT =", args.mirror)

    from huggingface_hub import snapshot_download

    targets = [("embed", args.embed)]
    if args.rerank:
        targets.append(("rerank", args.rerank))

    for kind, repo in targets:
        out = os.path.join(args.dest, kind)
        os.makedirs(out, exist_ok=True)
        print("[models] downloading %s -> %s" % (repo, out))
        # 供应链收紧（审计 SEC-03）：
        #  - 权重仓库只需要「权重 + 分词器配置」，**绝不下载 .py**（历史上有恶意
        #    trust_remote_code 仓库用 *.py 在加载时执行任意代码）；
        #  - 用 --revision 钉住一个 commit/tag，避免上游被改写后静默换模型。
        snapshot_download(
            repo_id=repo,
            local_dir=out,
            revision=(args.revision or None),
            allow_patterns=[
                "*.json",
                "*.safetensors",
                "*.txt",
                "*.model",
                "*.md",
                "*.vocab",
                "*.merges",
                "*.tiktoken",
            ],
        )
        size = sum(
            os.path.getsize(os.path.join(root, name))
            for root, _dirs, names in os.walk(out)
            for name in names
        )
        print("[models] %s done: %.1f MB" % (kind, size / 1048576.0))

    print("[models] all done. 把这两个路径填进 config.json 的 models.embed / models.rerank 即可。")


if __name__ == "__main__":
    sys.exit(main())
