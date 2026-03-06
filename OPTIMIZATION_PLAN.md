# OpenCode-Daemon 性能优化方案

> 版本: 1.0  
> 日期: 2026-03-06  
> 状态: 规划中

## 一、优化目标

本优化方案针对 opencode-daemon 在多项目场景下暴露的系统性问题，通过架构重构和代码改进，实现以下目标：

- **内存稳定性**：消除内存泄漏风险，实现内存使用可预测、可控制
- **性能提升**：降低 CPU 使用率，提升响应速度
- **磁盘健康**：防止磁盘空间泄漏，优化 I/O 效率
- **项目隔离**：实现多项目间的资源隔离，防止相互影响
- **代码质量**：消除技术债务，提升可维护性和可测试性

---

## 二、问题优先级矩阵

| 优先级 | 问题数 | 预计工作量 | 风险 |
|--------|--------|------------|------|
| P0 (立即) | 4 | 1-2 周 | 高 |
| P1 (短期) | 8 | 1 个月 | 中 |
| P2 (中期) | 7 | 3 个月 | 低 |

---

## 三、P0 优化项（立即修复）

### 3.1 内存管理：MemoryGuard 回调泄漏

**问题描述**  
`checkMemory()` 每次调用（默认30秒）都注册新的回调函数，导致回调对象持续累积。

**优化方案**

```typescript
// packages/opencode/src/util/memory-guard.ts

// 模块级单例回调引用
let cleanupCallback: (() => void) | null = null

export function checkMemory(): void {
  const pressure = getCurrentPressure()

  // 只注册一次回调
  if (!cleanupCallback) {
    cleanupCallback = async () => {
      log.info("Instance memory budget triggered cleanup")
      if (typeof global.gc === "function") {
        global.gc()
      }
    }
    globalInstanceBudget.onCleanup(cleanupCallback)
  }

  // ... 其余逻辑保持不变
}
```

**预期效果**  
- 消除回调对象累积
- 内存使用更稳定

---

### 3.2 磁盘管理：日志清理逻辑修复

**问题描述**  
日志清理条件 `files.length <= 5` 与保留10个文件的目标存在逻辑错误。

**优化方案**

```typescript
// packages/opencode/src/util/log.ts

const MAX_LOG_FILES = 5  // 明确常量

async function cleanup(dir: string) {
  const files = await Glob.scan("????-??-??T??????.log", {
    cwd: dir,
    absolute: true,
    include: "file",
    sorted: true,  // 按时间排序
  })

  if (files.length <= MAX_LOG_FILES) return

  const filesToDelete = files.slice(0, -MAX_LOG_FILES)
  await Promise.all(
    filesToDelete.map((file) => fs.unlink(file).catch(() => {}))
  )
}
```

**额外优化**  
将日志清理从 `init()` 移至定时任务：

```typescript
// 启动时只清理一次，后续由定时任务处理
let cleanupTask: ReturnType<typeof setInterval> | null = null

export async function init(options: Options) {
  if (options.level) level = options.level

  // 启动时清理一次
  await cleanup(Global.Path.log)

  // 每小时清理一次
  cleanupTask = setInterval(() => {
    cleanup(Global.Path.log).catch((e) => log.error("log cleanup failed", { error: e }))
  }, 60 * 60 * 1000)
}
```

---

### 3.3 网络通信：MCP 超时默认值

**问题描述**  
`convertMcpTool` 的 `timeout` 参数可能为 `undefined`，导致请求无限挂起。

**优化方案**

```typescript
// packages/opencode/src/mcp/index.ts

const DEFAULT_TOOL_TIMEOUT = 30_000  // 30 秒

async function convertMcpTool(
  mcpTool: MCPToolDef,
  client: MCPClient,
  serverType: "local" | "remote",
  timeout: number = DEFAULT_TOOL_TIMEOUT,  // 添加默认值
): Promise<Tool> {
  // ... 实现保持不变
}
```

---

### 3.4 网络通信：LSP 协议关闭流程

**问题描述**  
LSP 客户端直接杀死进程，未遵循规范的 shutdown/exit 流程。

**优化方案**

```typescript
// packages/opencode/src/lsp/client.ts

async shutdown() {
  l.info("shutting down lsp client")

  try {
    // 1. 发送 shutdown 请求
    await withTimeout(
      connection.sendRequest("shutdown", {}),
      5000
    ).catch(() => {})

    // 2. 发送 exit 通知
    connection.sendNotification("exit", {})

    // 3. 等待进程优雅退出
    await new Promise((resolve) => setTimeout(resolve, 500))
  } catch (e) {
    l.warn("error during lsp shutdown", { error: e })
  }

  // 4. 强制关闭连接
  connection.end()
  connection.dispose()

  // 5. 如果进程仍未退出，强制终止
  try {
    input.server.process.kill()
  } catch {
    // 进程可能已经退出
  }

  l.info("lsp client shutdown complete")
}
```

---

## 四、P1 优化项（短期，1个月）

### 4.1 内存管理：Session diffs 优化

**问题描述**  
`summary_diffs` 存储完整文件内容，单个 session 即可占用数 GB 内存。

**优化方案**

```typescript
// packages/opencode/src/snapshot/index.ts

// 新的 FileDiff 类型，只存储 diff 信息
export const FileDiffSummary = z.object({
  file: z.string(),
  additions: z.number(),
  deletions: z.number(),
  status: z.enum(["added", "deleted", "modified"]).optional(),
})

// 按需加载完整内容的函数
export async function getDiffContent(
  projectId: string,
  file: string,
  side: "before" | "after"
): Promise<string> {
  // 从 git 对象存储按需加载
  const git = path.join(Global.Path.data, "snapshot", projectId)
  return await $`git -C ${git} show ${side}:${file}`.text()
}

// session.sql.ts 修改
summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiffSummary[]>(),
```

---

### 4.2 内存管理：预算管理器限制

**问题描述**  
`InstanceMemoryBudgetManager` 无限创建新实例。

**优化方案**

```typescript
// packages/opencode/src/util/instance-memory-budget.ts

const MAX_BUDGET_INSTANCES = 100

class InstanceMemoryBudgetManager {
  private budgets = new Map<string, InstanceMemoryBudget>()
  private accessOrder: string[] = []  // LRU 追踪

  getOrCreate(id: string): InstanceMemoryBudget {
    // 命中缓存
    if (this.budgets.has(id)) {
      this.updateAccessOrder(id)
      return this.budgets.get(id)!
    }

    // 超过限制，清理最老的实例
    if (this.budgets.size >= MAX_BUDGET_INSTANCES) {
      const oldestId = this.accessOrder.shift()
      if (oldestId) {
        this.budgets.delete(oldestId)
      }
    }

    const budget = new InstanceMemoryBudget()
    this.budgets.set(id, budget)
    this.accessOrder.push(id)
    return budget
  }

  private updateAccessOrder(id: string): void {
    const index = this.accessOrder.indexOf(id)
    if (index > -1) {
      this.accessOrder.splice(index, 1)
      this.accessOrder.push(id)
    }
  }
}
```

---

### 4.3 项目隔离：LSP 缓存添加项目前缀

**问题描述**  
不同项目的同名文件返回错误缓存。

**优化方案**

```typescript
// packages/opencode/src/lsp/index.ts

// 项目级缓存键生成
function makeCacheKey(projectRoot: string, file: string, ...parts: (string | number)[]): string {
  // 使用项目根目录的相对路径作为前缀
  const relativePath = path.relative(projectRoot, file)
  return [relativePath, ...parts].join(":")
}

// 修改缓存调用
const cacheKey = makeCacheKey(
  Instance.directory,  // 项目根目录
  input.file,
  input.line,
  input.character
)
const cached = hoverCache.get(cacheKey)
```

---

### 4.4 项目隔离：LSP 进程池 per-project 限制

**问题描述**  
`maxSize: 50` 是所有项目的总和，不是 per-project 限制。

**优化方案**

```typescript
// packages/opencode/src/lsp/pool.ts

const PER_PROJECT_LIMIT = 10

class LSPProcessPool extends ResourcePool<LSPPoolEntry> {
  // 项目进程计数
  private projectCounts = new Map<string, number>()

  private canAllocate(projectRoot: string): boolean {
    const current = this.projectCounts.get(projectRoot) || 0
    return current < PER_PROJECT_LIMIT
  }

  private incrementProject(projectRoot: string): void {
    const current = this.projectCounts.get(projectRoot) || 0
    this.projectCounts.set(projectRoot, current + 1)
  }

  private decrementProject(projectRoot: string): void {
    const current = this.projectCounts.get(projectRoot) || 0
    this.projectCounts.set(projectRoot, Math.max(0, current - 1))
  }

  override async acquire(key: string): Promise<LSPPoolEntry> {
    const projectRoot = this.extractProjectRoot(key)
    if (!this.canAllocate(projectRoot)) {
      throw new Error(`Project ${projectRoot} has reached LSP process limit (${PER_PROJECT_LIMIT})`)
    }
    this.incrementProject(projectRoot)
    // ... 其余逻辑
  }

  override release(entry: LSPPoolEntry): void {
    super.release(entry)
    this.decrementProject(this.extractProjectRoot(entry.key))
  }

  private extractProjectRoot(key: string): string {
    // 从键中提取项目根目录
    const parts = key.split(":")
    return parts[1] || "default"
  }
}
```

---

### 4.5 并发限制：全局请求限制器

**问题描述**  
没有全局并发限制，可能导致资源耗尽。

**优化方案**

```typescript
// packages/opencode/src/util/concurrency-limiter.ts

export class ConcurrencyLimiter {
  private waitQueue: Array<() => void> = []
  private activeCount = 0

  constructor(
    private maxConcurrent: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++
      try {
        return await fn()
      } finally {
        this.activeCount--
        this.processQueue()
      }
    }

    // 加入等待队列
    return new Promise((resolve, reject) => {
      this.waitQueue.push(async () => {
        try {
          const result = await fn()
          resolve(result)
        } catch (e) {
          reject(e)
        } finally {
          this.activeCount--
          this.processQueue()
        }
      })
    })
  }

  private processQueue(): void {
    if (this.waitQueue.length > 0 && this.activeCount < this.maxConcurrent) {
      this.activeCount++
      const next = this.waitQueue.shift()!
      next()
    }
  }
}

// 全局限制器实例
export const globalLspLimiter = new ConcurrencyLimiter(50)  // 最多 50 个并发 LSP 请求
export const globalMcpLimiter = new ConcurrencyLimiter(30) // 最多 30 个并发 MCP 请求
```

---

### 4.6 CPU 性能：消除高频 JSON.stringify

**问题描述**  
每个 token 产生时都进行 JSON.stringify 比较。

**优化方案**

```typescript
// packages/opencode/src/session/processor.ts

import fastDeepEqual from "fast-deep-equal"

// 替代 JSON.stringify 比较
if (
  lastThree.length === DOOM_LOOP_THRESHOLD &&
  lastThree.every(
    (p) =>
      p.type === "tool" &&
      p.tool === value.toolName &&
      p.state.status !== "pending" &&
      fastDeepEqual(p.state.input, value.input)  // 使用结构化比较
  )
) {
  // ... 检测逻辑
}
```

---

### 4.7 磁盘I/O：Snapshot 增量 track

**问题描述**  
每次 `track()` 都执行全量 `git add .`。

**优化方案**

```typescript
// packages/opencode/src/snapshot/index.ts

const track = debounce(async () => {
  const git = gitdir()

  // 只添加已修改的文件
  await $`git -C ${git} add -u`.quiet()

  // 添加新文件（排除忽略的）
  await $`git -C ${git} add . --no-ignore-add`.quiet()
}, 1000)

// 或者更简单的方案：使用 --only 模式
const track = debounce(async () => {
  const git = gitdir()

  // 只 track 实际变化的文件
  const changedFiles = await $`git -C ${git} diff --name-only --no-color`.text()
  const newFiles = await $`git -C ${git} ls-files --others --exclude-standard`.text()

  const allFiles = [...changedFiles.split("\n"), ...newFiles.split("\n")].filter(Boolean)

  for (const file of allFiles.slice(0, 100)) {  // 每次最多处理 100 个
    await $`git -C ${git} add ${file}`.quiet()
  }
}, 1000)
```

---

### 4.8 缓存策略：实现 LRU 驱逐

**问题描述**  
当前使用简单 FIFO，不是真正的 LRU。

**优化方案**

```typescript
// packages/opencode/src/util/cache.ts

export class LRUCache<T> {
  private cache = new Map<string, T>()

  constructor(
    private maxSize: number,
    private ttl: number,
  ) {}

  set(key: string, value: T): void {
    // 如果键已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // 如果达到最大容量，删除最老的
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    // 添加新键
    this.cache.set(key, value)
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key)
    if (!value) return undefined

    // 访问后移到末尾（实现 LRU）
    this.cache.delete(key)
    this.cache.set(key, value)

    return value
  }
}
```

---

## 五、P2 优化项（中期，3个月）

### 5.1 代码质量：消除 as any

**目标**  
将 40+ 处 `as any` 减少到 5 处以下（仅限无法获取正确类型的极端场景）。

**方案**  
1. 为第三方库创建类型适配器模块
2. 使用 `zod` 进行运行时类型验证
3. 添加 `@ts-expect-error` 并附带说明注释

---

### 5.2 架构改进：依赖注入

**目标**  
为 `processor.ts` 引入依赖注入，提高可测试性。

**方案**

```typescript
// interfaces.ts

interface ILlmClient {
  stream(input: StreamInput): AsyncIterable<StreamEvent>
}

interface ISessionClient {
  updatePart(part: Part): Promise<void>
  updateMessage(msg: Message): Promise<void>
}

interface IFileSystem {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
}

// processor.ts

interface ProcessorDependencies {
  llm: ILlmClient
  session: ISessionClient
  fs: IFileSystem
  config: ProcessorConfig
}

function createProcessor(
  input: CreateInput,
  deps: ProcessorDependencies
) {
  // 使用 deps.llm.stream() 而非直接调用 LLM.stream()
  // ...
}
```

---

### 5.3 连接池：实际使用 ConnectionPool

**目标**  
集成已定义但未使用的 `ConnectionPool` 类。

**方案**  
在 `getClients` 中使用连接池管理 LSP 客户端连接。

---

### 5.4 配置集中管理

**目标**  
将分散的配置集中到统一配置系统。

**方案**

```typescript
// packages/opencode/src/config/timeouts.ts

export const TIMEOUTS = {
  mcp: {
    connect: 30_000,
    toolCall: 30_000,
    auth: 60_000,
  },
  lsp: {
    initialize: 45_000,
    hover: 10_000,
    definition: 10_000,
    references: 15_000,
    workspaceSymbol: 15_000,
    diagnostics: 3_000,
    shutdown: 5_000,
  },
  retry: {
    maxAttempts: 3,
    baseDelay: 2_000,
    maxDelay: 30_000,
    jitter: 0.1,
  },
  limits: {
    maxConcurrentLsp: 50,
    maxConcurrentMcp: 30,
    maxLspPerProject: 10,
    maxBudgetInstances: 100,
    maxLogFiles: 5,
  }
}
```

---

### 5.5 错误处理统一框架

**目标**  
建立统一的错误分类和处理策略。

**方案**

```typescript
// packages/opencode/src/error/errors.ts

export class OpenCodeError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public severity: "low" | "medium" | "high" | "critical",
    public retryable: boolean,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = "OpenCodeError"
  }
}

export enum ErrorCode {
  // MCP 相关
  MCP_CONNECTION_FAILED = "MCP_CONNECTION_FAILED",
  MCP_TIMEOUT = "MCP_TIMEOUT",
  MCP_AUTH_FAILED = "MCP_AUTH_FAILED",

  // LSP 相关
  LSP_INIT_FAILED = "LSP_INIT_FAILED",
  LSP_CRASHED = "LSP_CRASHED",

  // 内存相关
  MEMORY_CRITICAL = "MEMORY_CRITICAL",
  MEMORY_EXHAUSTED = "MEMORY_EXHAUSTED",

  // 通用
  UNKNOWN = "UNKNOWN",
}

// 错误处理中间件
export function withErrorHandling<T>(
  operation: () => Promise<T>,
  context: OperationContext
): Promise<T> {
  try {
    return operation()
  } catch (error) {
    if (error instanceof OpenCodeError) {
      // 已分类错误，按策略处理
      if (error.retryable && context.retryEnabled) {
        return retry(operation, context)
      }
    }

    // 未知错误，包装后重新抛出
    throw new OpenCodeError(
      String(error),
      ErrorCode.UNKNOWN,
      "high",
      true,
      { originalError: String(error), context }
    )
  }
}
```

---

### 5.6 测试覆盖增强

**目标**  
提高核心模块的测试覆盖率。

**方案**

| 模块 | 目标覆盖率 | 测试类型 |
|------|------------|----------|
| memory-guard | 90% | 单元测试 |
| instance-memory-budget | 90% | 单元测试 |
| cache | 85% | 单元测试 |
| retry | 90% | 单元测试 |
| concurrency-limiter | 95% | 单元测试 |
| lsp/client | 70% | 集成测试 |
| mcp/client | 70% | 集成测试 |

---

### 5.7 监控与可观测性

**目标**  
添加关键指标监控。

**方案**

```typescript
// packages/opencode/src/util/metrics.ts

export const metrics = {
  // 内存指标
  memory: {
    heapUsed: new Gauge("memory_heap_used_bytes"),
    heapTotal: new Gauge("memory_heap_total_bytes"),
    external: new Gauge("memory_external_bytes"),
  },

  // LSP 指标
  lsp: {
    activeClients: new Gauge("lsp_active_clients"),
    processPoolSize: new Gauge("lsp_process_pool_size"),
    requestDuration: new Histogram("lsp_request_duration_seconds"),
    requestErrors: new Counter("lsp_request_errors_total"),
  },

  // MCP 指标
  mcp: {
    activeConnections: new Gauge("mcp_active_connections"),
    toolCallDuration: new Histogram("mcp_tool_call_duration_seconds"),
    toolCallErrors: new Counter("mcp_tool_call_errors_total"),
  },

  // 项目隔离指标
  projects: {
    activeCount: new Gauge("projects_active_count"),
    memoryPerProject: new Gauge("projects_memory_bytes", { labelNames: ["projectId"] }),
    lspPerProject: new Gauge("projects_lsp_processes", { labelNames: ["projectId"] }),
  },
}
```

---

## 六、验证与回滚

### 6.1 验证方案

| 优化项 | 验证方法 | 成功标准 |
|--------|----------|----------|
| MemoryGuard 修复 | 长时间运行测试 | 回调数量不再增长 |
| 日志清理修复 | 检查日志目录 | 最多保留 5 个文件 |
| MCP 超时 | 模拟超时场景 | 30 秒后正确超时 |
| LSP 关闭流程 | 检查进程退出日志 | 先 shutdown 后 exit |
| 预算限制 | 创建 150+ 实例 | 保持最多 100 个 |
| LRU 缓存 | 单元测试 | 访问后移到末尾 |
| 并发限制 | 压力测试 | 超过限制进入队列 |

### 6.2 回滚方案

每个 P0/P1 优化项在实施前需：

1. 创建对应的 git 分支
2. 编写完整的单元测试
3. 在 staging 环境验证 3 天
4. 准备回滚脚本

---

## 七、里程碑

| 里程碑 | 内容 | 预计完成 |
|--------|------|----------|
| M1 | P0 优化项全部完成 | 2 周 |
| M2 | P1 优化项全部完成 | 6 周 |
| M3 | P2 优化项完成 50% | 10 周 |
| M4 | P2 优化项全部完成 | 14 周 |

---

## 八、风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| P0 改动引入新 bug | 中 | 高 | 充分测试 + 回滚方案 |
| 性能提升不明显 | 低 | 中 | 持续监控 + 调整参数 |
| 项目隔离影响现有功能 | 中 | 高 | 充分测试 + 特性开关 |
| 依赖注入改造工作量大 | 高 | 中 | 分步实施 + 渐进迁移 |

---

## 九、附录

### A. 相关文件列表

```
packages/opencode/src/util/memory-guard.ts
packages/opencode/src/util/instance-memory-budget.ts
packages/opencode/src/util/log.ts
packages/opencode/src/util/cache.ts
packages/opencode/src/session/processor.ts
packages/opencode/src/snapshot/index.ts
packages/opencode/src/lsp/index.ts
packages/opencode/src/lsp/client.ts
packages/opencode/src/lsp/pool.ts
packages/opencode/src/mcp/index.ts
```

### B. 参考资料

- LSP 规范: https://microsoft.github.io/language-server-protocol/
- MCP 规范: https://spec.modelcontextprotocol.io/
- Node.js 性能最佳实践: https://nodejs.org/en/docs/guides/

---

## 十、TUI 模块专项优化

> 基于 2026-03-06 深度代码审查

### 10.1 问题总览

| 严重程度 | 数量 | 预计工作量 | 风险 |
|----------|------|------------|------|
| Critical | 3 | 3-5天 | 高 |
| Important | 9 | 2周 | 中 |
| Medium | 9 | 3周 | 低 |

---

### 10.2 Critical 优化项（立即修复）

#### 10.2.1 事件监听器内存泄漏

**问题描述**  
SDK 事件监听器在组件挂载时注册，但从未在组件卸载时移除，导致内存泄漏和处理器重复执行。

**影响文件**  
- `routes/session/index.tsx` 行 212-226
- `component/prompt/index.tsx` 行 99-109
- `context/sync.tsx` 行 107-344

**优化方案**

```typescript
// 在组件内使用 onCleanup 清理
import { onCleanup } from "solid-js"

// routes/session/index.tsx
const handleMessagePartUpdated = (evt: Event) => {
  // handler logic
}

onMount(() => {
  sdk.event.on("message.part.updated", handleMessagePartUpdated)
})

onCleanup(() => {
  sdk.event.off("message.part.updated", handleMessagePartUpdated)
})
```

**验收标准**  
- [ ] 组件卸载后事件监听器被正确移除
- [ ] 长时间运行不会累积监听器

---

#### 10.2.2 命令注入风险

**问题描述**  
`clipboard.ts` 中 `osascript` 命令使用模板字符串直接插入文件路径，可能被特殊字符破坏。

**影响文件**  
- `util/clipboard.ts` 行 36

**优化方案**

```typescript
// 使用安全的参数转义
import { quote } from "shell-escape"

const safeTmpfile = quote(tmpfile)
await $`osascript -e 'set fileRef to open for access POSIX file ${safeTmpfile}'`
```

**验收标准**  
- [ ] 特殊字符路径不会导致命令执行错误
- [ ] 通过安全测试用例

---

#### 10.2.3 Keybind timeout 未清理

**问题描述**  
`keybind.tsx` 中 leader 模式的 timeout 在组件销毁时未清理。

**影响文件**  
- `context/keybind.tsx` 行 29-41

**优化方案**

```typescript
import { onCleanup } from "solid-js"

let timeout: NodeJS.Timeout

onCleanup(() => {
  if (timeout) clearTimeout(timeout)
})
```

**验收标准**  
- [ ] 应用退出时 timeout 回调不再执行

---

### 10.3 Important 优化项（短期，2周）

#### 10.3.1 Provider 嵌套过深

**问题描述**  
`app.tsx` 中 18 层 Provider 嵌套导致难以追踪数据流和调试。

**影响文件**  
- `app.tsx` 行 139-180

**优化方案**

```typescript
// 拆分 Provider 组合
function CoreProviders(props: Props) {
  return (
    <ArgsProvider {...props.args}>
      <ExitProvider onExit={props.onExit}>
        <KVProvider>
          <RouteProvider>
            <TuiConfigProvider config={props.config} />
            <SDKProvider />
          </RouteProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  )
}

function UIProviders(props: Props) {
  return (
    <ToastProvider>
      <ThemeProvider>
        <LocalProvider>
          <KeybindProvider>
            {props.children}
          </LocalProvider>
        </ThemeProvider>
      </ToastProvider>
    </ToastProvider>
  )
}

function FeatureProviders(props: Props) {
  return (
    <SyncProvider>
      <PromptStashProvider>
        <DialogProvider>
          <CommandProvider>
            <FrecencyProvider>
              <PromptHistoryProvider>
                <PromptRefProvider>
                  {props.children}
                </PromptRefProvider>
              </PromptHistoryProvider>
            </FrecencyProvider>
          </CommandProvider>
        </DialogProvider>
      </PromptStashProvider>
    </SyncProvider>
  )
}
```

**验收标准**  
- [ ] Provider 嵌套层级减少到 5 层以内
- [ ] 组件重构更加容易

---

#### 10.3.2 sync.tsx 状态管理过于庞大

**问题描述**  
单一 store 包含 21 个不同数据域，每次任何字段更新都触发大量计算。

**影响文件**  
- `context/sync.tsx` 行 35-103

**优化方案**

```typescript
// 拆分为多个独立 Context
export const ProvidersContext = createSimpleContext({
  name: "Providers",
  init: () => createStore({ /* provider 相关状态 */ }),
})

export const SessionContext = createSimpleContext({
  name: "Session",
  init: () => createStore({ /* session 相关状态 */ }),
})

export const MessagesContext = createSimpleContext({
  name: "Messages",
  init: () => createStore({ /* message 相关状态 */ }),
})

export const SystemStatusContext = createSimpleContext({
  name: "SystemStatus",
  init: () => createStore({ /* LSP/MCP/Formatter 状态 */ }),
})
```

**验收标准**  
- [ ] 状态更新不再触发无关计算
- [ ] 内存使用更加可预测

---

#### 10.3.3 调试日志残留

**问题描述**  
多处 `console.log` 未清理，影响生产环境可观测性。

**影响文件**  
- `route.tsx` 行 34: `console.log("navigate", route)`
- `theme.tsx` 行 320, 326: `console.log("resolveSystemTheme")`, `console.log(colors.palette)`
- `sync.tsx` 行 350: `console.log("bootstrapping")`
- `app.tsx` 行 261: `console.log(JSON.stringify(route.data))`

**优化方案**

```typescript
// 使用统一的日志模块
import { log } from "../../util/log"

log.debug("navigate", { route })

// 或使用条件编译
const DEBUG = process.env.NODE_ENV === "development"
if (DEBUG) {
  console.log("navigate", route)
}
```

**验收标准**  
- [ ] 生产环境无调试日志输出

---

#### 10.3.4 主题静态导入所有文件

**问题描述**  
35 个主题文件全部静态导入，增加启动时间。

**影响文件**  
- `context/theme.tsx` 行 6-38

**优化方案**

```typescript
// 动态导入主题
const themeCache = new Map<string, Theme>()

export async function loadTheme(name: string): Promise<Theme> {
  if (themeCache.has(name)) {
    return themeCache.get(name)!
  }

  const themeModule = await import(`./theme/${name}.json`, { with: { type: "json" } })
  const theme = themeModule.default as Theme
  themeCache.set(name, theme)
  return theme
}

// 内置主题仍然静态导入
import aura from "./theme/aura.json" with { type: "json" }
import ayu from "./theme/ayu.json" with { type: "json" }

const BUILTIN_THEMES = { aura, ayu /* ... */ }

export function getTheme(name: string): Theme {
  if (name in BUILTIN_THEMES) {
    return BUILTIN_THEMES[name as keyof typeof BUILTIN_THEMES]
  }
  return loadTheme(name) // 动态加载自定义主题
}
```

**验收标准**  
- [ ] 启动时只加载内置主题
- [ ] 自定义主题按需加载

---

#### 10.3.5 Footer setTimeout 未使用 unref

**问题描述**  
可能导致进程意外退出。

**影响文件**  
- `routes/session/footer.tsx` 行 27-50

**优化方案**

```typescript
timeout = setTimeout(() => {
  tick()
  // ...
}.unref())
```

**验收标准**  
- [ ] 定时器不会阻止进程退出

---

#### 10.3.6 竞态条件：selection.ts

**问题描述**  
`clearSelection()` 在 `copy()` 完成前执行，失败时体验差。

**影响文件**  
- `util/selection.ts` 行 14-23

**优化方案**

```typescript
export async function copy(renderer: Renderer, toast: Toast): Promise<boolean> {
  const text = renderer.getSelection()?.getSelectedText()
  if (!text) return false

  try {
    await Clipboard.copy(text)
    renderer.clearSelection()
    toast.show({ message: "Copied to clipboard", variant: "info" })
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}
```

**验收标准**  
- [ ] 复制失败时保留选择状态

---

#### 10.3.7 输出内容未转义

**问题描述**  
markdown 特殊字符未转义，破坏输出格式。

**影响文件**  
- `util/transcript.ts` 行 85-88

**优化方案**

```typescript
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
}

if (options.toolDetails && part.state.status === "completed" && part.state.output) {
  const escapedOutput = escapeMarkdown(part.state.output)
  result += `\n**Output:**\n\`\`\`\n${escapedOutput}\n\`\`\`\n`
}
```

**验收标准**  
- [ ] 特殊字符正确转义

---

#### 10.3.8 数组索引检查不准确

**问题描述**  
`filter` 检查不能正确判断数组连续性。

**影响文件**  
- `util/terminal.ts` 行 77-78

**优化方案**

```typescript
if (Object.keys(paletteColors).length === 16) {
  cleanup()
}
```

**验收标准**  
- [ ] 正确检查颜色数量

---

#### 10.3.9 WSL 检测不准确

**问题描述**  
使用 `release().includes("WSL")` 检测 WSL 不可靠。

**影响文件**  
- `util/clipboard.ts` 行 47

**优化方案**

```typescript
function isWSL(): boolean {
  if (os !== "win32") return false
  if (process.env.WSL_DISTRO_NAME) return true

  try {
    const version = await $`uname -r`.text()
    return version.toLowerCase().includes("microsoft") || version.toLowerCase().includes("wsl")
  } catch {
    return false
  }
}
```

**验收标准**  
- [ ] WSL2 正确检测

---

### 10.4 Medium 优化项（中期，3周）

#### 10.4.1 Prompt 组件过大

**问题描述**  
`prompt/index.tsx` 超过 1100 行，承担过多职责。

**优化方案**  
拆分为：
- `usePromptCommands()` - 命令注册 hook
- `usePromptKeybindings()` - 快捷键处理
- `usePromptPaste()` - 粘贴处理
- `PromptStatusBar` - 状态显示组件

---

#### 10.4.2 重复状态逻辑

**问题描述**  
Binary.search 模式在多处重复出现。

**优化方案**  
提取为 `useReconciledStore` 工具 hook。

---

#### 10.4.3 缺少类型严格

**问题描述**  
多处使用 `Record<string, any>` 和 `as any`。

**优化方案**  
完善类型定义，减少 any 使用。

---

#### 10.4.4 事件队列无上限

**问题描述**  
`sdk.tsx` 高频事件时内存可能无限增长。

**优化方案**  
添加队列上限和背压处理。

---

#### 10.4.5 组件错误边界缺失

**问题描述**  
异步 effect 无错误边界。

**优化方案**  
添加错误边界组件。

---

#### 10.4.6 外部命令无超时

**问题描述**  
clipboard 外部命令可能永久挂起。

**优化方案**  
添加超时机制。

---

#### 10.4.7 数组 Proxy 性能

**问题描述**  
`theme.tsx` 中 `values()` 每次创建新对象。

**优化方案**  
缓存 Proxy 对象。

---

#### 10.4.8 输入验证缺失

**问题描述**  
transcript 函数未验证输入参数。

**优化方案**  
添加参数验证。

---

#### 10.4.9 Scheduled 对象未清理

**问题描述**  
signal.ts 中 debounced signal 可能泄漏。

**优化方案**  
提供清理函数。

---

### 10.5 TUI 优化验证清单

| 优化项 | 验证方法 | 成功标准 |
|--------|----------|----------|
| 事件监听器泄漏 | 长时间运行测试 | 监听器数量稳定 |
| 命令注入 | 特殊路径测试 | 命令正确执行 |
| Keybind 清理 | 退出测试 | 无残留回调 |
| Provider 嵌套 | 代码审查 | 层级 ≤ 5 |
| 状态拆分 | 性能分析 | 无关更新减少 |
| 调试日志 | 生产日志检查 | 无 console.log |
| 主题懒加载 | 启动时间测量 | 减少 ≥ 30% |
| 竞态条件 | 失败场景测试 | 状态正确保留 |
| Markdown 转义 | 特殊字符测试 | 输出正确 |

---

### 10.6 TUI 优化里程碑

| 里程碑 | 内容 | 预计完成 |
|--------|------|----------|
| M1-TUI | Critical 优化项完成 | 1周 |
| M2-TUI | Important 优化项完成 | 3周 |
| M3-TUI | Medium 优化项完成 | 6周 |

---

### 10.7 相关文件索引

```
# Critical
packages/opencode/src/cli/cmd/tui/routes/session/index.tsx
packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
packages/opencode/src/cli/cmd/tui/util/clipboard.ts
packages/opencode/src/cli/cmd/tui/context/keybind.tsx

# Important
packages/opencode/src/cli/cmd/tui/app.tsx
packages/opencode/src/cli/cmd/tui/context/sync.tsx
packages/opencode/src/cli/cmd/tui/context/theme.tsx
packages/opencode/src/cli/cmd/tui/context/route.tsx
packages/opencode/src/cli/cmd/tui/util/selection.ts
packages/opencode/src/cli/cmd/tui/util/terminal.ts

# Medium
packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx
packages/opencode/src/cli/cmd/tui/context/sdk.tsx
packages/opencode/src/cli/cmd/tui/util/transcript.ts
packages/opencode/src/cli/cmd/tui/util/signal.ts
```

---

*本文档将随 TUI 优化实施持续更新*
