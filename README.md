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
<p align="center">基于 anomalyco/opencode 的持续优化分支，重点加强终端体验、长会话稳定性、代码理解链路和本地维护能力。</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/anomalyco/opencode)

---

## 这是什么

OpenCode Daemon 是一个基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) 的长期维护分支。

它保留了官方版本的核心能力：

- 开源的 AI coding agent
- provider-agnostic 模型接入方式
- TUI / Web / Desktop 多端架构
- client/server 设计
- agent、tool、session、workspace 等完整能力

这个 fork 不打算改掉 OpenCode 的产品方向，重点是把官方版在高频使用中最容易遇到的问题继续向前修：

- 长时间运行时的 TUI 稳定性
- 大会话、大历史记录下的首屏速度和滚动体验
- agent 的自驱动、收束质量和任务延续能力
- Skills、LSP、MCP 的路由效率和并发表现
- 知识图谱、RAG、tree-sitter 这一整条“理解代码”的链路
- 中国大陆网络环境下的模型资源可用性
- fork 仓库的构建、发布和本地替换流程

如果你需要官方稳定发布，请优先关注上游仓库。
如果你需要一个更偏“实战维护”的版本，尤其关心终端体验、长会话可用性、RAG 稳定性和 `opencoded` 二进制替换流程，这个仓库就是为这些场景维护的。

## 为什么有这个优化版本

这个优化版本存在的目的很直接：

- 把 OpenCode 从“能跑”继续推进到“适合高频日常使用”。
- 解决官方版本在长会话、终端交互和本地维护场景中更容易暴露的问题。
- 在尽量保持兼容的前提下，增强稳定性、响应速度、代码理解能力和发布可操作性。
- 让中国大陆网络环境、本地二进制替换和 fork 维护工作流更直接、更少阻塞。

## 主要增强

- 更快：会话历史改成最近内容优先渲染，长对话首屏更快，向上滚动时再按页补历史，diff 和消息区域不再轻易把界面拖慢。
- 更稳：修了 TUI 空白、终端恢复、焦点丢失、日志清理、会话丢失、子进程退出、工作区切换等一批高频问题。
- 更省上下文：会在发送给模型的上下文里主动移除旧 reasoning、synthetic reminder 和冗余工具输出，只在清理后仍然超预算时才触发 compaction。
- 更聪明：补强了自驱动 agent、self-review、quality gate、任务依赖阻断和后续任务延续逻辑，减少“看起来结束了，其实没做完”。
- 更懂代码：知识图谱、RAG、tree-sitter、hashline、workspace intelligence 继续往工程化方向推进，减少误连和噪声上下文。
- 更好接工具：MCP、Skills、LSP 都做了路由和性能优化，多工具场景下更容易保持响应速度。
- 更能落地：补了 `opencoded` 打包、手动发布流程、日志路径隔离、模型镜像和网络失败回退，方便本地长期使用。

## 谁适合用

- 想把 OpenCode 当成日常开发工具，而不是只跑一次 demo 的团队或个人。
- 长时间使用 TUI、经常开大项目、需要处理很多历史上下文的人。
- 需要在中国大陆网络环境下尽量降低模型下载失败影响的人。
- 希望自己维护二进制和发版流程的维护者。

## 与官方版的区别

这个 fork 不试图改变 OpenCode 的产品方向，而是更关注官方版本在高频、长时、真实项目环境里暴露出来的几个问题，并把它们往“更稳、更可控、更适合本地维护”的方向推进。

首先是会话体验，尤其是大历史窗口下的 TUI 可用性。这个版本重点修了长会话首屏卡顿、回滚后主面板空白、终端面板偶发空白、流式消息时序竞态、Sidebar 同步异常、提示框粘贴和滚动跟不上等问题，并把消息列表改成“最近 turns 优先渲染，向上滚动再逐批补历史”的方式。对普通用户来说，最直接的变化就是：长会话更能用，切 session 更稳，滚动时不容易一下子卡死。

在终端交互层，这个版本也继续把侧栏和文件审阅体验往“更直接”推进。Modified Files 不再做单击预览，改成纯双击进入 `vim -d -R` diff review；Knowledge Graph 也可以直接在侧栏里看到 relevant nodes、分类节点和关系摘要，便于在大仓库里快速建立上下文。

其次是 agent 的收束质量。官方版本已经具备很强的工具调用和会话能力，但在复杂任务里，模型是否该继续、是否该压缩上下文、是否真的完成目标，仍然会受到单轮上下文和模型习惯影响。这个版本继续加强了 dynamic turn control、predictive compaction、self-driven agent、任务依赖阻断、QualityGate runtime enforcement、自我审查工作流，以及“把上一轮未完成任务带进下一轮”的连续执行能力。最近又把 continuation 判断进一步收紧到“只有上一轮真的存在下一步或剩余任务时才继续”，减少无意义自动续跑。简单说，就是尽量减少“看起来结束了，其实没做完”或者“回答很像对的，但证据不够”的情况。

和这条链路配套的，还有一层只作用于模型输入、不改动真实会话历史的上下文清理。旧 reasoning、synthetic reminder、重复或超大的工具输出、历史工具错误，现在会先在发送给模型前做清理或摘要；如果清理后上下文仍然接近模型上限，再决定是否压缩。这样做的目的不是“把历史藏起来”，而是让模型看到更干净、更有信息密度的上下文，同时尽量少触发不必要的 compaction。

再往下是代码理解和检索链路。我们把知识图谱、检索和项目记忆这条链路做得更偏工程化一些：知识图谱不再主要依赖浅层 regex，而是优先走 AST/tree-sitter；跨文件符号、import、调用和实例化关系的解析更细；embedding provider 支持显式切换并能暴露 ready、fallback、failed 等运行状态；workspace intelligence 也不再只是静态拼接上下文，而是增加了 sibling workspace 排序和跨项目经验迁移。近期还把默认 embedding 切到新的默认模型，并改成后台优先启动、失败自动回退，不让下载失败直接卡住 prompt 输入；即使远端模型拉取失败，prompt 仍然可以先用 fallback 继续工作。

我们也补强了很多“官方版不一定优先处理，但本地维护非常需要”的基础设施。包括更稳健的并发队列和高频写路径、MCP Smart Router、Skills Router、LSP 池化与复用、国内网络环境下的模型资源回退、部分第三方模型的缓存污染修复、日志与 XDG 路径兼容，以及更适合 fork 仓库的手动发布和本地替换流程。这部分不是最显眼的功能，但会直接决定这个版本能不能被长期拿来当日常工作工具，而不只是“能跑一次”。

如果要概括这个版本和官方版的差异，可以理解为：官方版更像快速演进的主线产品，这个版本更像围绕 daemon、TUI、本地运行与长期维护做过一轮实战加固的分支。它没有试图重写 OpenCode，而是在尽量保持兼容的前提下，把稳定性、收束质量、检索准确性和维护体验往前推了一步。

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

`--single` 现在只会为当前平台生成一个可执行文件：`opencoded`。

如果你在非 macOS arm64 平台上构建，`dist` 目录中的目标名称会随平台变化。

### 本地替换二进制

```bash
install -m 755 ./packages/opencode/dist/opencode-darwin-arm64/bin/opencoded ~/.local/bin/opencoded
~/.local/bin/opencoded --version
```

## Embedding Provider 配置

当前默认行为：

- 未设置 `OPENCODE_EMBEDDING_PROVIDER` 时，后台优先启动 transformers provider。
- provider 初始化失败时会自动回退到语义 fallback，不阻塞会话启动。
- provider 后台启动超时后会快速放弃等待，避免索引或 prompt 长时间卡在模型下载上。
- 默认会启用仓库内预设的文本 embedding 模型。
- 会话 system prompt 会注入 `<embedding_runtime>` 状态块，便于观察当前活跃 provider 与失败原因。

## 当前终端体验

- 长会话默认只先加载最近一段消息，首屏更快，继续向上滚动时再分页补更早历史。
- 历史上下文会在发给模型前做一次临时清理，减少旧 reasoning、重复工具输出和 reminder 噪声。
- Modified Files 采用纯双击进入 `vim` diff review，不保留单击预览态。
- 侧栏聚焦在 MCP、LSP、Modified Files、Knowledge Graph 这几块高频信息。
- Knowledge Graph 侧栏会按当前用户问题刷新 relevant 节点和关系摘要。

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

## 维护原则

这个仓库的维护原则很简单：

- 官方版本迭代快，但某些 TUI / daemon 侧问题需要更快落地。
- 本地维护者需要一个可重复打包、可替换二进制、可手动发版的工作流。
- 国内网络环境下，模型资源下载失败不能成为整个流程的硬阻断点。
- 我们希望 README 能直接告诉普通使用者：这个优化版本是做什么的、增强了什么、与官方版有什么差异。

因此这个 fork 的原则是：

- 尽量保持与上游结构兼容。
- 优先修复真实可复现的问题。
- 让构建、发布和回滚都更直接。

## 贡献与声明

欢迎继续在这个 fork 上推进 daemon/TUI/发布链路相关优化。

- 如果你的目标是向官方仓库提交通用修复，请尽量保持改动最小并兼容上游。
- 如果你的目标是面向本 fork 的本地维护，请优先补充清晰的复现信息、日志路径和使用说明。

本仓库是基于 OpenCode 的非官方优化分支，不代表上游团队的发布节奏或维护承诺。