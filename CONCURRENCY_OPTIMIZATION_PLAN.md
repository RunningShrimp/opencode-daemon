# OpenCode-Daemon 并发优化实施计划

## 概述

本文档详细描述了针对 opencode-daemon 项目中多 agent 并发运行相关问题的完整修复方案。基于深度代码审查，我们发现了以下关键问题类别：

1. **并发控制与调度** - ConcurrencyLimiter 竞态条件、AsyncQueue 线程不安全
2. **内存管理与隔离** - 全局内存预算无隔离、TurnController 泄漏
3. **事件系统** - Bus 错误事件无人订阅

---

## 问题清单与修复方案

### 问题 1: ConcurrencyLimiter 竞态条件 [P0]

**文件**: `packages/opencode/src/util/concurrency-limiter.ts`

**问题描述**: 
- 第 53-62 行存在经典的 check-then-act 竞态条件
- `activeCount` 检查和增加之间没有原子性保证

**修复方案**: 
- 使用 Mutex 模式实现真正的信号量
- 确保检查和增加操作的原子性

```typescript
// 修复后的核心逻辑
private _mutex = false

async run<T>(fn: () => Promise<T>): Promise<T> {
  // 等待获取锁
  while (this._mutex) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  this._mutex = true
  
  try {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++
      // ... 执行任务
    } else {
      // 排队等待
    }
  } finally {
    this._mutex = false
  }
}
```

---

### 问题 2: AsyncQueue 线程不安全 [P0]

**文件**: `packages/opencode/src/util/queue.ts`

**问题描述**:
- `push()` 和 `next()` 方法中的 `shift()` 和 `push()` 操作不是原子的
- 多线程并发调用可能导致状态不一致

**修复方案**:
- 添加 `AsyncMutex` 保护队列操作
- 确保 push 和 next 的互斥执行

---

### 问题 3: drainQueue 实现不完整 [P0]

**文件**: `packages/opencode/src/util/concurrency-limiter.ts:128-138`

**问题描述**:
- 当前实现只是从队列中移除元素，但不 reject/resolve Promise
- 导致等待的 Promise 永远悬空，造成内存泄漏

**修复方案**:
- 重构队列元素为 `{ promise: Promise, resolve, reject }` 结构
- drainQueue 时正确调用所有 reject

---

### 问题 4: processQueue 递归风险 [P1]

**文件**: `packages/opencode/src/util/concurrency-limiter.ts:85-92`

**问题描述**:
- 在 finally 块中同步调用 processQueue 可能导致嵌套执行
- 快速完成的任务可能触发栈溢出

**修复方案**:
- 使用 `queueMicrotask` 替代同步调用
- 添加最大递归深度检查

---

### 问题 5: Subagent 全局并发限制 [P1]

**文件**: `packages/opencode/src/tool/task.ts`

**问题描述**:
- 每个 task 工具调用创建新的 session，无全局并发限制
- 用户可通过 prompt 触发无限数量的 subagent

**修复方案**:
- 添加 `TaskLimiter` 全局限制器
- 限制同时运行的 subagent 数量

---

### 问题 6: TurnController 内存泄漏 [P1]

**文件**: `packages/opencode/src/util/dynamic-turn-control.ts:280-295`

**问题描述**:
- `Manager.controllers` Map 永不自动清理
- Session 结束后 controller 仍保留在内存中

**修复方案**:
- 添加 TTL 机制自动过期
- 添加 LRU 淘汰策略
- 在 session 结束时显式调用清理

---

### 问题 7: Bus 错误事件无人订阅 [P2]

**文件**: `packages/opencode/src/session/index.ts:207-213`

**问题描述**:
- `Session.Event.Error` 被广泛发布（11+ 处）但无任何订阅者
- 错误无法传播到 UI 层

**修复方案**:
- 在 daemon 或 TUI 层添加错误事件订阅
- 实现错误展示和处理机制

---

## 实施任务清单

### 任务 1: 创建 Mutex 工具类

**文件**: `packages/opencode/src/util/mutex.ts` (新建)

- 实现 `Mutex` 类
- 实现 `AsyncMutex` 类
- 提供 `withLock` 辅助函数

### 任务 2: 重构 ConcurrencyLimiter

**修改**: `packages/opencode/src/util/concurrency-limiter.ts`

- 集成 Mutex 保护
- 修复 drainQueue 实现
- 修复 processQueue 递归问题

### 任务 3: 重构 AsyncQueue

**修改**: `packages/opencode/src/util/queue.ts`

- 集成 AsyncMutex 保护
- 添加线程安全的队列操作

### 任务 4: 实现 Subagent 限流器

**文件**: `packages/opencode/src/tool/task.ts` (修改)

- 添加全局 TaskLimiter
- 限制并发 subagent 数量

### 任务 5: 修复 TurnController 泄漏

**修改**: `packages/opencode/src/util/dynamic-turn-control.ts`

- 添加 TTL 过期机制
- 添加 LRU 淘汰
- 添加自动清理回调

### 任务 6: 添加错误事件处理

**文件**: `packages/opencode/src/session/error-handler.ts` (新建)

- 订阅 Session.Event.Error
- 实现错误日志和上报

### 任务 7: 更新单元测试

**修改**: `packages/opencode/src/__tests__/concurrency-limiter.test.ts`

- 添加并发竞态测试
- 添加 drainQueue 测试
- 添加 AsyncQueue 线程安全测试

---

## 测试策略

### 单元测试要求

1. **ConcurrencyLimiter 并发测试**
   - 100+ 并发请求不超出限制
   - 竞态条件压力测试
   
2. **AsyncQueue 线程安全测试**
   - 多线程同时 push/next
   - 边界条件测试

3. **drainQueue 完整性测试**
   - 验证所有 Promise 都被 reject
   - 验证无内存泄漏

### 集成测试要求

1. **多 Subagent 并发测试**
   - 10+ subagent 同时运行
   - 验证不超过全局限制

2. **内存泄漏测试**
   - 长时间运行验证
   - 内存使用监控

---

## 验收标准

1. ✅ 所有单元测试通过
2. ✅ 并发压力测试无竞态条件
3. ✅ 无内存泄漏
4. ✅ 代码无语法错误
5. ✅ 代码无 lint 警告
6. ✅ 符合 TypeScript 严格模式

---

## 实施顺序

```
1. Mutex 工具类
      ↓
2. ConcurrencyLimiter 重构
      ↓
3. AsyncQueue 重构
      ↓
4. TaskLimiter 实现
      ↓
5. TurnController 修复
      ↓
6. 错误事件处理
      ↓
7. 测试验证
```

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Mutex 可能降低性能 | 使用 setTimeout 而非 busy-wait |
| 重构破坏现有功能 | 完整的单元测试覆盖 |
| 引入新的竞态条件 | 使用 queueMicrotask 确保执行顺序 |

---

## 时间估算

- 任务 1-3 (核心并发修复): 2 小时
- 任务 4-5 (子 agent 限制): 1 小时
- 任务 6-7 (错误处理): 1 小时
- 测试验证: 1 小时

**总计**: 约 5 小时
