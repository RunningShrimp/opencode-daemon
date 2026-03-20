# Daemon Master-Worker 实施计划

## 文档目的

这份文档是对 [daemon-master-worker-architecture.zh-CN.md](./daemon-master-worker-architecture.zh-CN.md) 的执行化展开。

目标不是重复架构定义，而是回答四个问题：

1. 先做什么，后做什么。
2. 每一步改哪些模块。
3. 每一步如何验证。
4. 当前 backlog 应该怎样排优先级。

## 实施原则

### 1. 先建立边界，再迁移流量

不要先把大量业务逻辑搬进新目录，再去想所有权问题。

正确顺序是：

1. 先建立 singleton master、自举协议、运行时标识。
2. 再建立 worker 和 lane 的所有权边界。
3. 最后再切 control/data/inference 流量。

### 2. 保持单文件交付

无论内部进程如何拆分，对用户交付的仍然是单个 `opencoded`。

因此所有实施任务都必须满足：

- master 能从当前二进制自举
- worker 能从当前二进制自举
- ai-runtime 能从当前二进制自举
- 不新增用户需要感知的 companion binary

### 3. 保持 TUI 兼容

第一阶段不得强迫 TUI 直接感知新的 socket/pipe 细节。

当前 `http://opencode.internal` 虚拟地址和本地桥接逻辑应通过兼容适配层保留，直到新的控制面和数据面稳定。

### 4. 每一阶段都必须可回退

每个阶段的切换点都应允许通过 feature flag、内部 mode 或入口分流回退到上一层稳定实现，避免大爆炸迁移。

## 范围与非目标

### 本轮范围

- singleton master 自举与 attach
- project runtime identity 与 worker 监管
- client lane 隔离模型
- toolchain cell 与多语言调度
- control/data/inference 三类通道拆分
- shared artifact 与 AI runtime 上收
- budget shedding 与恢复策略

### 本轮非目标

- 重写现有 session/tool/file 全部业务语义
- 第一阶段就重做全部 TUI 网络层
- 第一阶段就引入复杂远程集群能力
- 一次性替换全部现有启动入口

## 关键设计决策检查点

在真正开工前，需要先冻结以下决策，否则后续实现会不断返工。

### 1. `ProjectRuntimeKey` 的组成边界

必须明确：

- 哪些因素进入 `workerEnvScope`
- 哪些因素只进入 `ToolchainRuntimeProfile.envFingerprint`

最低要求：

- 会影响项目级共享状态的环境差异进入 `workerEnvScope`
- 只影响语言子系统的环境差异进入 `envFingerprint`

### 2. orphan worker 的默认策略

必须先定义新 master 面对孤儿 worker 的默认动作：

- 默认优先 `adopt`
- 还是默认优先 `reap + respawn`

建议：

- 对只承载可恢复共享态的 worker 优先 `adopt`
- 对 epoch 不一致、状态不完整或健康检查失败的 worker 直接 `reap + respawn`

### 3. `serve` 的最终语义

必须冻结 `serve` 在已有 master 存在时的行为：

- 不是再起一个 server
- 而是 attach 到已有 master，并请求开启或重配 public listener

### 4. lane 副作用恢复语义

必须明确副作用请求的最终状态集合：

- `accepted`
- `completed`
- `unknown`
- `partially-applied`

否则恢复阶段无法判断是否安全重试。

## 阶段依赖图

下面的依赖关系应视为硬约束，而不是建议顺序。

| 阶段 | 直接依赖           | 说明                                                |
| ---- | ------------------ | --------------------------------------------------- |
| M0   | 无                 | 冻结名字、标识和 envelope                           |
| M0.5 | M0                 | 兼容桥要依赖冻结后的协议边界                        |
| M1   | M0                 | self-spawn、registry、lock 依赖统一标识             |
| M2   | M1                 | worker supervision 必须建立在 singleton master 之上 |
| M3   | M2                 | lane 必须挂在 worker 之下                           |
| M4   | M2, M3             | toolchain cell 依赖 worker 和 lane 边界已清晰       |
| M5   | M0.5, M2, M3       | 通道拆分必须建立在兼容桥和所有权边界之上            |
| M6   | M5                 | 共享 AI runtime 依赖 transport 稳定                 |
| M7   | M1, M2, M3, M5, M6 | 预算、恢复、对外暴露需要上游所有权与通道都稳定      |

任何跳过这些依赖的施工都应视为高风险改动。

## 灰度与回退策略

计划里已经要求“每阶段可回退”，这里把它具体化。

### 推荐灰度开关

- `OPENCODE_EXPERIMENTAL_DAEMON_MASTER=1`
- `OPENCODE_EXPERIMENTAL_PROJECT_WORKER=1`
- `OPENCODE_EXPERIMENTAL_CLIENT_LANE=1`
- `OPENCODE_EXPERIMENTAL_TOOLCHAIN_CELL=1`
- `OPENCODE_EXPERIMENTAL_CONTROL_RPC=1`
- `OPENCODE_EXPERIMENTAL_AI_RUNTIME=1`

### 推荐灰度方式

每个阶段至少经历三种运行方式：

1. `off`
   - 完全走现有稳定路径
2. `shadow`
   - 新路径只观测、比对、打点，不接管用户流量
3. `on`
   - 新路径正式接管

### 回退原则

- M1 失败：回退到现有本地 server 启动路径
- M2/M3 失败：回退到单进程 keyed state 模式
- M5 失败：保留新所有权模型，但数据仍走旧桥接
- M6 失败：worker 退回本地 embedding fallback

## 成功指标

除了功能验收，还需要一组统一指标判断实施是否真的有效。

### 启动指标

- 第二个本地客户端 attach 延迟显著低于首启
- `serve`/TUI/attach 并发启动时只出现一个 master

### 稳态资源指标

- 同项目多客户端不重复拉起 LSP/watcher/project-memory
- 多项目并发时 AI runtime 常驻数量小于 worker 数量
- 强杀 master 后不存在长期存活的孤儿 worker

### 兼容性指标

- TUI 在 `http://opencode.internal` 语义下保持可用
- 单文件构建产物仍可完成 master/worker/ai-runtime 自举

## 阶段规划

## Milestone 0：冻结接口与标识模型

目标：

- 冻结协议草案，避免后续代码实现边写边改名字。

交付物：

- `NamespaceID`
- `ProjectRuntimeKey`
- `WorkerID`
- `LaneID`
- `ToolchainCellID`
- `LeaseToken`
- `ResumeToken`
- `ProjectRepositoryIdentity`
- `ProjectRuntimeIdentity`
- `ControlEnvelope`
- `workerEnvScope`
- `OrphanAdoptionProtocol`
- `FencingEpoch`

建议落地文件：

- `packages/opencode/src/daemon/protocol/control-envelope.ts`
- `packages/opencode/src/daemon/identity/runtime-key.ts`
- `packages/opencode/src/daemon/identity/project-identity.ts`

验收标准：

- 文档中的接口名和代码中的接口名一致
- `ProjectID` 与 `ProjectRuntimeKey` 被清晰拆分
- 同 repo 不同 worktree 的 runtime key 可稳定区分
- 同 worktree 但不同项目级环境边界的 runtime key 可稳定区分

## Milestone 0.5：先保住 TUI 兼容桥

目标：

- 在真正切换 master/worker 入口之前，先保住当前 TUI 内部传输语义

交付物：

- `VirtualTransportInterceptor` 或等价兼容桥
- `LocalTransportAdapter` 的最小可用版本
- `http://opencode.internal` 到新内部通道的映射层

建议落地文件：

- `packages/opencode/src/daemon/transport/local-transport-adapter.ts`
- `packages/opencode/src/daemon/transport/virtual-transport-interceptor.ts`

验收标准：

- TUI 仍能在不感知 socket/pipe 细节的前提下工作
- 兼容桥不要求 master 主线程中转大体积项目数据

## Milestone 1：实现单文件自举与 singleton master

目标：

- 完成 `discover-or-attach` 基础能力
- 确立“一个 namespace 一个 master”

交付物：

- `SelfSpawner`
- `ServerRegistryStore`
- `ServerBootstrapLock`
- `MasterDiscoveryService`
- `MasterControlApi.health()`
- `MasterSentinel`
- `FencingEpoch` 生成与校验
- `serve -> attach-and-enable-public-listener` 语义

建议落地文件：

- `packages/opencode/src/daemon/bootstrap/self-spawn.ts`
- `packages/opencode/src/daemon/bootstrap/registry.ts`
- `packages/opencode/src/daemon/bootstrap/bootstrap-lock.ts`
- `packages/opencode/src/daemon/bootstrap/discovery.ts`
- `packages/opencode/src/daemon/master/master-daemon.ts`
- `packages/opencode/src/daemon/master/master-sentinel.ts`

建议修改入口：

- `packages/opencode/src/index.ts`
- `packages/opencode/src/cli/cmd/serve.ts`
- `packages/opencode/src/cli/cmd/tui/worker.ts`
- `packages/opencode/src/cli/cmd/tui/attach.ts`

验收标准：

- 并发启动多个本地客户端只产生一个 master
- master 注册表能识别 stale pid 和 stale endpoint
- 已运行 master 下再次启动客户端只 attach，不重复 listen
- 旧 epoch 的 master 即使延迟恢复，也不能重新获得控制权
- 启动选举对“thundering herd”并发启动具备确定性结果
- `serve` 在已有 master 场景下只重配 public listener，不再二次 listen

## Milestone 2：实现 project runtime identity 与 worker supervision

目标：

- 将现有 keyed project state 提升为 worker 边界

交付物：

- `ProjectIdentityResolver`
- `ProjectWorkerDescriptor`
- `ProjectWorkerLeaseRegistry`
- `WorkerSupervisor`
- `OrphanAdoptionCoordinator`
- `WorkerResourceLimits`
- `adopt-vs-reap` 决策规则

建议落地文件：

- `packages/opencode/src/daemon/identity/project-identity.ts`
- `packages/opencode/src/daemon/worker/worker-descriptor.ts`
- `packages/opencode/src/daemon/worker/worker-supervisor.ts`

建议对齐现有实现：

- `packages/opencode/src/project/project.ts`
- `packages/opencode/src/project/instance.ts`
- `packages/opencode/src/server/server.ts`

验收标准：

- 同项目多客户端复用同一个 worker
- 同 repo 不同 worktree 分配不同 worker
- worker 以 `ProjectRuntimeKey` 为主索引，而不是只用 `ProjectID`
- 新 master 启动后可对 orphan worker 做 adopt 或 reap
- adopt 与 reap 的触发条件是可判定、可观测的

## Milestone 3：实现 client lane

目标：

- 将同项目共享态与客户端执行态分离

交付物：

- `ClientLaneDescriptor`
- `LaneController`
- acquire/release/cancel/rebuild/resume 协议
- `RecoveryCoordinator`
- `WorkerResourceArbiter`
- 幂等键与副作用恢复语义
- lane side-effect state machine

建议落地文件：

- `packages/opencode/src/daemon/worker/lane-controller.ts`
- `packages/opencode/src/daemon/protocol/control-events.ts`
- `packages/opencode/src/daemon/protocol/data-events.ts`

验收标准：

- 同项目两个客户端可并行执行且不会串话
- 一个 lane cancel 不会影响另一个 lane
- lane crash 可重建，且 worker 不必整体退出
- 文件写入、VCS 变更、build/debug 槽位由 worker 仲裁，不由 lane 直接竞争
- 每个副作用请求都可返回 `accepted/completed/unknown/partially-applied` 之一

## Milestone 4：实现 toolchain cell

目标：

- 让单项目多语言成为显式调度模型

交付物：

- `ToolchainRuntimeProfile`
- `ToolchainCellDescriptor`
- `ToolchainCellRegistry`
- envFingerprint 归一化逻辑

建议落地文件：

- `packages/opencode/src/daemon/worker/toolchain-cell-registry.ts`
- `packages/opencode/src/daemon/worker/toolchain-profile.ts`

建议对齐现有实现：

- `packages/opencode/src/lsp/index.ts`
- `packages/opencode/src/lsp/server.ts`
- `packages/opencode/src/util/tree-sitter-scope.ts`

验收标准：

- monorepo 内可同时创建多个 language cell
- 一个 lane 可跨多个 cell 协作
- 同语言不同项目绝不共享同一 cell

## Milestone 5：拆 control/data/inference 三类通道

目标：

- 让 master 从业务大负载路径退出

交付物：

- `control-rpc`
- `project-data-stream`
- `ai-inference-stream`
- `LocalTransportAdapter`
- 零拷贝或近零拷贝的大负载传输路径
- `shadow` 模式下的新旧通道双写/比对能力

建议落地文件：

- `packages/opencode/src/daemon/transport/control-rpc.ts`
- `packages/opencode/src/daemon/transport/project-data-stream.ts`
- `packages/opencode/src/daemon/transport/local-transport-adapter.ts`

建议对齐现有实现：

- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/control-plane/workspace-router-middleware.ts`
- `packages/opencode/src/cli/cmd/tui/worker.ts`

验收标准：

- control plane 不再携带 prompt/file/embedding 大负载
- master 稳态下不持有项目消息体
- TUI 仍可通过兼容适配层正常工作
- 大体积文件体和 embedding 结果不会被 master 主线程重复拷贝转发
- 新旧通道在 shadow 模式下结果一致或差异可解释

## Milestone 6：上收共享产物与 AI runtime

目标：

- 统一真正可跨项目共享的重资源所有权

交付物：

- `SharedArtifactRegistry`
- `AIRuntimeSupervisor`
- embedding IPC
- AI runtime fallback 路径

建议落地文件：

- `packages/opencode/src/daemon/ai-runtime/ai-runtime-supervisor.ts`
- `packages/opencode/src/daemon/ai-runtime/ai-runtime-protocol.ts`

建议对齐现有实现：

- `packages/opencode/src/util/module-loader.ts`
- `packages/opencode/src/provider/models-cache.ts`
- `packages/opencode/src/ai/rag/embedding.ts`
- `packages/opencode/src/ai/rag/embedding-bg-service.ts`

验收标准：

- 多 worker 可共享一个 AI runtime
- worker 不再持有 embedding 模型权重
- sidecar 不可用时可自动 fallback

## Milestone 7：实现预算、恢复和 public listener

目标：

- 让系统进入长时运行可控状态

交付物：

- `WorkerMetricsCollector`
- budget shedding 策略
- lane resume/rebuild 规则
- public HTTP listener 附加表面
- worker watchdog / fate-sharing
- `opencode status` 或 `opencode daemon info` 诊断命令
- orphan scan 与 cleanup telemetry

建议落地文件：

- `packages/opencode/src/daemon/master/public-listener.ts`
- `packages/opencode/src/daemon/master/worker-metrics.ts`

验收标准：

- 优先回收 warm-idle worker 和 idle cell
- master 或 worker 崩溃后客户端可自动恢复
- public listener 的启停不影响 local socket attach
- orphan worker 不会在 master 异常退出后长期泄露

## 验证矩阵

每个 milestone 完成时，都至少要覆盖对应场景。

| Milestone | 必测场景                                                    |
| --------- | ----------------------------------------------------------- |
| 0         | 标识模型静态校验、worktree 归一化                           |
| 1         | 多客户端并发启动 master                                     |
| 2         | 同项目多客户端、同 repo 多 worktree                         |
| 3         | 同项目多客户端 cancel/crash/rebuild                         |
| 4         | 单项目多语言、跨 cell 调度                                  |
| 5         | TUI 兼容、workspace 控制流拆分                              |
| 6         | 多项目共享 AI runtime、fallback                             |
| 7         | 内存压力 shedding、master/worker 恢复、public listener 并存 |

### 建议的硬性门禁

- `Z-Gate`：Zero-Leak。启动多个 worker，强杀 master，验证新 master 能 adopt 或 reap 孤儿进程，且不泄露 pid/socket。
- `W-Gate`：Worktree Collision。相同 repo 的两个 worktree 使用不同环境和依赖时，验证 runtime key 与 worker 隔离正确。
- `L-Gate`：Lane Interruption。lane A 长任务被取消或中断时，lane B 在同 worker 下保持稳定。
- `M-Gate`：Migration Parity。新旧运行模型对同一任务的延迟和结果差异保持在可接受范围内。
- `D-Gate`：Daemon Diagnostics。`opencode status` 或等价命令能准确展示 master、worker、lane、cell 数量与状态。
- `S-Gate`：Serve Semantics。已有 master 存在时，`serve` 只重配 public listener，不新增第二个 server。

## Todo List

下面的 todo list 面向真正开工，按优先级排序。

### P0：协议与标识冻结

- [x] 新建 `daemon/protocol` 与 `daemon/identity` 目录
- [x] 落地 `ProjectRuntimeKey` 生成逻辑
- [x] 明确 `ProjectID` 与 `ProjectRuntimeKey` 的职责边界
- [x] 定义 `ControlEnvelope`、`ControlEvent`、`ProjectDataEvent`
- [x] 定义 `workerEnvScope` 与 `FencingEpoch`
- [x] 定义 `OrphanAdoptionProtocol`
- [x] 明确 `workerEnvScope` 与 `envFingerprint` 的分层边界

### P0.5：TUI 兼容桥保活

- [x] 实现 `VirtualTransportInterceptor`
- [x] 为 `http://opencode.internal` 建立新通道映射
- [x] 确保兼容桥不把 master 重新变成大负载转发器

### P1：单文件自举和 master

- [x] 实现 `SelfSpawner`
- [x] 实现 `ServerRegistryStore`
- [x] 实现 `ServerBootstrapLock`
- [x] 实现 `MasterDiscoveryService`
- [x] 给 `serve`、TUI worker、attach 入口接入 `discover-or-attach`
- [x] 实现 `MasterSentinel` 心跳
- [x] 为注册表和锁加入 TTL / fencing 约束
- [x] 将 `serve` 收口为 attach-and-enable-public-listener 语义

### P2：worker 监管

- [x] 实现 `ProjectIdentityResolver`
- [x] 实现 `ProjectWorkerDescriptor`
- [x] 实现 `ProjectWorkerLeaseRegistry`
- [x] 实现 `WorkerSupervisor.ensureWorker`
- [x] 让 worker 以 `ProjectRuntimeKey` 为索引持有项目运行态
- [x] 实现 orphan worker adopt/reap 逻辑
- [x] 定义 worker 资源上限与回收触发条件
- [x] 冻结 `adopt-vs-reap` 判定规则和日志字段

### P3：lane 模型

- [x] 实现 `ClientLaneDescriptor`
- [x] 实现 `LaneController.acquire/release`
- [x] 实现 `LaneController.cancel/rebuild/resume`
- [x] 实现 `RecoveryCoordinator`
- [x] 把 approval/cancel/PTY 所有权收口到 lane
- [x] 实现 `WorkerResourceArbiter`
- [x] 为副作用请求加入幂等键与恢复结果码
- [x] 定义 lane side-effect state machine

### P4：toolchain cell

- [x] 实现 `ToolchainRuntimeProfile`
- [x] 实现 `ToolchainCellDescriptor`
- [x] 实现 `ToolchainCellRegistry.ensure/suspend/recycle`
- [x] 把 LSP/formatter/env 激活收口到 cell
- [x] 建立 envFingerprint 归一化规则

### P5：传输层拆分

- [x] 实现 `control-rpc`
- [x] 实现 `project-data-stream`
- [x] 实现 `LocalTransportAdapter`
- [x] 将 `http://opencode.internal` 兼容桥接到新通道
- [x] 将 workspace control 路由迁回 master
- [x] 为大负载建立零拷贝或近零拷贝路径
- [x] 增加 shadow 模式下的新旧通道比对

### P6：共享产物与 AI runtime

- [x] 实现 `SharedArtifactRegistry`
- [x] 上收 module/model/tree-sitter 协调
- [x] 实现 `AIRuntimeSupervisor`
- [x] 建立 embedding IPC
- [x] 建立 AI runtime fallback 路径

### P7：预算、恢复与对外暴露

- [x] 实现 `WorkerMetricsCollector`
- [x] 实现 warm-idle worker 淘汰
- [x] 实现 idle toolchain cell 回收
- [x] 实现 lane resume/rebuild 协议
- [x] 实现 public listener 附加表面
- [x] 实现 worker watchdog / fate-sharing
- [x] 实现 `opencode status` 或 `opencode daemon info`
- [x] 输出 orphan scan / cleanup telemetry

### P8：验证与收尾

- [x] 为场景 A-G 建立集成验证脚本或测试
- [x] 验证单文件打包后 master/worker/ai-runtime 仍可自举
- [x] 验证 TUI 与 attach 兼容路径
- [x] 更新架构文档与开发文档中的实现状态
- [x] 建立 `Z-Gate`、`W-Gate`、`L-Gate`、`M-Gate`、`D-Gate`
- [x] 建立 `S-Gate`

#### 验证结果 (2026-03-18)

- **单元测试**: 113 个 daemon 测试全部通过
- **Typecheck**: 全部 19 个包类型检查通过
- **P8-Gates 验证**:
  - ✅ Z-Gate (Zero-Leak): daemon-p8-gates.test.ts 通过
  - ✅ W-Gate (Worktree Collision): daemon-p8-gates.test.ts 通过
  - ✅ L-Gate (Lane Interruption): daemon-p8-gates.test.ts 通过
  - ✅ M-Gate (Migration Parity): daemon-p8-gates.test.ts 通过
  - ✅ D-Gate (Daemon Diagnostics): daemon-info-service.test.ts 通过
  - ✅ S-Gate (Serve Semantics): serve-command.test.ts 通过

## 建议的首批施工顺序

如果现在开始写代码，建议按这个最小闭环推进：

1. 先完成 P0，冻结标识、epoch、orphan 协议与 envelope。
2. 紧接着完成 P0.5，先保住 TUI 兼容桥。
3. 再完成 P1，拿到 singleton master 和单文件自举。
4. 再完成 P2，拿到按 `ProjectRuntimeKey` 分配的 worker。
5. 再完成 P3，拿到同项目多客户端的真实隔离。
6. 然后做 P5，先把 control/data 基础通道切出来。
7. 最后再做 P4、P6、P7，把多语言、AI runtime 和预算能力补齐。

原因很简单：

- 没有 singleton master，就没有后续所有权中心。
- 没有 `ProjectRuntimeKey`，worktree 场景会从第一天开始就错。
- 没有 lane，所谓“共享 worker”会很快变成执行态污染。
