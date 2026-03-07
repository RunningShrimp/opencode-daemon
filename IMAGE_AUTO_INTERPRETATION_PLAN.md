# 图片自动解读与模型能力缓存优化方案

> 版本: 1.1  
> 日期: 2026-03-06  
> 状态: 规划中

## 核心特性

1. **图片自动解读** - 用户发送图片时自动选择最优解读方案（MCP 工具或多模态模型）
2. **Models.dev 缓存** - 运行时从 models.dev API 动态获取模型能力，支持本地缓存和增量更新

## 一、优化目标

当用户发送图片时，自动选择合适的 MCP 服务或多模态大模型进行图片解读，同时支持从 models.dev 动态获取模型能力缓存，实现以下目标：

- **智能路由**：自动检测图片并选择最优解读方案
- **多模型支持**：支持 MCP 图片解读工具和多模态大模型
- **动态能力**：运行时从 models.dev 获取最新模型能力
- **成本优化**：根据图片类型和复杂度选择性价比最高的方案
- **用户体验**：无缝体验，无需用户手动选择模型

---

## 二、现有架构分析

### 2.1 现有系统能力

| 组件 | 能力 | 现状 |
|------|------|------|
| Provider 系统 | 模型能力检测 | 已支持 `model.capabilities.input.image` |
| MCP 系统 | 外部工具集成 | 支持各种 MCP 工具调用 |
| 模型快照 | 多模态模型信息 | 包含 Phi-4-multimodal 等多模态模型 |
| 图片处理 | 文件类型识别 | 已支持常见图片格式 |

### 2.2 关键代码位置

- **Provider 能力定义**: `packages/opencode/src/provider/provider.ts` (行 735-760)
- **模型能力映射**: `packages/opencode/src/provider/models-snapshot.ts`
- **消息创建**: `packages/opencode/src/session/prompt.ts` (行 1024-1123)
- **MCP 工具集成**: `packages/opencode/src/mcp/index.ts` (行 982-1027)

---

## 三、解决方案设计

### 3.1 核心设计思路

```
用户发送图片
    ↓
检测图片附件 (在 createUserMessage 中)
    ↓
分析图片特征 (大小、格式、复杂度)
    ↓
选择最优解读方案
    ├── 方案1: MCP 图片解读工具 (如提供截图分析、视觉理解等工具的 MCP)
    ├── 方案2: 多模态大模型 (如 Phi-4-multimodal, GPT-4V, Claude Vision)
    └── 方案3: 降级为文本描述 + 普通模型
    ↓
执行解读并返回结果
```

### 3.2 模块设计

#### 3.2.1 图片检测与特征分析

```typescript
// packages/opencode/src/session/image-analyzer.ts

export interface ImageFeature {
  mimeType: string          // 图片 MIME 类型
  size: number             // 文件大小 (bytes)
  dimensions?: {           // 图片尺寸 (如果可获取)
    width: number
    height: number
  }
  complexity: "low" | "medium" | "high"  // 复杂度估算
}

export interface ImageAnalysisStrategy {
  type: "mcp" | "multimodal_model" | "text_fallback"
  provider?: string        // provider ID
  model?: string           // model ID  
  mcpTool?: string        // MCP 工具名
  reason: string           // 选择原因
}

export class ImageAnalyzer {
  // 检测消息是否包含图片附件
  detectImages(parts: PromptInput["parts"]): Array<{
    part: NonNullable<PromptInput["parts"]>[0]
    index: number
  }>
  
  // 分析图片特征
  async analyzeFeatures(imagePart: ImagePart): Promise<ImageFeature>
  
  // 选择最优解读策略
  selectStrategy(features: ImageFeature[]): Promise<ImageAnalysisStrategy>
}
```

#### 3.2.2 MCP 工具发现机制（使用 MCPSmartRouter）

项目已有 `MCPSmartRouter`（位于 `packages/opencode/src/util/smart-router.ts`），用于智能路由 MCP 工具。图片解读应复用此 router。

```typescript
// packages/opencode/src/session/image-mcp-router.ts

import { MCPSmartRouter, getGlobalMCPRouter, type MCPToolCapability } from "@/util/smart-router"

// 继承现有的 MCPSmartRouter，专门用于图片解读
export class ImageMCPRouter {
  private router: MCPSmartRouter

  constructor(router?: MCPSmartRouter) {
    this.router = router ?? getGlobalMCPRouter()
  }

  // 查找适合图片解读的 MCP 工具
  async findImageTools(): Promise<MCPToolCapability[]> {
    // 使用 router 的 findSimilarTools 查找图片相关工具
    const imageTasks = [
      "analyze image",
      "describe image",
      "screenshot analysis",
      "OCR text extraction",
      "visual understanding",
      "image description",
      "diagram recognition",
    ]

    const allTools = this.router.getAllTools()
    const imageTools: MCPToolCapability[] = []

    for (const task of imageTasks) {
      const similar = this.router.findSimilarTools(task, allTools, 10)
      for (const tool of similar) {
        // 检查是否已存在
        if (!imageTools.find(t => t.toolId === tool.toolId)) {
          imageTools.push(tool)
        }
      }
    }

    return imageTools
  }

  // 使用 MCPSmartRouter 进行路由决策
  async routeImageTask(task: string): Promise<{
    tool: MCPToolCapability | null
    alternatives: MCPToolCapability[]
  }> {
    // 构造图片解读任务描述
    const imageTask = `analyze and describe this image: ${task}`
    const decision = this.router.selectTool(imageTask)

    return {
      tool: decision.selectedTool,
      alternatives: decision.alternatives,
    }
  }

  // 执行图片解读工具
  async executeImageTool(
    tool: MCPToolCapability,
    imageData: {
      base64?: string
      url?: string
      mimeType: string
    }
  ): Promise<string> {
    const { invokeTool } = await import("@/mcp")
    const result = await invokeTool({
      serverName: tool.serverName,
      toolName: tool.name,
      arguments: {
        image: imageData.base64,
        url: imageData.url,
        mimeType: imageData.mimeType,
      },
    })
    return result
  }
}

// 发现所有支持图片的 MCP 工具（兼容旧接口）
export async function discoverImageTools(): Promise<ImageTool[]> {
  const router = new ImageMCPRouter()
  const tools = await router.findImageTools()

  return tools.map(tool => ({
    name: tool.name,
    mcpServer: tool.serverName,
    description: tool.description,
    capabilities: {
      // 根据 tool 的 tags 和 suitableTaskTypes 推断能力
      general: tool.suitableTaskTypes.includes("image") || tool.tags.includes("vision"),
      screenshot: tool.tags.includes("screenshot"),
      ocr: tool.tags.includes("ocr"),
      diagram: tool.tags.includes("diagram"),
    },
  }))
}
```

#### 3.2.3 多模态模型选择器

```typescript
// packages/opencode/src/provider/multimodal-selector.ts

export interface MultimodalModelOption {
  providerID: string
  modelID: string
  modelName: string
  cost: {
    input: number
    output: number
  }
  capabilities: {
    image: boolean
    pdf: boolean
    video: boolean
  }
  contextLimit: number
  quality: "low" | "medium" | "high"  // 图片理解质量
}

// 根据图片特征选择最合适的多模态模型
export async function selectMultimodalModel(
  features: ImageFeature[],
  availableModels: MultimodalModelOption[]
): Promise<MultimodalModelOption | null>
```

#### 3.2.4 图片解读路由器

```typescript
// packages/opencode/src/session/image-router.ts

export class ImageRouter {
  constructor(
    private mcpTools: ImageTool[],
    private multimodalModels: MultimodalModelOption[]
  ) {}
  
  // 路由决策核心逻辑
  async route(
    features: ImageFeature[],
    userContext: {
      currentModel?: Provider.Model
      preferMcp?: boolean
      budget?: "low" | "medium" | "high"
    }
  ): Promise<ImageAnalysisStrategy>
  
  // 执行路由策略
  async execute(
    strategy: ImageAnalysisStrategy,
    imageParts: ImagePart[],
    context: ExecutionContext
  ): Promise<string>  // 返回解读结果
}
```

### 3.3 决策流程图

```
┌─────────────────────────────────────────┐
│         检测到图片附件                    │
└─────────────────┬───────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│    获取可用的 MCP 图片工具列表           │
└─────────────────┬───────────────────────┘
                  ↓
         ┌────────┴────────┐
         ↓                ↓
    有 MCP 工具        无 MCP 工具
         ↓                ↓
    ┌────┴────┐     ┌─────┴──────┐
    ↓         ↓     ↓             ↓
 首选 MCP  评估成本  选择多模态模型  降级方案
    ↓         ↓     ↓             ↓
    └────────┬┴─────┴─────────────┘
              ↓
    ┌─────────────────────────────────┐
    │   生成解读请求并执行             │
    └─────────────────────────────────┘
```

### 3.4 优先级策略

| 优先级 | 条件 | 选择策略 |
|--------|------|----------|
| 1 | 有专用 MCP 图片工具 | 使用 MCP (通常更精准) |
| 2 | 无 MCP 但有多模态模型 | 根据图片复杂度选择 |
| 3 | 图片简单 + 用户倾向 | 文本描述 + 普通模型 |
| 4 | 无多模态能力 | 返回提示信息 |

---

## 四、配置项设计

### 4.1 用户可配置项

```typescript
// packages/opencode/src/config/config.ts

export const Config = z.object({
  // ...existing fields...
  
  imageUnderstanding: z.object({
    // 是否启用自动图片解读
    enabled: z.boolean().default(true),
    
    // 优先使用 MCP (true) 还是多模态模型 (false)
    preferMcp: z.boolean().default(true),
    
    // 成本预算: low / medium / high
    budget: z.enum(["low", "medium", "high"]).default("medium"),
    
    // 自定义 MCP 图片工具白名单
    mcpWhitelist: z.array(z.string()).optional(),
    
    // 自定义多模态模型黑名单
    modelBlacklist: z.array(z.string()).optional(),
    
    // 图片大小阈值 (bytes)，超过则拒绝
    maxImageSize: z.number().default(10 * 1024 * 1024),  // 10MB
  }).optional(),
})
```

### 4.2 默认行为

- 默认启用自动图片解读
- 优先使用 MCP 工具 (如果有)
- 中等成本预算
- 最大支持 10MB 图片

---

## 五、集成点设计

### 5.1 修改 createUserMessage

在 `packages/opencode/src/session/prompt.ts` 的 `createUserMessage` 函数中集成：

```typescript
async function createUserMessage(input: PromptInput) {
  // 现有逻辑...
  
  // 新增：图片检测与路由
  const imageParts = detectImageParts(input.parts)
  if (imageParts.length > 0) {
    const config = await Config.get()
    if (config.imageUnderstanding?.enabled) {
      const router = await ImageRouter.create()
      const strategy = await router.selectStrategy(imageParts)
      
      if (strategy.type !== "text_fallback") {
        // 执行图片解读
        const interpretation = await router.execute(strategy, imageParts, context)
        
        // 将解读结果添加到消息中
        parts.push({
          type: "text",
          text: `[图片解读]: ${interpretation}`,
          synthetic: true,
        })
      }
    }
  }
  
  // 现有逻辑...
}
```

### 5.2 消息格式扩展

在用户消息中新增 `imageInterpretation` 字段：

```typescript
export const UserMessage = z.object({
  // ...existing fields...
  
  // 图片解读结果
  imageInterpretation: z.object({
    strategy: z.string(),
    result: z.string(),
    model: z.string().optional(),
  }).optional(),
})
```

---

## 六、错误处理

### 6.1 错误类型

| 错误类型 | 描述 | 处理方式 |
|----------|------|----------|
| ImageTooLargeError | 图片超过大小限制 | 提示用户压缩图片 |
| NoCapabilityError | 无可用解读能力 | 提示用户手动描述 |
| McpToolError | MCP 工具调用失败 | 回退到多模态模型 |
| ModelError | 多模态模型调用失败 | 返回部分结果 + 提示 |

### 6.2 降级策略

```
MCP 工具失败
    ↓
尝试其他 MCP 工具
    ↓
无 MCP 可用 → 尝试多模态模型
    ↓
多模态模型失败 → 返回"无法解读"提示
```

---

## 七、监控与日志

### 7.1 关键指标

| 指标 | 描述 | 告警阈值 |
|------|------|----------|
| image_interpretation_total | 总解读次数 | - |
| image_interpretation_success | 成功次数 | < 80% |
| image_interpretation_mcp_used | MCP 使用次数 | - |
| image_interpretation_model_used | 多模态模型使用次数 | - |
| image_interpretation_latency | 平均延迟 | > 10s |

### 7.2 日志级别

```typescript
const log = Log.create({ service: "image.router" })

// 决策日志 (info)
log.info("image routing decision", { 
  strategy: "mcp", 
  tool: "screenshot-analyzer",
  imageCount: 2 
})

// 执行日志 (debug)
log.debug("executing image interpretation", {
  model: "phi-4-multimodal",
  imageSize: 1024000
})

// 错误日志 (error)
log.error("image interpretation failed", { 
  error: err.message,
  strategy: "multimodal_model" 
})
```

---

## 八、实施计划

### 8.1 阶段划分

| 阶段 | 时间 | 内容 |
|------|------|------|
| Phase 1 | 1 周 | 核心框架搭建 |
| Phase 2 | 1 周 | MCPSmartRouter 集成 |
| Phase 3 | 1 周 | 多模态模型集成 |
| Phase 4 | 1 周 | 测试与优化 |

### 8.2 Phase 1: 核心框架

- [ ] 创建 `ImageAnalyzer` 类
- [ ] 创建 `ImageRouter` 类
- [ ] 实现图片检测逻辑
- [ ] 集成到 `createUserMessage`

### 8.3 Phase 2: MCPSmartRouter 集成

- [ ] 创建 `ImageMCPRouter` 类，封装 `MCPSmartRouter`
- [ ] 实现图片工具发现（利用现有 `findSimilarTools` 方法）
- [ ] 实现工具执行封装
- [ ] 添加 MCP 降级逻辑

### 8.4 Phase 3: 多模态模型集成

- [ ] 扫描可用多模态模型
- [ ] 实现模型选择策略
- [ ] 添加成本估算

### 8.5 Phase 4: 测试与优化

- [ ] 单元测试
- [ ] 集成测试
- [ ] 性能优化
- [ ] 文档编写

---

## 九、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| MCP 工具不稳定 | 中 | 实现自动降级到多模态模型 |
| 多模态模型成本高 | 中 | 添加预算控制和成本监控 |
| 图片解读延迟 | 低 | 添加异步处理和缓存 |
| 用户体验不一致 | 中 | 提供配置选项 |

---

## 十、相关文件索引

### 10.1 需要修改的文件

| 文件路径 | 修改内容 |
|----------|----------|
| `packages/opencode/src/session/prompt.ts` | 集成图片检测与路由 |
| `packages/opencode/src/config/config.ts` | 添加配置项 |
| `packages/opencode/src/provider/provider.ts` | 添加多模态模型查询方法 |

### 10.2 需要创建的文件

| 文件路径 | 描述 |
|----------|------|
| `packages/opencode/src/session/image-analyzer.ts` | 图片分析与策略选择 |
| `packages/opencode/src/session/image-router.ts` | 图片解读路由器 |
| `packages/opencode/src/session/image-mcp-router.ts` | 图片 MCP 路由（复用 `MCPSmartRouter`） |
| `packages/opencode/src/provider/multimodal-selector.ts` | 多模态模型选择器 |
| `packages/opencode/src/provider/models-cache.ts` | Models.dev 运行时缓存 |

### 10.3 复用的现有模块

| 模块 | 路径 | 说明 |
|------|------|------|
| `MCPSmartRouter` | `packages/opencode/src/util/smart-router.ts` | MCP 智能路由核心类 |
| `getGlobalMCPRouter` | `packages/opencode/src/util/smart-router.ts` | 获取全局 Router 实例 |
| `MCP.index` | `packages/opencode/src/mcp/index.ts` | MCP 工具调用入口 |

---

## 十一、Models.dev 缓存集成

### 11.1 现有架构

项目已经在构建时使用 models.dev API 获取模型快照：

```typescript
// packages/opencode/script/build.ts (行 18-26)
const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
const modelsData = await fetch(`${modelsUrl}/api.json`).then((x) => x.text())
// 生成 models-snapshot.ts
```

**现状**：
- 仅在构建时获取一次快照
- 运行时无法获取最新模型能力
- 静态数据，无法动态更新

### 11.2 优化方案：运行时缓存 + 动态更新

#### 11.2.1 设计目标

- **运行时获取**：运行时从 models.dev API 获取模型能力
- **本地缓存**：使用 SQLite/文件缓存避免重复请求
- **增量更新**：定期更新缓存，支持手动刷新
- **离线支持**：缓存不可用时回退到静态快照

#### 11.2.2 核心模块设计

```typescript
// packages/opencode/src/provider/models-cache.ts

export interface ModelCapability {
  // 基础信息
  id: string
  name: string
  provider: string

  // 能力标识
  reasoning: boolean           // 推理/思维链支持
  tool_call: boolean          // 工具调用支持
  structured_output: boolean // 结构化输出
  attachment: boolean         // 文件附件支持

  // 模态支持
  modalities: {
    input: Array<"text" | "image" | "audio" | "video" | "pdf">
    output: Array<"text" | "image" | "audio" | "video" | "pdf">
  }

  // 限制
  limit: {
    context: number           // 上下文窗口
    output: number            // 输出限制
  }

  // 定价
  cost: {
    input: number
    output: number
    cache_read?: number       // 缓存读取价格
    cache_write?: number      // 缓存写入价格
  }

  // 元数据
  release_date: string
  last_updated: string
}

export class ModelsCache {
  private cache: Map<string, ModelCapability> = new Map()
  private cacheDir: string
  private cacheTTL: number = 24 * 60 * 60 * 1000  // 24 小时

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir
  }

  // 从 models.dev API 获取模型能力
  async fetchFromAPI(providerID?: string): Promise<ModelCapability[]>

  // 加载本地缓存
  async loadCache(): Promise<void>

  // 保存到本地缓存
  async saveCache(): Promise<void>

  // 获取模型能力（优先缓存，fallback 到 API）
  async getModelCapability(modelID: string): Promise<ModelCapability | null>

  // 获取支持图片的模型列表
  async getVisionModels(): Promise<ModelCapability[]>

  // 获取支持特定能力的模型
  async getModelsByCapability(capability: {
    vision?: boolean
    audio?: boolean
    tool_call?: boolean
    reasoning?: boolean
  }): Promise<ModelCapability[]>

  // 手动刷新缓存
  async refresh(): Promise<void>

  // 检查缓存是否过期
  isCacheExpired(): boolean
}
```

#### 11.2.3 缓存策略

```
┌─────────────────────────────────────────┐
│         请求获取模型能力                  │
└─────────────────┬───────────────────────┘
                  ↓
         ┌────────┴────────┐
         ↓                ↓
    内存缓存命中      缓存未命中
         ↓                ↓
    直接返回         检查本地缓存
         ↓                ↓
                   ┌─────┴─────┐
                   ↓           ↓
              缓存有效       缓存过期/无
                   ↓           ↓
              返回缓存    请求 models.dev
                               ↓
                          ┌─────┴─────┐
                          ↓           ↓
                     API 成功      API 失败
                          ↓           ↓
                     更新缓存      返回静态快照
                          ↓
                     返回结果
```

#### 11.2.4 集成到 Provider 系统

```typescript
// packages/opencode/src/provider/provider.ts

// 扩展 Provider 接口
export interface Provider {
  // 现有方法...

  // 新增：从缓存获取模型能力
  getModelCapability(modelID: string): Promise<ModelCapability | null>

  // 新增：获取视觉模型列表
  getVisionModels(): Promise<ModelCapability[]>

  // 新增：刷新模型缓存
  refreshModelsCache(): Promise<void>
}

// 在 Provider 类中实现
export class ProviderImpl {
  private modelsCache: ModelsCache

  async getModelCapability(modelID: string): Promise<ModelCapability | null> {
    // 1. 先检查本地快照
    const snapshot = this.getModelFromSnapshot(modelID)
    if (snapshot) return snapshot

    // 2. 检查运行时缓存
    return await this.modelsCache.getModelCapability(modelID)
  }

  async getVisionModels(): Promise<ModelCapability[]> {
    // 1. 先从快照获取
    const fromSnapshot = this.getVisionModelsFromSnapshot()

    // 2. 合并运行时缓存中的新模型
    const fromCache = await this.modelsCache.getVisionModels()

    // 3. 合并并去重（缓存优先，因为更新）
    return mergeAndDeduplicate(fromSnapshot, fromCache)
  }
}
```

### 11.3 配置项扩展

```typescript
// packages/opencode/src/config/config.ts

export const Config = z.object({
  // ...existing fields...

  modelsCache: z.object({
    // 是否启用运行时模型缓存
    enabled: z.boolean().default(true),

    // 缓存目录
    cacheDir: z.string().default("$OPENCODE_DATA/models-cache"),

    // 缓存 TTL (毫秒)
    cacheTTL: z.number().default(24 * 60 * 60 * 1000),  // 24 小时

    // 是否在启动时自动刷新
    autoRefresh: z.boolean().default(false),

    // 手动刷新间隔 (小时)
    refreshInterval: z.number().default(24),

    // models.dev API 地址
    apiUrl: z.string().default("https://models.dev"),

    // 请求超时 (毫秒)
    timeout: z.number().default(10000),

    // 离线模式（仅使用缓存和快照）
    offline: z.boolean().default(false),
  }).optional(),
})
```

### 11.4 图片解读中的使用

```typescript
// packages/opencode/src/provider/multimodal-selector.ts

import { ModelsCache } from "./models-cache"

export async function selectMultimodalModel(
  features: ImageFeature[],
  options: {
    budget?: "low" | "medium" | "high"
    preferredProvider?: string
  }
): Promise<MultimodalModelOption | null> {
  const cache = await ModelsCache.getInstance()

  // 获取所有支持图片的模型
  const visionModels = await cache.getVisionModels()

  // 根据能力过滤
  const suitable = visionModels.filter(m => {
    // 检查输入图片能力
    if (!m.modalities.input.includes("image")) return false

    // 根据预算过滤成本
    if (options.budget === "low" && m.cost.input > 1.0) return false

    // 根据提供商偏好过滤
    if (options.preferredProvider && m.provider !== options.preferredProvider) return false

    return true
  })

  // 选择最优模型（考虑成本和质量）
  return selectOptimal(suitable, features)
}
```

### 11.5 实施任务

| 任务 | 描述 | 优先级 |
|------|------|--------|
| 创建 ModelsCache 类 | 实现缓存核心逻辑 | P0 |
| 集成 models.dev API | 添加运行时 API 调用 | P0 |
| 配置项添加 | 添加缓存相关配置 | P1 |
| Provider 集成 | 扩展 Provider 接口 | P1 |
| 图片解读集成 | 使用新的缓存系统 | P2 |
| 监控与日志 | 添加缓存命中率等指标 | P2 |

---

## 十二、附录

### A. 参考资料

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [OpenAI Vision Capabilities](https://platform.openai.com/docs/guides/vision)
- [Anthropic Claude Vision](https://docs.anthropic.com/en/docs/vision)
- [Models.dev API](https://models.dev)

### B. 现有支持图片的模型示例

从 `models-snapshot.ts` 中提取：

```typescript
// 支持图片输入的模型
const visionModels = [
  { provider: "microsoft", model: "Phi-4-multimodal-instruct", context: 32000 },
  { provider: "openai", model: "gpt-4o", context: 128000 },
  { provider: "openai", model: "gpt-4o-mini", context: 128000 },
  { provider: "anthropic", model: "claude-3-5-sonnet-20241022", context: 200000 },
  { provider: "google", model: "gemini-1.5-pro", context: 128000 },
]
```
