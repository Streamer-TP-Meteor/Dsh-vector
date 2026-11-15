# dsh-vector-memory

[![ci](https://github.com/Streamer-TP-Meteor/Dsh-vector/actions/workflows/ci.yml/badge.svg)](https://github.com/Streamer-TP-Meteor/Dsh-vector/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 的**本地语义记忆层**：把你的笔记、决策记录、项目文档变成可被任意模型直接检索的知识库。

不联网、不上传、不要 API key。检索由本机的 `Qwen3-Embedding-0.6B` 完成，全部计算在你自己的 CPU 上。

```
你的文档 ──▶ 切块 ──▶ 本地向量模型 ──▶ 索引（磁盘）
                                        │
用户提问 ──▶ 向量检索 + BM25 混合 ──▶ 相关片段 ──▶ 模型（自动/按需）
```

## 它解决什么

长对话里，模型的「记忆」只有上下文窗口那么大。窗口一满，早期的决定、踩过的坑、约定好的规范就丢了，模型开始凭印象编。

这个插件做三件事：

1. **把长期知识放在窗口外**：你的 `memory/*.md`、项目文档被切成块，用向量存起来，随时可查。
2. **每轮自动带 3 条**：会话第一句话之后，最相关的那几条会以「【向量检索 · 本机记忆】」的块随请求发出——任何模型、任何子代理都吃得到，不需要它主动调工具。
3. **需要时深挖**：模型可以调 `vmemory_search` 精确检索（约 0.2 秒），拿到带 `文件:行号` 的出处，再回原文核对。

## 功能

| 功能 | 说明 |
|---|---|
| 语义检索 | Qwen3-Embedding-0.6B，1024 维，32K 上下文，中英日等 100+ 语言 |
| 混合排序 | BM25（字 + 双字）与向量结果用 RRF 融合，关键词与语义各补一半 |
| 可选重排 | Qwen3-Reranker-0.6B 精排，默认关闭（CPU 上一次约 6–15 秒） |
| 增量索引 | 按文件内容哈希缓存向量，只算变动的文件；改名挪目录不重算 |
| 按源重建 | 只重建某一个项目/目录，秒级完成（全量重建可能几分钟） |
| 自动召回 | 会话首轮自动注入 top-3，可设条数、相似度阈值、字数上限、超时 |
| 跨盘项目 | 会话落在哪个目录就自动登记为项目源，D 盘 E 盘 U 盘都一样 |
| 设置页 | 状态 / 检索测试 / 参数 / 项目 / 维护 五个页签，全部可视化 |
| 离线 | 装好之后不需要网络；服务只监听 `127.0.0.1` |
| 随 DSH 退出 | 看门狗盯住宿主进程，DSH 关掉约 3 秒后服务自动退出 |

## 安装

Windows 上一条命令（不需要管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -DataDir D:\vector-memory-data
```

细节、参数、验收与排错见 **[INSTALL.md](INSTALL.md)**；想让 AI 代劳，给它看 **[AGENTS-install.md](AGENTS-install.md)**。

## 怎么用

装好、重启 DSH 之后：

- **什么都不用做**——新会话的第一轮就会带上检索块。想确认：设置 → 向量记忆 → 状态 → 「已注入」计数会增长。
- **让它查以前的决定**：直接问「上次那个方案是怎么定的」，模型会先 `vmemory_search` 再答，并给出 `文件:行号`。
- **想让它看别处的文档**：设置 → 向量记忆 → 项目 → 输入目录 → 添加目录（会自动索引，且召回只在「记忆 + 当前项目」范围内）。
- **调参**：参数页可以改召回条数、相似度阈值、超时、索引的文件类型/大小上限、服务线程数等，改完即时生效（端口/线程改了需要重启服务）。

## 三个工具

| 工具 | 作用 |
|---|---|
| `vmemory_search(query, k?, src?, rerank?)` | 语义 + 关键词混合检索，返回带出处的片段 |
| `vmemory_index(force?)` | 增量索引（`force` 为全量重建） |
| `vmemory_status()` | 索引与服务状态 |

## 配置文件

`engine/config.json`（`setup.ps1` 生成；完整示例见 [`config.example.json`](config.example.json)）。

最常改的几个键：

| 键 | 含义 |
|---|---|
| `data_dir` | 索引与日志放哪 |
| `python` | 用哪个解释器跑引擎（默认插件目录下的 `.venv`） |
| `models.embed` / `models.rerank` | 模型目录，或 Hugging Face repo id（如 `Qwen/Qwen3-Embedding-0.6B`） |
| `sources` | 常驻笔记目录（`root` + `globs`/`extensions`） |
| `project_index` | 跨盘项目自动登记与索引的开关、文件类型、上限 |
| `recall` | 自动召回的开关与参数 |
| `service.allow_remote` | 默认 `false`；改成 `true` 才允许监听非回环地址（危险） |

## 数据与磁盘

| 内容 | 默认位置 | 体积 |
|---|---|---|
| 索引 | `<data_dir>\index` | 每 1000 块约 4 MB |
| 日志 | `<data_dir>\logs` | 自动轮转 |
| 模型 | `<data_dir>\models`（或你指定的目录） | 约 1.2 GB |
| 依赖 | `<插件目录>\.venv` | 约 600 MB |

## 性能（本机实测，AMD Ryzen 9 7940HS / CPU）

| 指标 | 数值 |
|---|---|
| 单次检索（服务常驻） | 墙钟中位 **217 ms** |
| 首次检索（冷启动） | 约 7–12 秒（加载模型） |
| 索引吞吐 | 约 0.6 秒/块（首次） |
| 增量索引（无改动） | < 1 秒 |
| 单个项目按源重建 | 约 1 秒 |
| 常驻内存 | embed 约 1.6 GB；加载重排后 +4–5 GB（空闲 5 分钟自动卸载） |

## 兼容性

- 插件清单声明 `engines.dsh: ">=0.2.2-rc.0"`：**只有下限，没有上限**。新的 DSH 出来不会因此拦住你；插件会在能跑的前提下继续工作。
- 已在 `0.2.2-rc.2` / `0.2.2-rc.3` 上验证。
- 版本号规则：`<系列>.<插件迭代>.<DSH 代际>`，例如 `1.8.22` = 系列 1、第 8 次迭代、适配 DSH 0.2.2 一代。只有确认适配新一代 DSH 时才动最后一位。

## 安全

不联网、不上传、不删除文件、不要管理员、不改 PATH。完整的能力边界与不设防的部分写在 **[SECURITY.md](SECURITY.md)**。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-vector-memory
```

再删掉插件目录和数据目录即可。它不写注册表、不装系统服务。

## 许可

MIT，见 [LICENSE](LICENSE)。模型权重由阿里通义千问以 Apache-2.0 发布，不在本仓库内分发。
