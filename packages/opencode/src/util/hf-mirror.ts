import { Log } from "./log"

const log = Log.create({ service: "hf-mirror" })

type HuggingFaceSource = "modelscope" | "hf-mirror" | "huggingface"

interface RepoFileRequest {
  repo: string
  revision: string
  filePath: string
}

const FETCH_PATCH_FLAG = Symbol.for("opencode.hf-mirror.fetch-patched")
const DEFAULT_FETCH_TIMEOUT_MS = 8_000

function detectChinaNetwork(): boolean {
  if (process.env.OPENCODE_USE_MIRROR !== undefined) {
    return process.env.OPENCODE_USE_MIRROR === "1"
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz && (tz.includes("Shanghai") || tz.includes("Beijing") || tz.includes("China"))) {
      return true
    }
  } catch {
    // Ignore timezone detection errors
  }

  return false
}

const MIRRORS = {
  modelscope: "https://www.modelscope.cn",
  "hf-mirror": "https://hf-mirror.com",
  huggingface: "https://huggingface.co",
}

export const EMBEDDING_MODELS = [
  "janni-t/qwen3-embedding-0.6b-tei-onnx",
  "Snowflake/snowflake-arctic-embed-xs",
  "Xenova/all-MiniLM-L6-v2",
] as const

function getBestMirror(): string {
  if (process.env.HF_ENDPOINT) {
    return process.env.HF_ENDPOINT
  }

  const isChina = detectChinaNetwork()
  if (isChina) {
    return MIRRORS["hf-mirror"]
  }

  return MIRRORS["huggingface"]
}

const bestMirror = getBestMirror()
if (!process.env.HF_ENDPOINT) {
  process.env.HF_ENDPOINT = bestMirror
}

if (!process.env.HF_HUB_URL) {
  process.env.HF_HUB_URL = bestMirror
}

if (!process.env.OPENCODE_EMBEDDING_MODEL) {
  process.env.OPENCODE_EMBEDDING_MODEL = EMBEDDING_MODELS[0]
}

export const HF_MIRROR_URL = bestMirror
export const HF_ENDPOINT = process.env.HF_ENDPOINT ?? bestMirror
export const EMBEDDING_MODEL = process.env.OPENCODE_EMBEDDING_MODEL
export { MIRRORS }

function encodePath(value: string): string {
  return value
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")
}

function parseRepoFileRequest(url: URL): RepoFileRequest | undefined {
  const segments = url.pathname.split("/").filter(Boolean)
  const resolveIndex = segments.indexOf("resolve")
  if (resolveIndex <= 0) return undefined
  if (resolveIndex + 2 >= segments.length) return undefined

  const repo = segments.slice(0, resolveIndex).join("/")
  const revision = decodeURIComponent(segments[resolveIndex + 1] || "main")
  const filePath = segments.slice(resolveIndex + 2).map(decodeURIComponent).join("/")
  if (!repo || !filePath) return undefined

  return {
    repo,
    revision,
    filePath,
  }
}

function isKnownHuggingFaceHost(hostname: string): boolean {
  return hostname === "huggingface.co" || hostname === "hf-mirror.com" || hostname === "www.modelscope.cn"
}

function toURL(input: RequestInfo | URL): URL | undefined {
  try {
    if (input instanceof URL) return input
    if (typeof input === "string") return new URL(input)
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url)
  } catch {
    return undefined
  }
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase()
  }
  return "GET"
}

function hasRequestBody(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.body !== undefined && init.body !== null) return true
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.bodyUsed || input.body !== null
  }
  return false
}

function buildModelScopeURL(request: RepoFileRequest): string {
  const repo = encodePath(request.repo)
  const revision = encodeURIComponent(request.revision)
  const filePath = encodePath(request.filePath)
  return `${MIRRORS.modelscope}/api/v1/models/${repo}/repo?Revision=${revision}&FilePath=${filePath}`
}

function buildHuggingFaceURL(base: string, request: RepoFileRequest): string {
  const repo = encodePath(request.repo)
  const revision = encodeURIComponent(request.revision)
  const filePath = encodePath(request.filePath)
  return `${base}/${repo}/resolve/${revision}/${filePath}`
}

export function getSourcePriority(): HuggingFaceSource[] {
  return ["modelscope", "hf-mirror", "huggingface"]
}

export function getHuggingFaceFallbackCandidates(input: RequestInfo | URL): string[] {
  const url = toURL(input)
  if (!url || !isKnownHuggingFaceHost(url.hostname)) {
    return url ? [url.toString()] : []
  }

  const parsed = parseRepoFileRequest(url)
  if (!parsed) return [url.toString()]

  const seen = new Set<string>()
  const result: string[] = []
  const push = (value: string) => {
    if (seen.has(value)) return
    seen.add(value)
    result.push(value)
  }

  for (const source of getSourcePriority()) {
    if (source === "modelscope") {
      push(buildModelScopeURL(parsed))
      continue
    }

    push(buildHuggingFaceURL(MIRRORS[source], parsed))
  }

  return result
}

function withTimeoutSignal(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)

  const abort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", abort)
    },
  }
}

export async function fetchWithHuggingFaceFallback(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const url = toURL(input)
  const method = getRequestMethod(input, init)

  if (!url || !isKnownHuggingFaceHost(url.hostname) || !["GET", "HEAD"].includes(method) || hasRequestBody(input, init)) {
    return fetchImpl(input, init)
  }

  const candidates = getHuggingFaceFallbackCandidates(input)
  let lastResponse: Response | undefined
  let lastError: unknown

  for (const candidate of candidates) {
    const timeout = withTimeoutSignal(init?.signal, DEFAULT_FETCH_TIMEOUT_MS)
    try {
      const response = await fetchImpl(candidate, {
        ...init,
        signal: timeout.signal,
      })
      if (response.ok) {
        if (candidate !== url.toString()) {
          log.warn("using hugging face fallback source", {
            from: url.toString(),
            to: candidate,
            status: response.status,
          })
        }
        return response
      }

      lastResponse = response
      log.warn("hugging face source unavailable", {
        url: candidate,
        status: response.status,
      })
    } catch (error) {
      lastError = error
      log.warn("hugging face source request failed", {
        url: candidate,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      timeout.dispose()
    }
  }

  if (lastResponse) return lastResponse
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Unknown Hugging Face fetch failure"))
}

export function installHuggingFaceFetchFallbacks(fetchImpl: typeof fetch = globalThis.fetch): void {
  const target = globalThis as typeof globalThis & { [FETCH_PATCH_FLAG]?: boolean; fetch: typeof fetch }
  if (target[FETCH_PATCH_FLAG]) return

  target.fetch = (input: RequestInfo | URL, init?: RequestInit) => fetchWithHuggingFaceFallback(input, init, fetchImpl)
  target[FETCH_PATCH_FLAG] = true
}

export function initializeHuggingFaceMirrors(): void {
  if (!process.env.HF_ENDPOINT) {
    process.env.HF_ENDPOINT = bestMirror
  }

  if (!process.env.HF_HUB_URL) {
    process.env.HF_HUB_URL = bestMirror
  }

  if (!process.env.OPENCODE_EMBEDDING_MODEL) {
    process.env.OPENCODE_EMBEDDING_MODEL = EMBEDDING_MODELS[0]
  }

  installHuggingFaceFetchFallbacks()
}

export function getNextEmbeddingModel(currentModel: string): string | undefined {
  const currentIndex = EMBEDDING_MODELS.indexOf(currentModel as (typeof EMBEDDING_MODELS)[number])
  if (currentIndex === -1 || currentIndex >= EMBEDDING_MODELS.length - 1) {
    return undefined
  }
  return EMBEDDING_MODELS[currentIndex + 1]
}

export function getAvailableMirrors(): string[] {
  return Object.values(MIRRORS)
}
