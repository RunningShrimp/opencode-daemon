import { createContext, useContext, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../component/border"
import { TextAttributes } from "@opentui/core"
import z from "zod"
import { TuiEvent } from "../event"

export type ToastOptions = z.infer<typeof TuiEvent.ToastShow.properties>

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={toast.currentToast}>
      {(current) => (
        <box
          position="absolute"
          justifyContent="center"
          alignItems="flex-start"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          borderColor={theme[current().variant]}
          border={["left", "right"]}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <Show when={current().title}>
            <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
              {current().title}
            </text>
          </Show>
          <text fg={theme.text} wrapMode="word" width="100%">
            {current().message}
          </text>
        </box>
      )}
    </Show>
  )
}

function init() {
  const [store, setStore] = createStore({
    currentToast: null as ToastOptions | null,
    toastQueue: [] as ToastOptions[],
  })

  let timeoutHandle: NodeJS.Timeout | null = null

  // Toast 去重和队列配置
  const TOAST_DEDUP_WINDOW_MS = 2000  // 2秒内的相同消息视为重复
  const MAX_QUEUE_SIZE = 3
  let lastToastTime = 0
  let lastToastMessage = ""
  let lastToastTitle = ""

  const processQueue = () => {
    if (store.currentToast) return  // 已有显示的 Toast
    if (store.toastQueue.length === 0) return

    const nextToast = store.toastQueue[0]
    setStore("currentToast", nextToast)
    setStore("toastQueue", (q: ToastOptions[]) => q.slice(1))

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(() => {
      setStore("currentToast", null)
      // 处理队列中的下一个
      processQueue()
    }, nextToast.duration).unref()
  }

  const toast = {
    show(options: ToastOptions) {
      const parsedOptions = TuiEvent.ToastShow.properties.parse(options)
      const { duration, title, message = "", variant } = parsedOptions as { duration?: number; title?: string; message?: string; variant?: string }
      const now = Date.now()

      // 去重检查：如果在去重窗口期内且消息相同，则忽略
      if (
        now - lastToastTime < TOAST_DEDUP_WINDOW_MS &&
        lastToastMessage === message &&
        lastToastTitle === title
      ) {
        return  // 忽略重复的 Toast
      }

      lastToastTime = now
      lastToastMessage = message ?? ""
      lastToastTitle = title ?? ""

      // 获取当前状态
      const state = store

      // 如果当前有显示的 Toast，加入队列
      if (store.currentToast) {
        const queue = store.toastQueue
        // 限制队列大小，移除最旧的
        if (queue.length >= MAX_QUEUE_SIZE) {
          setStore("toastQueue", queue.slice(1))
        }
        setStore("toastQueue", [...queue, parsedOptions])
        return
      }

      // 直接显示
      setStore("currentToast", parsedOptions)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        setStore("currentToast", null)
        // 处理队列中的下一个
        processQueue()
      }, duration ?? 3000).unref()
    },
    error: (err: any) => {
      if (err instanceof Error)
        return toast.show({
          variant: "error",
          message: err.message,
        })
      toast.show({
        variant: "error",
        message: "An unknown error has occurred",
      })
    },
    get currentToast(): ToastOptions | null {
      return store.currentToast
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
