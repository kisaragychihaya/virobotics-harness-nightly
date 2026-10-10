# virobotics-harness-nightly

VIrobotics Harness 的 nightly 打包仓库。本仓库**不含源码**，仅存放 GitHub Actions 工作流：
手动触发后，从私有仓库 [kisaragychihaya/llm-chat](https://github.com/kisaragychihaya/llm-chat) 拉取代码，
在 `windows-latest` 上执行 `npm run package`（压缩 + 提示词加密 + V8 字节码编译），
产物（`VIrobotics-Harness-win32-x64`）作为 artifact 上传。

使用公开仓库的原因：公开仓库的标准 runner 免费且不限分钟数，不消耗私有仓库的 Actions 额度。

## 使用

1. Actions → **nightly-package** → **Run workflow**，可指定源码 ref（默认 `main`）。
2. 完成后在 run 页面下载 artifact。


