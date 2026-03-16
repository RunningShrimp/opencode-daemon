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
- Web / TUI 会话页在大历史窗口下的可用性
- agent 执行链路的自驱动与子任务调度能力
- Thinking 模型与多 provider 的一致性
- 大会话下的 turn-control 与 compaction 行为
- Skills / LSP / MCP 路径上的性能与并发
- 面向编辑工具的 hashline 定位与校验基础设施
- 中国大陆网络环境下的模型资源可用性
- fork 仓库的手动发布、二进制兼容和本地替换流程

如果你需要官方稳定发布，请优先关注上游仓库。
如果你需要更激进的 daemon/TUI 优化、`opencoded` 兼容二进制、以及面向本地维护者的发布与验证能力，这个仓库就是针对这些场景维护的。

## 这个版本相对官方版补强了什么

这个 fork 不试图改变 OpenCode 的产品方向，而是更关注官方版本在高频、长时、真实项目环境里暴露出来的几个问题，并把它们往“更稳、更可控、更适合本地维护”的方向推进。

首先是会话体验，尤其是大历史窗口下的 TUI 可用性。我们重点修了长会话首屏卡顿、回滚后主面板空白、终端面板偶发空白、流式消息时序竞态这类问题，并把消息列表改成“最近 turns 优先渲染，向上滚动再逐批补历史”的方式。对外表现就是：长会话更能用，不容易一滚就卡，也不容易在切 session、revert 或工具流输出时把界面打乱。

其次是 agent 的收束质量。官方版本已经具备很强的工具调用和会话能力，但在复杂任务里，模型是否该继续、是否该压缩上下文、是否真的完成目标，仍然会受到单轮上下文和模型习惯影响。这个版本在这些点上加了更多运行时约束，包括 dynamic turn control、predictive compaction、self-driven agent、任务依赖阻断、QualityGate runtime enforcement，以及更完整的中英双语反迎合验证。简单说，就是尽量减少“看起来结束了，其实没做完”或者“回答很像对的，但证据不够”的情况。

再往下是代码理解和检索链路。我们把知识图谱、检索和项目记忆这条链路做得更偏工程化一些：知识图谱不再主要依赖浅层 regex，而是优先走 AST/tree-sitter；跨文件符号、import、调用和实例化关系的解析更细；embedding provider 支持显式切换并能暴露 ready、fallback、failed 等运行状态；workspace intelligence 也不再只是静态拼接上下文，而是增加了 sibling workspace 排序和跨项目经验迁移。对使用者来说，这会直接反映在更少的误连、更少的噪声上下文，以及更稳定的自动补全与检索结果上。

我们也补强了很多“官方版不一定优先处理，但本地维护非常需要”的基础设施。包括更稳健的并发队列和高频写路径、国内网络环境下的模型资源回退、GLM-5 和 MiniMax-M2.5 这类模型的缓存污染修复、日志与 XDG 路径兼容、`opencode` / `opencoded` 双二进制兼容，以及更适合 fork 仓库的手动发布和本地替换流程。这部分不是最显眼的功能，但会直接决定这个版本能不能被长期拿来当日常工作工具，而不只是“能跑一次”。

如果要概括这个版本和官方版的差异，可以理解为：官方版更像快速演进的主线产品，这个版本更像围绕 daemon、TUI、本地运行与长期维护做过一轮实战加固的分支。它没有试图重写 OpenCode，而是在尽量保持兼容的前提下，把稳定性、收束质量、检索准确性和维护体验往前推了一步。

## 已验证的重点场景

- 使用 tmux 隔离环境启动本仓库 TUI。
- 提交普通提示词后，模型可正常接收、渲染和返回结果。
- 在 GLM-5 和 MiniMax-M2.5 下可看到 Thinking 标记。
- 大会话下首屏只渲染最近 turns，向上滚动时可以逐批展开并继续拉取更早历史。
- 执行 `/session` 和 `/sessions` 时主界面可以正常渲染。
- 打开 terminal panel 时可以自动补建可用终端，并在切换后恢复焦点。
- 文件标签页中的行级评论可以直接进入 prompt context，编辑和删除会同步更新上下文内容。
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

## Embedding Provider 配置

当前默认行为：

- 未设置 `OPENCODE_EMBEDDING_PROVIDER` 时，后台优先启动 transformers provider。
- provider 初始化失败时会自动回退到语义 fallback，不阻塞会话启动。
- 会话 system prompt 会注入 `<embedding_runtime>` 状态块，便于观察当前活跃 provider 与失败原因。

可用 provider：

- `fallback`
- `transformers`
- `openai`
- `cohere`
- `voyage`

核心环境变量：

- `OPENCODE_EMBEDDING_PROVIDER`：选择 provider。
- `OPENCODE_EMBEDDING_MODEL`：外部 provider 模型名覆盖。
- `OPENCODE_EMBEDDING_BASE_URL`：外部 provider base URL 覆盖。
- `OPENCODE_EMBEDDING_DIMENSIONS`：输出维度覆盖（正整数）。

外部 provider key 优先级：

- OpenAI：`OPENCODE_OPENAI_API_KEY` → `OPENAI_API_KEY` → `OPENCODE_EMBEDDING_API_KEY`
- Cohere：`OPENCODE_COHERE_API_KEY` → `COHERE_API_KEY` → `OPENCODE_EMBEDDING_API_KEY`
- Voyage：`OPENCODE_VOYAGE_API_KEY` → `VOYAGE_API_KEY` → `OPENCODE_EMBEDDING_API_KEY`

示例：

```bash
export OPENCODE_EMBEDDING_PROVIDER=openai
export OPENCODE_OPENAI_API_KEY=sk-xxxx
export OPENCODE_EMBEDDING_MODEL=text-embedding-3-small
```

```bash
export OPENCODE_EMBEDDING_PROVIDER=voyage
export OPENCODE_VOYAGE_API_KEY=voyage-xxxx
export OPENCODE_EMBEDDING_MODEL=voyage-3-lite
```

```bash
export OPENCODE_EMBEDDING_PROVIDER=fallback
```

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