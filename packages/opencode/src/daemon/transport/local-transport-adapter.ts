import { VirtualTransportInterceptor, type VirtualTransportPolicy } from "./virtual-transport-interceptor"
import { compareShadowResponses, type ShadowCompareResult } from "./shadow-compare"

interface LocalChannelRouter {
  pathPrefix: string
  dispatch: (request: Request) => Promise<Response>
}

export interface LocalTransportShadowOptions {
  dispatch: (request: Request) => Promise<Response>
  onCompared?: (result: ShadowCompareResult) => void
}

export interface LocalTransportAdapterOptions extends VirtualTransportPolicy {
  dispatch: (request: Request) => Promise<Response>
  rejectExternal?: boolean
  controlRPC?: LocalChannelRouter
  projectDataStream?: LocalChannelRouter
  shadow?: LocalTransportShadowOptions
}

function rejectExternalRequest(url: string): never {
  throw new Error(`LocalTransportAdapter rejected external URL: ${url}`)
}

function routeByChannel(request: Request, channels: LocalChannelRouter[]): LocalChannelRouter | undefined {
  const pathname = new URL(request.url).pathname
  return channels.find((channel) => pathname.startsWith(channel.pathPrefix))
}

export function createLocalTransportAdapter(options: LocalTransportAdapterOptions): typeof fetch {
  const rejectExternal = options.rejectExternal ?? true
  const channels = [options.controlRPC, options.projectDataStream].filter(
    (channel): channel is LocalChannelRouter => Boolean(channel),
  )

  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = VirtualTransportInterceptor.toRequest(input, init, options)

    if (rejectExternal && !VirtualTransportInterceptor.isInternal(request, options)) {
      rejectExternalRequest(request.url)
    }

    const channel = routeByChannel(request, channels)
    const targetDispatch = channel?.dispatch ?? options.dispatch

    if (!options.shadow) {
      return targetDispatch(request)
    }

    const shadowRequest = new Request(request)
    const shadowTask = options.shadow.dispatch(shadowRequest).catch(
      () => new Response("shadow-dispatch-error", { status: 599 }),
    )
    const primary = await targetDispatch(request)
    const shadow = await shadowTask
    const compared = await compareShadowResponses(primary, shadow)
    options.shadow.onCompared?.(compared)
    return primary
  }

  return fn as typeof fetch
}
