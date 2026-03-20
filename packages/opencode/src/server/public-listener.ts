export interface PublicListenerOptions {
  hostname: string
  port: number
  mdns?: boolean
  mdnsDomain?: string
  cors?: string[]
}

export interface PublicListenerStatus {
  active: boolean
  url?: string
  hostname?: string
  port?: number
  options?: PublicListenerOptions
}

interface ListenerServer {
  hostname?: string
  port?: number
  url: URL
  stop: (closeActiveConnections?: boolean) => void | number | Promise<void> | Promise<number>
}

type ListenHandler = (options: PublicListenerOptions) => ListenerServer

let listener: ListenerServer | undefined
let listenerOptions: PublicListenerOptions | undefined
let listenHandler: ListenHandler | undefined

function normalizeOptions(input: PublicListenerOptions): PublicListenerOptions {
  return {
    hostname: input.hostname,
    port: input.port,
    mdns: !!input.mdns,
    mdnsDomain: input.mdnsDomain,
    cors: [...(input.cors ?? [])].sort(),
  }
}

function optionsEqual(left: PublicListenerOptions | undefined, right: PublicListenerOptions) {
  if (!left) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

function ensureHandler() {
  if (!listenHandler) {
    throw new Error("Public listener controller has not been registered")
  }
  return listenHandler
}

export function registerPublicListenerController(handler: ListenHandler) {
  listenHandler = handler
}

export function getPublicListenerStatus(): PublicListenerStatus {
  if (!listener) return { active: false }
  return {
    active: true,
    url: listener.url.toString(),
    hostname: listener.hostname,
    port: listener.port,
    options: listenerOptions,
  }
}

export async function configurePublicListener(options: PublicListenerOptions): Promise<PublicListenerStatus> {
  const normalized = normalizeOptions(options)

  if (listener && optionsEqual(listenerOptions, normalized)) {
    return getPublicListenerStatus()
  }

  if (listener) {
    await listener.stop(true)
    listener = undefined
    listenerOptions = undefined
  }

  const next = ensureHandler()(normalized)
  listener = next
  listenerOptions = normalized
  return getPublicListenerStatus()
}

export async function disablePublicListener() {
  if (!listener) return { active: false as const }
  await listener.stop(true)
  listener = undefined
  listenerOptions = undefined
  return { active: false as const }
}

export async function resetPublicListenerControllerForTests() {
  await disablePublicListener()
  listenHandler = undefined
}
