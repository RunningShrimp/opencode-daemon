import { Log } from "@/util/log"

const log = Log.create({ service: "network-probe" })

export interface EndpointProbeResult {
  url: string
  ok: boolean
  status?: number
  latencyMs: number
  error?: string
}

const cache = new Map<string, { expiresAt: number; result: EndpointProbeResult }>()

function cacheKey(url: string, timeoutMs: number) {
  return `${url}::${timeoutMs}`
}

export async function probeEndpoint(url: string, timeoutMs = 2500): Promise<EndpointProbeResult> {
  const key = cacheKey(url, timeoutMs)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    }).catch(async () => {
      return fetch(url, {
        method: "GET",
        signal: controller.signal,
      })
    })

    const result: EndpointProbeResult = {
      url,
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - started,
    }
    cache.set(key, { expiresAt: Date.now() + 60_000, result })
    return result
  } catch (error) {
    const result: EndpointProbeResult = {
      url,
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
    cache.set(key, { expiresAt: Date.now() + 15_000, result })
    log.warn("endpoint probe failed", { url, error: result.error })
    return result
  } finally {
    clearTimeout(timer)
  }
}

export async function rankHealthyEndpoints(urls: string[], timeoutMs = 2500): Promise<EndpointProbeResult[]> {
  const results = await Promise.all(urls.map((url) => probeEndpoint(url, timeoutMs)))
  return results.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1
    return a.latencyMs - b.latencyMs
  })
}

export function clearNetworkProbeCache() {
  cache.clear()
}