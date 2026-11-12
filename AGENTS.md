# AGENTS.md

给在本仓库协作的 AI/人类开发者的工作说明。各 workflow 内已有详细行内注释，本文只记录跨文件的约定与易踩的坑；若有出入请同步更新本文。

## 仓库定位

VIrobotics Harness 的 nightly 打包仓库。本仓库不含应用源码：

- 源码在私有仓库 `kisaragychihaya/llm-chat`，workflow 用 `SOURCE_REPO_TOKEN` 签出。
- 本仓库只存放：NSIS 脚本 `vih.nsi`、便携 NSIS 压缩包、加密的 vis-env 运行环境归档（`vis-env-<arch>.7z`，AES-256 + 头加密，密码在 secret `VISENV_7Z_PASSWORD`）。
- 本仓库是公开的，用标准 runner 免费额度，不消耗私有仓 Actions 分钟数。

## workflow 总览

| 文件 | 触发 | 作用 |
|---|---|---|
| `nightly.yml` | workflow_dispatch / release published | 主打包：matrix x64/x86 并行，产出 setup.exe（存 artifact 7 天，release 时挂附件并同步到企业网盘「软件分享【对外】」）；手动触发可勾选 `sync_latest_release_to_edm` 跳过构建、只同步最新 release 的 exe 到网盘 |
| `native-ia32.yml` | workflow_dispatch（手动） | 编译 x86 腿缺的 ia32 原生件（node-pty / ripgrep），传到常驻 release `native-ia32` 供 nightly x86 腿下载 |
| `sphinx-doc.yml` | workflow_dispatch / release published | 构建源码仓 manual/ 的 Sphinx 文档（uv 管依赖，已开 enable-cache） |
| `policy-sign.yml` | workflow_dispatch（手动） | 用 Ed25519 私钥签策略 cp.json，产出 artifact 人工上传 CDN |

## 缓存设计（改 nightly.yml 前必读）

nightly 的耗时大头是 `npm ci` 全量删装和 electron-forge 现下载 Electron zip。现有缓存层级：

1. **node_modules 整体缓存**（`actions/cache/restore` + `actions/cache/save` 拆分）
   - key：`node-modules-<os>-<arch>-<源码仓 package-lock.json 哈希>`。
   - key 里的 `<arch>`（即 `matrix.arch`）不可省略：x86 腿装完依赖后会往 node_modules 放 ia32 原生预编译件（`Place ia32 native prebuilts` 步），两腿共用 key 会互相污染。
   - 命中即跳过 `npm ci`；**不要**给它配 `restore-keys`——旧 lockfile 的 node_modules 是毒缓存。
   - 特意拆成 restore/save 且 save 带 `success()` 条件：npm ci 失败的现场不能落缓存，否则下次命中会跳过安装直接坏掉。
2. **Electron 二进制缓存**：`~/AppData/Local/electron/Cache`（@electron/get 默认目录，已对照上游源码确认）。按下载 URL 分目录、多版本共存安全，故配 `restore-keys` 前缀放宽。两条腿各 arch 独立 key，避免并发 save 撞 key。
3. setup-node 的 `cache: npm`：只兜 tarball 下载，命中 1 时基本用不上，保留作冷启动兜底。

约定：新增"装依赖后的产物"类缓存时，key 必含 `matrix.arch` + lockfile 哈希。

**明确不缓存**（评估过、收益为负）：

- vis-env 解密产物：归档本地 7z 解压很快；把解密后的 Python 环境打进 Actions 缓存既慢，又把明文落进缓存。
- NSIS 解压结果：量小，同理。
- `runtime/` 下的 node.exe（`npm run fetch-node` 步）：下载脚本在私有仓、输出路径以它为准；除非确认耗时可观且路径稳定，不动它。
- `native-ia32.yml` / `policy-sign.yml`：手动低频触发，不挂缓存。

失效规则：缓存 key 以源码仓 lockfile 哈希为准——ref 变化但 lockfile 不变时缓存照样命中，这是特性不是 bug。缓存要等改动 push 到默认分支后的首次运行才开始积累。

## 验证方式

本仓库没有本地可跑的构建，产物全靠 CI。改 workflow 后至少做 YAML 语法校验：

```bash
npx --yes yaml < .github/workflows/xxx.yml > /dev/null
```

行为类改动（尤其缓存命中/未命中两条路径）只能跑 `workflow_dispatch` 实测：先跑一次未命中（应完整 `npm ci` 并在末尾落缓存），再触发一次命中（应跳过 Install 步）。

## 红线

- secret（`SOURCE_REPO_TOKEN`、`VISENV_7Z_PASSWORD`、`POLICY_PRIVATE_KEY`、`EDM_TOKEN`）只经 `env:` 进命令，绝不打印；policy-sign 的私钥用完即删（含失败路径，`if: always()`）。
- `EDM_TOKEN` 是阿里云盘企业版 token JSON（edm-action 项目 `edm-token login` 产出，含 `domain_id` + `refresh_token`）；`refresh_token` 每次刷新轮换，上传脚本检测到轮换会经 `SOURCE_REPO_TOKEN` 自动写回该 secret（写回步骤 `continue-on-error`，失败时看日志 warning 手动更新，旧值约 7 天后失效）。
- 不要把 `npm ci` 换成 `npm install`：lockfile 严格安装是"缓存命中即跳装"成立的前提。
- vis-env 归档更新必须与源码仓相应改动配套验证；`Extract bundled vis-env` 步对缺 `python.exe` / 密码错直接失败是预期行为。
