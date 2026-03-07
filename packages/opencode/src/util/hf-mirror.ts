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
  "hf-mirror": "https://hf-mirror.com",
  huggingface: "https://huggingface.co",
  qiniu: "https://hf-mirror.qiniu.com",
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
