# 安装指南（Windows）

两种装法，选一种即可。两者都不需要管理员权限，不会改 PATH，不会动系统里别的程序。

- **A. 让 AI 帮你装**（推荐给不想敲命令的人）：把压缩包解压后，对 DSH 里任意一个会话说「按 `AGENTS-install.md` 把 `dsh-vector-memory` 装上」，它会按步骤做并逐项验证。
- **B. 自己装**：按下面的命令逐条执行。

---

## 0. 准备

| 需要 | 说明 |
|---|---|
| Windows 10/11 | 本插件只提供 Windows 安装脚本 |
| Python 3.10+ | <https://www.python.org/downloads/>，安装时勾选 “Add python.exe to PATH” |
| DSH 0.2.2-rc.0 或更新 | 更老的版本不保证可用（插件里 `engines.dsh` 声明了下限） |
| 磁盘 ≈ 2 GB | 依赖 ~600 MB + 模型 ~1.2 GB + 索引（看你索引多少文件） |
| 网络 | 首次装依赖、首次下载模型需要；之后完全离线可用 |

下载模型走 Hugging Face 官方仓库：`Qwen/Qwen3-Embedding-0.6B`、`Qwen/Qwen3-Reranker-0.6B`（Apache-2.0）。国内网络可用 `-Mirror https://hf-mirror.com`。

## 1. 解压

解压到一个**不会被误删、路径里没有空格也行**的目录，例如：

```
C:\tools\dsh-vector-memory
```

## 2. 跑安装脚本

在解压出的目录里打开 PowerShell（不用管理员），执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -DataDir D:\vector-memory-data -ModelsDir D:\vector-memory-models
```

常用参数：

| 参数 | 作用 |
|---|---|
| `-DataDir <路径>` | 索引和日志放在哪（默认 `%LOCALAPPDATA%\dsh-vector-memory`） |
| `-ModelsDir <路径>` | 模型放在哪（默认 `<DataDir>\models`）；`-SkipModels` 表示先不下，首次使用时自动下 |
| `-Sources <路径1>,<路径2>` | 顺带登记几个「常驻笔记目录」，插件会索引里面的 `.md`/`.txt` |
| `-Mirror <url>` | 下载镜像，默认 `https://hf-mirror.com`；要直连官方就传 `-Mirror ""` |
| `-SkipInstall` | 只写配置、不装依赖（你已经有一个装好依赖的 Python 时用） |
| `-Force` | 覆盖已有 `engine/config.json` |

脚本会做这几件事，每一步都会打印结果：

1. 找到 Python 并确认 ≥ 3.10；
2. 在插件目录里建 `.venv`（私有虚拟环境，不污染全局）；
3. 装依赖（torch 走 CPU 轮子，不拉 CUDA 版本）；
4. 建数据目录；
5. 下模型（可选）；
6. 写 `engine/config.json`；
7. 自检：打印索引与服务的状态。

> 第一次装依赖 + 下模型大约 5–15 分钟，取决于网速。中途关掉也可以重跑，脚本是幂等的。

## 3. 装进 DSH

```powershell
# 把插件装到名为 desktop 的 profile（默认桌面版就是它）
"<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\tools\dsh-vector-memory"
```

其中 `<DSH 安装目录>` 换成你自己的 DSH 安装目录（常见为 `C:\Users\<你>\AppData\Local\Programs\DSH` 之类）。如果 `dsh` 已经在 PATH 里，直接 `dsh plugin --profile desktop add <路径>`。

装完确认 `C:\Users\<你>\.dsh\profiles\desktop\package.json` 里：

- `dependencies` 出现 `"dsh-vector-memory": "link:..."`；
- `dsh.profile.bundles` 数组里出现 `"dsh-vector-memory"`。

然后**重启一次 DSH**（关掉应用再打开）。插件在启动后约 12 秒做一次自检：预热本地服务、跑一次增量索引。

## 4. 验收

重启后：

1. 打开 **设置 → 向量记忆**：顶部应显示版本号（形如 `v2.0.0`）、「服务运行中」、索引块数。
2. 点 **检索测试**，输入一句你笔记里一定有的内容，应返回带 `文件:行号` 的结果。
3. 回到 **状态**：`自动召回` 的「已注入」数字在正常对话中会增长——说明新会话开头的检索块真的进了请求。
4. 打开任意一个项目的会话：**项目** 页签里应出现该项目目录（跨盘也行），并自动索引其中的文档。

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| 设置页能看到，但状态全是「未运行」 | 点 **维护 → 预热服务**；仍不行就看 `<DataDir>\logs\serve.log` 末尾的报错 |
| 提示找不到 Python / 模块缺失 | 重跑 `setup.ps1`（它会重建 `.venv`）；确认 `engine/config.json` 里 `python` 指向 `<插件目录>\.venv\Scripts\python.exe` |
| 检索没有结果 | **维护 → 增量索引**；确认 **项目** 页签里有目录、且这些目录下有 `.md`/`.txt` 文件 |
| 模型下载失败 | 用 `-Mirror https://hf-mirror.com` 重跑；或手动下载后把 `models.embed` / `models.rerank` 改成本地目录 |
| 想只用不装（临时停用） | 设置页 → **参数** → 关掉「启用向量检索（自动召回）」；或 `dsh plugin --profile desktop remove dsh-vector-memory` |

## 6. 卸载

1. `dsh plugin --profile desktop remove dsh-vector-memory`
2. 删掉插件目录（里面含 `.venv`，体积较大）
3. 删掉数据目录（`<DataDir>`，索引与日志）
4. 删掉模型目录（如果没用共享的模型目录）

以上三步不进回收站就直接删也可以——插件不写注册表、不装服务、不改环境变量，删目录即是干净卸载。

## 7. 安全提示

装任何「让 AI 帮你装」的东西之前，先看一眼 `SECURITY.md` 里写清楚的能力边界：本插件**不联网、不上传、不删除**，只在你登记的目录里读文档，并在本机 `127.0.0.1` 上起一个检索服务。如果对方的说明让你执行来路不明的脚本，那和本插件无关，直接拒绝。
