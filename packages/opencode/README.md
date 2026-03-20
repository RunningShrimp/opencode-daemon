# opencoded

`packages/opencode` 是 OpenCode Daemon 的核心包，里面包含 CLI、TUI、会话管理、工具调度、provider 接入、RAG 和本地运行时能力。

这个 fork 主要做了几类增强：

- 长会话和大历史窗口下的 TUI 性能与稳定性。
- 模型输入前的上下文清理、冗余工具输出摘要和按需 compaction。
- 自驱动 agent、任务延续、自检和质量闸门。
- MCP、Skills、LSP 的路由和并发优化。
- 知识图谱、RAG、tree-sitter、hashline 这条代码理解链路。
- 中国大陆网络环境下的模型镜像与默认 embedding 回退。
- `opencoded` 单文件打包与本地替换流程。

当前这个包里比较关键的近期变化包括：

- TUI 会话页先加载最近消息，再按页补更早历史。
- `MessageV2.prepareModelContext(...)` 会在不改动真实历史的前提下清理发送给模型的噪声上下文。
- `SessionCompaction` 现在会先看清理后的估算 token，再决定是否压缩。
- 侧栏可以显示 Knowledge Graph 摘要，Modified Files 改成双击进入 `vim -d` 审阅。
- embedding 默认走仓库预设模型，后台优先启动 provider，失败时立即 fallback。

## 本地开发

```bash
bun install
bun run dev
```

## 运行测试

```bash
bun run typecheck
bun test
```

## 当前平台打包

```bash
OPENCODE_VERSION=1.0.0-local bun run script/build.ts --single
./dist/opencode-darwin-arm64/bin/opencoded --version
```

`--single` 只会为当前平台生成 `opencoded`，适合本地替换和分发。

## 进一步说明

仓库级说明、优化背景和完整使用方式见根目录 README。
