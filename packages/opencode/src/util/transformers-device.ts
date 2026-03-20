import { Process } from "@/util/process"
import { which } from "@/util/which"

const GPU_PROBE_TIMEOUT_MS = 1_500

export interface SystemGPUProbe {
  available: boolean
  evidence: string[]
  source: string
}

export interface TransformersDevicePreference {
  device?: "webgpu"
  hasRuntimeWebGPU: boolean
  hasSystemGPU: boolean
  evidence: string[]
  reason: string
}

let cachedDevicePreference: Promise<TransformersDevicePreference> | undefined

function dedupeEvidence(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function readRuntimeGPU() {
  const nav = (globalThis as typeof globalThis & { navigator?: { gpu?: { requestAdapter?: () => Promise<unknown> } } }).navigator
  return nav?.gpu
}

async function runProbe(command: string[], source: string) {
  const executable = command[0]
  if (!executable) {
    return { source, text: "" }
  }

  if (!executable.includes("/") && !which(executable)) {
    return { source, text: "" }
  }

  const result = await Process.text(command, {
    nothrow: true,
    abort: AbortSignal.timeout(GPU_PROBE_TIMEOUT_MS),
    timeout: 200,
  }).catch(() => undefined)

  return {
    source,
    text: result?.text ?? "",
  }
}

export function parseDarwinSystemProfilerGPUProbe(text: string): SystemGPUProbe {
  try {
    const parsed = JSON.parse(text) as { SPDisplaysDataType?: Array<Record<string, unknown>> }
    const evidence = dedupeEvidence(
      (parsed.SPDisplaysDataType ?? []).flatMap((entry) => {
        const values = [
          entry.sppci_model,
          entry._name,
          entry.spdisplays_vendor,
          entry.spdisplays_device_type,
          entry.spdisplays_metal,
        ]
        return values.filter((value): value is string => typeof value === "string")
      }),
    )

    return {
      available: evidence.length > 0,
      evidence,
      source: "system_profiler",
    }
  } catch {
    const evidence = dedupeEvidence(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /chipset model|graphics|metal/i.test(line))
        .map((line) => line.replace(/^\w[^:]*:\s*/, "")),
    )

    return {
      available: evidence.length > 0,
      evidence,
      source: "system_profiler",
    }
  }
}

export function parseLinuxLspciGPUProbe(text: string): SystemGPUProbe {
  const evidence = dedupeEvidence(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /(vga|3d controller|display controller)/i.test(line)),
  )

  return {
    available: evidence.length > 0,
    evidence,
    source: "lspci",
  }
}

export function parseWindowsVideoControllerProbe(text: string): SystemGPUProbe {
  const evidence = dedupeEvidence(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => !!line && !/^name$/i.test(line) && !/^caption$/i.test(line)),
  )

  return {
    available: evidence.length > 0,
    evidence,
    source: "video-controller",
  }
}

export function decideTransformersDevice(input: {
  runtimeWebGPU: boolean
  systemGPU: SystemGPUProbe
  override?: string
}): TransformersDevicePreference {
  const override = input.override?.trim().toLowerCase()
  if (override === "wasm" || override === "cpu") {
    return {
      device: undefined,
      hasRuntimeWebGPU: input.runtimeWebGPU,
      hasSystemGPU: input.systemGPU.available,
      evidence: input.systemGPU.evidence,
      reason: `forced-${override}`,
    }
  }

  if (override === "webgpu") {
    return {
      device: input.runtimeWebGPU ? "webgpu" : undefined,
      hasRuntimeWebGPU: input.runtimeWebGPU,
      hasSystemGPU: input.systemGPU.available,
      evidence: input.systemGPU.evidence,
      reason: input.runtimeWebGPU ? "forced-webgpu" : "forced-webgpu-runtime-unavailable",
    }
  }

  if (input.runtimeWebGPU) {
    return {
      device: "webgpu",
      hasRuntimeWebGPU: true,
      hasSystemGPU: input.systemGPU.available,
      evidence: input.systemGPU.evidence,
      reason: input.systemGPU.available ? "runtime-adapter-and-system-gpu-detected" : "runtime-adapter-detected",
    }
  }

  return {
    device: undefined,
    hasRuntimeWebGPU: false,
    hasSystemGPU: input.systemGPU.available,
    evidence: input.systemGPU.evidence,
    reason: input.systemGPU.available ? "system-gpu-detected-runtime-webgpu-unavailable" : "no-runtime-webgpu-or-system-gpu-detected",
  }
}

export async function probeRuntimeWebGPU() {
  const gpu = readRuntimeGPU()
  if (!gpu || typeof gpu.requestAdapter !== "function") return false

  try {
    const adapter = await gpu.requestAdapter()
    return !!adapter
  } catch {
    return false
  }
}

export async function probeSystemGPU(): Promise<SystemGPUProbe> {
  if (process.platform === "darwin") {
    const result = await runProbe([
      "/usr/sbin/system_profiler",
      "SPDisplaysDataType",
      "-detailLevel",
      "mini",
      "-json",
    ], "system_profiler")
    return parseDarwinSystemProfilerGPUProbe(result.text)
  }

  if (process.platform === "linux") {
    const nvidia = await runProbe(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], "nvidia-smi")
    const nvidiaProbe = parseWindowsVideoControllerProbe(nvidia.text)
    if (nvidiaProbe.available) {
      return { ...nvidiaProbe, source: "nvidia-smi" }
    }

    const lspci = await runProbe(["lspci"], "lspci")
    return parseLinuxLspciGPUProbe(lspci.text)
  }

  if (process.platform === "win32") {
    const powershell = which("powershell") || which("pwsh")
    if (!powershell) {
      return { available: false, evidence: [], source: "video-controller" }
    }

    const result = await runProbe(
      [
        powershell,
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
      ],
      "video-controller",
    )
    return parseWindowsVideoControllerProbe(result.text)
  }

  return { available: false, evidence: [], source: "unsupported-platform" }
}

export async function resolveTransformersDevicePreference(): Promise<TransformersDevicePreference> {
  cachedDevicePreference ??= Promise.all([probeRuntimeWebGPU(), probeSystemGPU()]).then(([runtimeWebGPU, systemGPU]) =>
    decideTransformersDevice({
      runtimeWebGPU,
      systemGPU,
      override: process.env.OPENCODE_TRANSFORMERS_DEVICE,
    }),
  )

  return cachedDevicePreference
}

export function resetTransformersDevicePreferenceCache() {
  cachedDevicePreference = undefined
}