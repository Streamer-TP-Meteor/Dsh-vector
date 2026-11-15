---
name: vector-memory
description: >
  本地向量记忆检索（命令行版）。当需要回忆“以前定过什么方案 / 踩过什么坑 / 用户偏好 /
  项目进度”，或用户问“我们之前是不是…”“上次那个…”时使用：用 Qwen3-Embedding-0.6B
  + BM25 混合检索已登记的笔记目录，返回带出处的原文片段。比 grep 更懂意思，
  比整篇读文档更省上下文。图形界面在 DSH 的「设置 → 向量记忆」。
---

# 本地向量记忆（命令行）

本机常驻一个本地向量服务（默认 `127.0.0.1:8479`，Qwen3-Embedding-0.6B，1024 维，纯 CPU）。
索引范围 = `config.json` 里 `sources` 登记的常驻目录 + 会话所在项目自动登记的项目目录
（文件类型默认 `.md/.mdx/.txt/.rst`，跳过 `node_modules/.git/dist/build` 等）。

检索流程：BM25（字词）+ 向量 → RRF 融合（默认到此为止，约 0.2 秒）；要更准可加 `--rerank`，
走 Qwen3-Reranker-0.6B 交叉重排（CPU 上每次 6–15 秒，故默认关闭）。

> 装了 DSH 插件的话，**每轮会话开头会自动检索 top-3**，以「【向量检索 · 本机记忆】」块放进请求。
> 看到它时当背景提示用，引用事实前按 `path:line` 读原文核对。
> 这份命令行手册用于：手动查证、查重、脚本化调用、或在没有 DSH 的环境里直接用索引。

## 怎么用

先找到插件目录与配置（安装脚本会把它们写进 `engine/config.json`）：

```
<插件目录>\engine\config.json
```

然后：

```powershell
# 检索
<插件目录>\.venv\Scripts\python.exe <插件目录>\engine\vsearch.py search "上次说的方案是什么"

# 只看某个源（多源用逗号）、更多结果、可选重排
... vsearch.py search "部署脚本的约定" --src project-d-notes --srcs notes,project-d-notes -k 8 --rerank

# 索引维护
... vsearch.py index            # 增量（只算变动的文件）
... vsearch.py index --force    # 全量重建
... vsearch.py index --only notes   # 只重建某个源，秒级

# 状态与服务的生命周期
... vsearch.py status
... vsearch.py serve --start
... vsearch.py serve --stop
```

加 `--json` 得到机器可读输出（字段：`hits[].rank/score/src/path/line/heading/snippet/cos/bm25`、`info.ms`）。
全局参数 `--config <path>` 要写在子命令前面。

## 什么时候值得用

- 用户问“之前/上次/我们说过/按之前的方案”这类**指代历史**的问题——先查，再答。
- 要引用具体事实（数字、路径、约定、踩过的坑）之前——先查出处，别凭印象编。
- 想确认某件事是否已经做过——查重比翻文件快。

不必用：问题就写在当前对话里、或明显是常识时，多查一次只是浪费。

## 维护

- 写完新的笔记后跑一次 `index`（增量，通常 < 2 秒）；插件会自动在启动后做一次增量。
- 索引与服务状态：`status`；日志在 `<data_dir>\logs\serve.log`。
- 服务常驻内存约 1.6 GB（只加载嵌入模型）；用过重排会临时涨到 5–6 GB，空闲 5 分钟自动卸载。
- 改了端口/线程数要重启服务：`serve --stop` 然后 `serve --start`。

## 注意

- 服务只监听本机回环地址，不要改成 `0.0.0.0`（配置里 `service.allow_remote` 默认 `false` 会拦住）。
- 不要在命令里手写查询指令前缀（`Instruct: ...`），引擎已经按 query 模板处理。
- 检索结果是片段，不是全文：引用前按 `path:line` 回原文看上下文。
