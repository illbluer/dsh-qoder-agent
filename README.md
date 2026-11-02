# dsh-qoder-agent

把 Qoder CN 桌面 App 里的模型接入 the agent runtime，零配置、无需单独 OAuth、无需启动 CLI 子进程。

## 原理

复用 Qoder CN 桌面 App 自己的登录态（只读，不改写），用内嵌的 `qoder-auth` wasm 生成每个请求的 `Authorization: Bearer COSY.…` 头，走 `gateway.qoder.com.cn` 直连。

三层结构（与 dsh-workbuddy-bridge 同骨架）：

1. **回环 shim** — 在 `127.0.0.1:0` 起一个 OpenAI 兼容端点（`/v1/models`、`/v1/chat/completions`、`/healthz`），四道加固（Host 回环 / Origin 回环 / 强制 JSON / 进程内随机共享密钥，常量时间比较）。
2. **pi-ai adapter** — 把 shim 包装成 DSH 认识的 provider。
3. **注册** — `ctx.llm.registerAdapter(["qoder-agent"], adapter)`，`cordis.patch.yml` 只插入一个 `llm-qoder-agent` 条目，不改默认模型。

## 凭据从哪来

| 数据 | 位置 |
|---|---|
| 登录态（token / refreshToken / user） | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`（Chromium safeStorage `v10`，DPAPI 保护） |
| 解密密钥 | 同目录 `Local State` 的 `os_crypt.encrypted_key`（DPAPI） |
| 设备指纹 machineToken | `~/.qoder-cn/umid-cache.json` |

解密在插件进程内完成，通过 PowerShell 调 `System.Security.Cryptography.ProtectedData`（DPAPI 在 Windows 上没有 Node 内建）。密钥和明文凭据都只在内存里，不落盘。

## 模型

`chat` 场景 11 个（价格倍率后缀显示在名字上）：

Auto(0.5) · Fast(0.8) · Qwen3.8-Max(0.5) · Qwen3.8-Flash(免费) · DeepSeek-V4-Pro(0.5) · DeepSeek-Flash(0.1) · GLM-5.3(0.8) · GLM-5.3-Flash(0.1) · Kimi-K3.1-Pro(1.0) · Kimi-K2.8-Preview(0.8) · MiniMax-M3.1-Flash(0.1)

## 已知限制

- 只支持 Windows（凭据解密依赖 DPAPI；macOS/Linux 需要另接 Keychain/libsecret）。
- 上游强制流式，`stream:false` 也会被转成流式并聚合。
- 上游外层 HTTP 恒 200，错误藏在 SSE 帧的 `body` 里（`statusCodeValue` / `code`），本插件已做剥离与透传。

## 安装

```bash
# 在 DSH 里（插件管理 → 从本地目录安装，或命令行）：
plugin_manager install_bundle target="link:<本仓库路径>"
```

装完重启 DSH，模型选择里会出现「Qoder CN」分组的 11 个模型。前提：本机装有 Qoder CN 桌面 App 并已登录。

## 免责声明

本插件仅复用你本机已登录的 Qoder CN App 的合法订阅额度，只读不改写 App 的原始凭据文件。请遵守 Qoder CN 的服务条款。
