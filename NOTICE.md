# Third-party notices

This plugin **bundles no third-party code**. At runtime it talks to the following
components, which you install and license separately:

| Component | License | Notes |
|---|---|---|
| Qwen3-Embedding-0.6B | Apache-2.0 (Alibaba Qwen) | downloaded from Hugging Face on first use |
| Qwen3-Reranker-0.6B | Apache-2.0 (Alibaba Qwen) | optional, off by default |
| PyTorch | BSD-3-Clause | CPU wheel |
| sentence-transformers, transformers, numpy, huggingface_hub | Apache-2.0 / BSD-3-Clause as declared by their authors | installed into the plugin's private `.venv` |

The plugin's own code is MIT — see [LICENSE](LICENSE).
