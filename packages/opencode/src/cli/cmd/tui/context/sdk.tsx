import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"
import { Log } from "@/util/log"

export type EventSource = {
  on: (handler: (event: Event) => void) => () => void
  setWorkspace?: (workspaceID?: string) => void
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let workspaceID: string | undefined
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
        experimental_workspaceID: workspaceID,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0

    // Maximum queue size to prevent memory exhaustion during high-frequency events
    const MAX_QUEUE_SIZE = 1000
    // Drop oldest events when queue exceeds threshold
    const QUEUE_DROP_THRESHOLD = 800
    let droppedCount = 0

    // High-priority event types that should never be dropped during backpressure
    const HIGH_PRIORITY_EVENTS = new Set([
      "message.part.updated",
      "message.part.delta",
      "message.updated",
    ])

    // Check if event is high-priority
    const isHighPriority = (event: Event): boolean => {
      return HIGH_PRIORITY_EVENTS.has(event.type)
    }

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()

      // Report dropped events if any
      if (droppedCount > 0) {
        Log.Default.warn("tui event queue dropped events", {
          count: droppedCount,
        })
        droppedCount = 0
      }

      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handleEvent = (event: Event) => {
      // Backpressure handling: never drop high-priority events
      if (queue.length >= MAX_QUEUE_SIZE) {
        // For high-priority events, force-add and flush immediately
        if (isHighPriority(event)) {
          queue.push(event)
          if (timer) {
            clearTimeout(timer)
            timer = undefined
          }
          flush()
          return
        }
        droppedCount++
        return
      }

      // Start dropping low-priority events when approaching threshold
      if (queue.length >= QUEUE_DROP_THRESHOLD) {
        // For high-priority events, add immediately
        if (isHighPriority(event)) {
          queue.push(event)
          // Flush immediately for high-priority events
          if (timer) {
            clearTimeout(timer)
            timer = undefined
          }
          flush()
          return
        }

        // For low-priority events, drop oldest low-priority
        droppedCount++
        const lowPriorityIndex = queue.findIndex(e => !isHighPriority(e))
        if (lowPriorityIndex !== -1) {
          queue.splice(lowPriorityIndex, 1)
        }
        queue.push(event)
      } else {
        queue.push(event)
      }

      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const events = await sdk.event.subscribe({}, { signal: ctrl.signal })

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
        }
      })().catch(() => {})
    }

    onMount(() => {
      if (props.events) {
        const unsub = props.events.on(handleEvent)
        onCleanup(unsub)
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      setWorkspace(next?: string) {
        if (workspaceID === next) return
        workspaceID = next
        sdk = createSDK()
        props.events?.setWorkspace?.(next)
        if (!props.events) startSSE()
      },
      url: props.url,
    }
  },
})
