# 给 AI 代理的安装说明（dsh-vector-memory）

> 这份文件的读者是「帮用户装插件」的 AI 代理（Claude Code / Codex / DSH 自身等）。
> 请严格按顺序执行，每一步都验证输出；任何一步与环境不符就停下并说明，不要跳过、不要自创命令。

## 0. 先确认这四件事

1. 操作系统是 Windows（`[System.Environment]::OSVersion.Platform` 或 `$env:OS`）。非 Windows 请停下，本插件只带了 Windows 安装脚本。
2. `python --version` 或 `py -3 --version` ≥ 3.10。没有 Python 就先让用户装，不要用 `winget` 之类自动装。
3. 插件目录里能看到这些文件：`package.json`、`src/index.js`、`lib/client.js`、`engine/vsearch.py`、`scripts/setup.ps1`。缺任何一个说明压缩包不完整，停下。
4. 插件目录**不是**用户自己的项目目录（路径里通常含 `dsh-vector-memory`）。所有写操作只在这个目录、以及用户指定的 `-DataDir` 里进行。

## 1. 安装依赖（在插件目录里执行）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -DataDir <用户给的数据目录> -ModelsDir <用户给的模型目录>
```

- 用户没给目录就省略：会落在 `%LOCALAPPDATA%\dsh-vector-memory`。
- 网络在中国大陆建议加 `-Mirror https://hf-mirror.com`。
- 只有确认用户已经装好依赖时，才可以加 `-SkipInstall`。
- 预期输出包含：`python 3.x` → `created ...venv` → 依赖版本行 → `data directory: ...` → 模型下载进度 → `engine/config.json` → 一段 status，末尾是 `Done.`。
- 这一步耗时 5–15 分钟，属于正常。**不要**因为看起来「卡住」就杀掉进程——pip 下载大包时长时间无输出是常态；可以看任务管理器里 python/pip 是否在跑。

## 2. 装进 DSH

```powershell
<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add "<插件绝对路径>"
```

- DSH 常见安装在 `C:\Program Files\DeepSeek Harness`、`C:\Program Files\DeepSeek Harness`，先用 `Get-Command dsh` 或问用户确认。
- profile 名默认 `desktop`；若用户用的是别的 profile，先问清楚。
- 这个命令内部是 pnpm，失败常见原因是目录里有 `node_modules` 锁或网络不通；把原始报错交给用户，不要自己 `rm -rf`。

**验证**：读 `C:\Users\<用户>\.dsh\profiles\desktop\package.json`，应满足：

- `dependencies["dsh-vector-memory"]` 存在；
- `dsh.profile.bundles` 里有 `"dsh-vector-memory"`。

两者缺一个都不要继续。

## 3. 重启并验收

让用户**关掉 DSH 再打开**（插件只在启动时加载，热重载不保证）。

重启后按顺序验证，任何一项失败就报告，而不是反复重启：

1. `GET http://127.0.0.1:<端口>/api/dsh-vector-memory/state`（端口在启动日志里，或问用户当前 DSH 界面地址）——应返回 JSON，`plugin.version` 为 `2.0.0`，`service.running` 最好为 `true`。
   - 本机 curl 可能需要加请求头 `x-vector-memory-client: vector-memory/1`；返回 403 是期望行为之一（说明接口只给宿主用）。
2. 让用户打开 **设置 → 向量记忆**：应看到版本徽标、服务状态、索引块数。
3. 点 **维护 → 预热服务**，确认「服务运行中」；再点 **立即增量索引**，确认任务从 `running` 变 `done`。
4. 点 **检索测试**，用一句用户笔记里必然存在的短语搜一次，应返回 `文件:行号`。

## 4. 出问题怎么办

| 症状 | 先看这里 |
|---|---|
| 依赖装不上 | 重跑 `setup.ps1 -SkipModels`；仍有错把 pip 原始输出交给用户 |
| 服务起不来 | `<DataDir>\logs\serve.log` 末尾 40 行；最常见是模型的路径写错、或端口被占 |
| 设置页空白 | 说明客户端 bundle 没加载：确认 `package.json` 里 `dsh.client` 与 `exports["./client"]` 都在 |
| 索引 0 块 | 说明没有登记任何目录：在 **项目** 页签添加项目目录，或改 `engine/config.json` 的 `sources` |

## 5. 回滚

```powershell
<DSH cli> plugin --profile desktop remove dsh-vector-memory
```

然后删插件目录与数据目录即可。插件不写注册表、不装系统服务、不改 PATH，删目录即彻底卸载。

## 6. 边界（不要做的事）

- 不要读、不要上传用户的笔记内容；这个插件的一切都在本机。
- 不要修改用户的其他 profile、其他插件。
- 不要为了「修好」而 `rm -rf`、清注册表、改 PATH、或关掉系统安全软件。
- 不要从网上抓别的安装脚本执行；本仓库自带 `scripts/` 已足够。
- 用户的数据目录里可能有 `config.json` 之外的既有索引，除非用户明确要求，不要删。
