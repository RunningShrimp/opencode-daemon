<p align="center">
  <a href="https://github.com/anomalyco/opencode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode Daemon logo">
    </picture>
  </a>
</p>

<p align="center"><strong>OpenCode Daemon</strong></p>
<p align="center">基于 anomalyco/opencode 的持续优化分支，重点加强 TUI 稳定性、会话控制、并发性能、国内网络可用性和 fork 发布流程。</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/anomalyco/opencode)

---

## 这是什么

OpenCode Daemon 是一个基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) 的优化分支。

它保留了官方版本的核心能力：

- 开源的 AI coding agent
- provider-agnostic 模型接入方式
- TUI / Web / Desktop 多端架构
- client/server 设计
- agent、tool、session、workspace 等完整能力

这个 fork 的重点不是改写产品方向，而是持续修正官方版本在高频真实使用中的几个痛点：

- 长时间运行时的 TUI 稳定性
- Thinking 模型与多 provider 的一致性
- 大会话下的 turn-control 与 compaction 行为
- Skills / LSP / MCP 路径上的性能与并发
- 中国大陆网络环境下的模型资源可用性
- fork 仓库的手动发布、二进制兼容和本地替换流程

如果你需要官方稳定发布，请优先关注上游仓库。
如果你需要更激进的 daemon/TUI 优化、`opencoded` 兼容二进制、以及面向本地维护者的发布与验证能力，这个仓库就是针对这些场景维护的。

## 相比官方版本的主要优化

### TUI 稳定性

- 修复 session revert 锚点落在 100 条消息窗口之外时主面板空白的问题。
- 修复 `message.part.delta` 先于 `part.updated` 到达时的竞态问题。
- 清理事件监听与进程关闭路径，减少长时间运行后的渲染异常和悬挂子进程。
- 提升终端兼容性，优化工具执行中的状态展示。

### 会话与智能控制

- 为 TUI prompt 接入统一的 prompt state 管理，收敛输入模式、占位符轮换、重置与打断逻辑。
- 接入 dynamic turn control，让会话更保守地判断何时收束回合。
- 接入 predictive compaction，提前判断压缩时机，降低长会话退化风险。
- 将 MCP 默认超时提升到更适合真实环境的区间，减少慢工具误超时。

### 性能与基础设施

- 引入并强化 `ConcurrencyLimiter`、`AsyncQueue` 和相关测试覆盖。
- 实施 SkillsRouter 架构优化，降低 skills 扫描与加载的开销。
- 增强 LSP 和 MCP Smart Router 路径，减少高并发下的阻塞。
- 增加 session error handler、workspace integration 和自驱动 agent 能力相关改进。

### 国内网络与模型可用性

- 对 Hugging Face 资源下载增加多源回退：ModelScope 优先尝试、`hf-mirror.com` 次之、官方源最后。
- 单个下载源失败不会阻断整体流程；embedding 路径在失败时仍可继续使用 hash fallback。
- 修复 snapshot / models-cache 污染导致的模型失效问题，尤其是 `zhipuai-coding-plan/glm-5` 和 `minimax-cn-coding-plan/MiniMax-M2.5` 这类实际验证过的模型。
- 降低可选 provider 自定义加载器缺失时的误报 ERROR 日志。

### 构建、路径与发布

- 兼容 `opencode` 与 `opencoded` 双二进制名称。
- 保持官方 XDG 数据和配置目录兼容，同时把日志隔离到 `XDG_STATE_HOME/opencoded/log`。
- 保持 `.local/bin` 路径识别与 curl 安装行为兼容。
- 发布 CI 支持 fork 仓库手动触发，缺少 GitHub App 密钥时自动回退 `github.token`。
- 手动发布默认只做 GitHub Release 相关流程，不再强制依赖 npm、docker、Homebrew 或 AUR 发布权限。

## 已验证的重点场景

- 使用 tmux 隔离环境启动本仓库 TUI。
- 提交普通提示词后，模型可正常接收、渲染和返回结果。
- 在 GLM-5 和 MiniMax-M2.5 下可看到 Thinking 标记。
- 执行 `/session` 和 `/sessions` 时主界面可以正常渲染。
- 日志路径可稳定产出日志并用于排查 ERROR。
- 当前平台二进制可打包为 `opencoded` 并替换到本地 `.local/bin`。

## 快速开始

### 源码运行

```bash
bun install
bun run dev
```

### Web 与桌面端

```bash
bun run dev:web
bun run dev:desktop
```

### 当前平台打包 `opencoded`

```bash
OPENCODE_VERSION=1.0.0-local bun run packages/opencode/script/build.ts --single
./packages/opencode/dist/opencode-darwin-arm64/bin/opencoded --version
```

如果你在非 macOS arm64 平台上构建，`dist` 目录中的目标名称会随平台变化。

### 本地替换二进制

```bash
install -m 755 ./packages/opencode/dist/opencode-darwin-arm64/bin/opencoded ~/.local/bin/opencoded
~/.local/bin/opencoded --version
```

### 推荐验证脚本

```bash
./script/tui-validate-tmux.sh
```

这个脚本会在隔离的 XDG 环境下进行 TUI 验证，避免你的用户数据和缓存影响结果。

## 安装路径与运行时目录

为了兼容官方版本与 fork 的本地使用习惯，当前路径策略如下：

- 配置、数据、状态目录继续沿用官方 `opencode` XDG 命名。
- 日志目录独立放在 `XDG_STATE_HOME/opencoded/log`。
- `.local/bin` 仍被识别为兼容的本地安装位置。

这意味着你可以保留原有配置，同时把 fork 的日志与部分二进制行为独立出来。

## 仓库结构

- `packages/opencode`：CLI、TUI、session、provider、daemon 主体
- `packages/app`：Web 客户端
- `packages/desktop`：Tauri 桌面壳
- `packages/desktop-electron`：Electron 桌面壳
- `script`：构建、发布、版本和辅助脚本
- `docs`：文档与优化方案记录
- `packages/console/*`：控制台相关服务与应用层

## 文档与官方资料

- 官方文档：<https://opencode.ai/docs>
- 上游仓库：<https://github.com/anomalyco/opencode>
- 当前 fork：<https://github.com/RunningShrimp/opencode-daemon>

官方文档中的大部分模型接入、agent、tool、session 配置说明仍然适用于这个 fork。
本仓库 README 主要补充 fork 的差异化能力、构建方式和维护者关注点。

## 为什么维护这个 fork

这个仓库存在的核心原因很简单：

- 官方版本迭代快，但某些 TUI / daemon 侧问题需要更快落地和持续验证。
- 本地维护者需要一个可重复打包、可替换二进制、可手动发版的工作流。
- 国内网络环境下，模型资源下载失败不能成为整个流程的硬阻断点。

因此这个 fork 的原则是：

- 尽量保持与上游结构兼容。
- 优先修复真实可复现的问题。
- 让构建、验证、发布和回滚都更直接。

## 贡献与声明

欢迎继续在这个 fork 上推进 daemon/TUI/发布链路相关优化。

- 如果你的目标是向官方仓库提交通用修复，请尽量保持改动最小并验证与上游兼容。
- 如果你的目标是面向本 fork 的本地维护，请优先补充可复现脚本、日志路径和验证步骤。

本仓库是基于 OpenCode 的非官方优化分支，不代表上游团队的发布节奏或维护承诺。