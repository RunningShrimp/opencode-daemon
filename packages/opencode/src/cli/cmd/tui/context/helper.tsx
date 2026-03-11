import { createContext, Show, useContext, type ParentProps, type Accessor } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  // Helper to get ready value safely, handling both getter functions and direct values
  function getReadyValue(ready: unknown): boolean {
    if (ready === undefined) return true
    if (typeof ready === "function") {
      // 如果是 getter 函数（如 get ready() { return ... }），调用它
      return (ready as () => boolean)() !== false
    }
    // 如果是直接值，只要不是 false 就渲染
    return ready !== false
  }

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      // 修复：处理 ready 可以是 getter 函数、直接布尔值或 undefined 的情况
      const shouldRender = getReadyValue(init.ready)
      return (
        // @ts-expect-error
        <Show when={shouldRender}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
