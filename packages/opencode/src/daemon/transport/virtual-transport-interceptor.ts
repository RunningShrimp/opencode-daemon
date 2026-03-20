const DEFAULT_INTERNAL_ORIGIN = "http://opencode.internal"

function parseOrigin(value: string) {
  return new URL(value).origin
}

function resolveURL(input: RequestInfo | URL, internalOrigin: string) {
  if (input instanceof URL) return input
  if (input instanceof Request) return new URL(input.url)
  return new URL(input, internalOrigin)
}

export interface VirtualTransportPolicy {
  internalOrigin?: string
}

export namespace VirtualTransportInterceptor {
  export function origin(policy: VirtualTransportPolicy = {}) {
    return parseOrigin(policy.internalOrigin ?? DEFAULT_INTERNAL_ORIGIN)
  }

  export function isInternal(input: RequestInfo | URL, policy: VirtualTransportPolicy = {}) {
    const internalOrigin = origin(policy)
    return resolveURL(input, internalOrigin).origin === internalOrigin
  }

  export function toRequest(input: RequestInfo | URL, init?: RequestInit, policy: VirtualTransportPolicy = {}) {
    const internalOrigin = origin(policy)
    const request =
      input instanceof Request
        ? input
        : input instanceof URL
          ? new Request(input, init)
          : new Request(new URL(input, internalOrigin), init)
    const url = new URL(request.url, internalOrigin)
    return new Request(url, request)
  }
}
