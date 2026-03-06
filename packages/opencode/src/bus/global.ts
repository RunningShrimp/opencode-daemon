import { EventEmitter } from "events"

export const GlobalBus = new EventEmitter<{
  event: [
    {
      directory?: string
      payload: any
    },
  ]
}>()

// 增加默认监听器限制，防止警告
GlobalBus.setMaxListeners(50)

// 封装 emit 方法，添加错误处理，防止单个监听器错误影响其他监听器
const originalEmit = GlobalBus.emit.bind(GlobalBus)
// 覆盖 emit 方法以添加错误处理
GlobalBus.emit = function (
  event: "event",
  arg: {
    directory?: string
    payload: any
  },
): boolean {
  const listeners = GlobalBus.listenerCount(event) > 0 ? GlobalBus.listeners(event) as Array<(...args: any[]) => void> : []
  let hasError = false

  for (const listener of listeners) {
    try {
      listener(arg)
    } catch (error) {
      console.error("[GlobalBus] Error in event handler:", error)
      hasError = true
    }
  }

  return listeners.length > 0 || hasError
}
