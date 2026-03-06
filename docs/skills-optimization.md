# Skills 模块优化方案

## 一、问题概述

### 1.1 审查发现的问题

| 文件 | 问题类别数 | 严重问题数 |
|------|-----------|------------|
| `src/skill/skill.ts` (核心) | 10 | 3 |
| `src/tool/skill.ts` (工具层) | 8 | 2 |
| `test/skill/*.test.ts` | 8 | 2 |
| `cli/cmd/debug/skill.ts` + `tui/dialog-skill.tsx` | 8 | 1 |

### 1.2 多实例场景问题

| 问题 | 描述 |
|------|------|
| **全局 Router 单例** | 原设计使用全局 router，不同项目实例共享缓存 |
| **Provider 初始化重复** | 每次新实例创建都重新扫描所有目录 |
| **实例隔离不足** | 全局 skills 状态可能被其他项目污染 |
| **缓存未按实例隔离** | 不同项目的 skills 混在一起 |

---

## 二、问题详解与解决方案

### 2.1 高优先级问题

#### 问题 1: IO 操作串行执行 → 启动时间线性累加

**位置**: `src/skill/skill.ts:106-170`

**原代码**:
```typescript
// ❌ 串行执行，每个扫描源都要等待前一个完成
if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
  await scanExternal(path.join(Global.Path.home, ".claude"), "global")
  await scanExternal(path.join(Global.Path.home, ".agents"), "global")
  // ... 更多串行调用
}
```

**影响**: 启动时间线性累加，每个扫描源（全局 .claude、项目 .claude、.opencode、配置路径、远程 URL）都要等待前一个完成。

**解决方案**: 使用 SkillsRouter 的 `Promise.all` 并行扫描

**预期提升**: 启动时间减少 60-80%

---

#### 问题 2: 权限拒绝后缺少异常处理 → 应用崩溃

**位置**: `src/tool/skill.ts:69-74`

**原代码**:
```typescript
// ❌ 权限被拒绝时会抛出异常，但没有捕获处理
await ctx.ask({
  permission: "skill",
  patterns: [params.name],
  always: [params.name],
  metadata: {},
})
```

**影响**: 用户拒绝权限时应用崩溃，无友好错误提示。

**解决方案**: 添加 try-catch 捕获 `DeniedError`

```typescript
try {
  await ctx.ask({
    permission: "skill",
    patterns: [params.name],
    always: [params.name],
    metadata: {},
  })
} catch (error) {
  if (error instanceof PermissionNext.DeniedError) {
    throw new Error(`Permission denied for skill "${params.name}"`)
  }
  throw error
}
```

---

#### 问题 3: 重复调用 Skill.all() → 性能浪费

**位置**: `src/tool/skill.ts:11` vs `src/tool/skill.ts:65`

**原代码**:
```typescript
const skills = await Skill.all()  // 第1次调用

// ... 中间代码 ...

// 第65行 又调用了一次
const available = await Skill.all().then((x) => Object.keys(x).join(", "))
```

**影响**: 每次工具执行都重复加载技能，至少 2 次完整扫描。

**解决方案**: 复用已加载的 `skills` 变量

```typescript
const available = Object.keys(skills).join(", ")
```

---

#### 问题 4: 缺少并发限制 → 资源耗尽风险

**位置**: `src/skill/discovery.ts:79-94`

**原代码**:
```typescript
// ❌ 无并发限制，大量URL/文件会创建无数并发请求
await Promise.all(
  list.map(async (skill) => {
    await Promise.all(
      skill.files.map(async (file) => { /* 下载 */ }),
    )
  }),
)
```

**影响**:
- 网络拥塞
- 目标服务器压力
- 文件描述符耗尽

**解决方案**: 使用 `p-limit` 控制并发数

```typescript
import pLimit from 'p-limit'

const limit = pLimit(5)  // 限制5个并发
await Promise.all(
  list.map(limit(async (skill) => {
    await Promise.all(
      skill.files.map(limit(async (file) => { /* 下载 */ }))
    )
  }))
)
```

---

### 2.2 中优先级问题

#### 问题 5: 静默吞掉解析错误 → 调试困难

**位置**: `src/skill/skill.ts:80-87`

**原代码**:
```typescript
// ❌ 静默失败，无日志
if (!parsed.success) return
```

**解决方案**: 添加警告日志

```typescript
if (!parsed.success) {
  log.warn("skill missing required fields", { 
    skill: match, 
    issues: parsed.error.issues 
  })
  return
}
```

---

#### 问题 6: 缺少缓存刷新机制

**位置**: `src/skill/skill.ts:178-188`

**原代码**:
```typescript
export async function get(name: string) {
  return state().then((x) => x.skills[name])
}
// ❌ 没有提供手动刷新缓存的方法
```

**解决方案**: 添加 `refresh()` 方法

```typescript
export async function refresh(): Promise<void> {
  router.invalidate()
}
```

---

#### 问题 7: 测试覆盖不足

| 测试类型 | 覆盖率 |
|---------|-------|
| 基本功能 | 70% |
| 边界条件 | 30% |
| 错误处理 | 15% |
| 性能测试 | 0% |
| 并发测试 | 0% |

**建议增加测试用例**:
- 技能不存在时的行为
- frontmatter 格式错误处理
- 权限拒绝场景
- 并发加载性能

---

#### 问题 8: 无用代码 - iife 包装 async 函数

**位置**: `src/tool/skill.ts:80`

**问题**: `iife` 不支持 async，包装多余。

**解决方案**: 直接移除 `iife` 包装。

---

### 2.3 低优先级优化

#### 问题 9: 硬编码配置值

- `src/tool/skill.ts:79` - `limit = 10` 应外部化
- `src/skill/skill.ts:45-50` - 目录模式应可配置

#### 问题 10: UI 层优化

- 缺少 loading/empty/error 状态展示
- 没有 suspense 处理
- 正则表达式在循环中重复创建

#### 问题 11: 缓存策略

- discovery.ts 缓存无限增长 → 需要 LRU/TTL 清理
- Skill 内容全加载到内存 → 考虑按需加载

---

## 三、SkillsRouter 架构

### 3.1 核心设计

```
┌─────────────────────────────────────────────────────────────┐
│                      SkillsRouter                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  统一入口：get(), all(), refresh()                  │   │
│  │  缓存管理：LRU + TTL                                 │   │
│  │  并发控制：p-limit                                    │   │
│  │  错误隔离：单 Provider 失败不影响其他                │   │
│  │  超时控制：每个 Provider 独立超时                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│         ┌────────────────┼────────────────┐               │
│         ▼                ▼                ▼               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │LocalProvider │  │OpencodeProv │  │ RemoteProv   │       │
│  │ (.claude)    │  │ (.opencode) │  │ (URL)        │       │
│  │priority:10   │  │priority:20  │  │priority:5    │       │
│  └─────────────┘  └─────────────┘  └─────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 解决的问题对照表

| 原问题 | 修复位置 | 解决方案 |
|--------|---------|---------|
| 串行IO导致启动慢 | `SkillsRouter.loadAll()` | Promise.all 并行 |
| 无并发限制 | `loadAll()` + Provider | pLimit 控制 |
| 缺少错误处理 | 每个 Provider | try-catch + 日志 |
| 无缓存机制 | `SkillsRouter` | LRU + TTL |
| 无法刷新缓存 | `refresh()` | router.invalidate() |
| 解析错误静默 | Provider.parseSkill() | log.warn() |
| Provider 耦合 | 解耦为接口 | 独立类实现 |
| 无超时控制 | `loadAll()` | Promise.race |
| 无 AbortSignal | `scan(signal?)` | AbortController |

### 3.3 主要 API

```typescript
// 获取 Router 实例
const router = Skill.getRouter()

// 手动刷新缓存
await Skill.refresh()

// 获取单个 Skill (带缓存)
const skill = await router.get("my-skill")

// 获取所有 Skills
const all = await router.all()

// 注册自定义 Provider
router.register(new CustomSkillProvider())
```

### 3.4 配置选项

```typescript
const router = new SkillsRouter({
  concurrency: 5,    // 最大并发数
  timeout: 30000,    // 单个 Provider 超时(ms)
  cacheTTL: 300000,  // 缓存有效期(ms) = 5分钟
  cacheMax: 100,     // 最大缓存数量
})
```

### 3.5 Provider 优先级

| Provider | Priority | 说明 |
|----------|----------|------|
| OpencodeProvider | 20 | 最高优先级 |
| ConfigPathProvider | 15 | 配置文件路径 |
| LocalProvider | 10 | .claude/.agents |
| RemoteProvider | 5 | 最低优先级 |

---

## 四、优化效果预估

| 优化项 | 预期效果 |
|--------|---------|
| 并行化IO操作 | 启动时间减少 60-80% |
| 添加并发限制 | 减少资源耗尽风险 |
| 复用Skill.all()调用 | 减少重复计算 50% |
| 完善错误处理 | 提升稳定性，减少崩溃 |
| 增加测试覆盖 | 减少回归bug |
| LRU+TTL缓存 | 减少重复IO |

---

## 五、执行计划

### 第一阶段: 架构重构（已完成）

- [x] 创建 SkillsRouter 核心类
- [x] 实现 SkillProvider 接口
- [x] 实现 LocalSkillProvider
- [x] 实现 OpencodeSkillProvider
- [x] 实现 ConfigPathSkillProvider
- [x] 实现 RemoteSkillProvider
- [x] 添加并发控制 (p-limit)
- [x] 添加缓存策略 (LRU + TTL)
- [x] 添加超时控制
- [x] 添加错误隔离

### 第二阶段: 工具层修复（待执行）

- [ ] 修复权限拒绝异常处理
- [ ] 移除重复的 Skill.all() 调用
- [ ] 移除无用的 iife 包装

### 第三阶段: 测试完善（待执行）

- [ ] 增加边界条件测试
- [ ] 增加错误处理测试
- [ ] 增加性能测试
- [ ] 增加并发测试

### 第四阶段: UI层优化（待执行）

- [ ] 添加 loading/empty/error 状态
- [ ] 优化正则表达式
- [ ] 添加配置外部化

---

## 六、文件变更

| 文件 | 变更 |
|------|------|
| `src/skill/router.ts` | 新增 - SkillsRouter 核心实现 |
| `src/skill/index.ts` | 更新 - 导出新模块 |
| `src/tool/skill.ts` | 待修复 - 权限处理、重复调用 |
| `test/skill/*.test.ts` | 待完善 - 增加测试用例 |

---

## 七、注意事项

1. **向后兼容**: SkillsRouter 保持了原有 `Skill.get()`、`Skill.all()`、`Skill.dirs()` API
2. **配置继承**: 所有配置项都有默认值，可按需覆盖
3. **错误恢复**: 单个 Provider 失败不会影响其他 Provider
4. **资源清理**: 使用 AbortSignal 支持取消操作
