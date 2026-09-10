# virobotics-harness-nightly

VIrobotics Harness 的 nightly 打包仓库。本仓库**不含源码**，仅存放 GitHub Actions 工作流：
手动触发后，从私有仓库 [kisaragychihaya/llm-chat](https://github.com/kisaragychihaya/llm-chat) 拉取代码，
在 `windows-latest` 上执行 `npm run package`（压缩 + 提示词加密 + V8 字节码编译），
产物（`VIrobotics-Harness-win32-x64`）作为 artifact 上传。

使用公开仓库的原因：公开仓库的标准 runner 免费且不限分钟数，不消耗私有仓库的 Actions 额度。

## 使用

1. Actions → **nightly-package** → **Run workflow**，可指定源码 ref（默认 `main`）。
2. 完成后在 run 页面下载 artifact。

## 安全说明

- 拉取私有仓库需要 PAT，存放于本仓库的 `SOURCE_REPO_TOKEN` secret（fork 的 PR 无法访问 secret）。
- 产物中的 asar 已做 minify / 提示词 AES-256-GCM 加密 / 主进程字节码编译，属可公开分发的 nightly 形态。
- 源码不出现在本仓库中，但构建日志公开可见；工作流仅在手动触发时运行。
