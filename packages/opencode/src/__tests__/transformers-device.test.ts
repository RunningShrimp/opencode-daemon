import { afterEach, describe, expect, test } from "bun:test"
import {
  decideTransformersDevice,
  parseDarwinSystemProfilerGPUProbe,
  parseLinuxLspciGPUProbe,
  parseWindowsVideoControllerProbe,
  resetTransformersDevicePreferenceCache,
} from "../util/transformers-device"

afterEach(() => {
  resetTransformersDevicePreferenceCache()
  delete process.env.OPENCODE_TRANSFORMERS_DEVICE
})

describe("transformers device detection", () => {
  test("parses macOS system profiler gpu output", () => {
    const probe = parseDarwinSystemProfilerGPUProbe(
      JSON.stringify({
        SPDisplaysDataType: [
          {
            sppci_model: "Apple M4",
            spdisplays_metal: "supported, feature set macOS GPUFamily2 v1",
          },
        ],
      }),
    )

    expect(probe.available).toBe(true)
    expect(probe.evidence).toContain("Apple M4")
  })

  test("parses linux lspci gpu output", () => {
    const probe = parseLinuxLspciGPUProbe(
      "0000:01:00.0 VGA compatible controller: NVIDIA Corporation AD107M [GeForce RTX 4060 Max-Q / Mobile]",
    )

    expect(probe.available).toBe(true)
    expect(probe.evidence[0]).toContain("NVIDIA")
  })

  test("parses windows video controller names", () => {
    const probe = parseWindowsVideoControllerProbe("Name\nNVIDIA GeForce RTX 4080 Laptop GPU\nIntel(R) Iris(R) Xe Graphics")

    expect(probe.available).toBe(true)
    expect(probe.evidence).toHaveLength(2)
  })

  test("enables webgpu when runtime adapter exists", () => {
    const decision = decideTransformersDevice({
      runtimeWebGPU: true,
      systemGPU: {
        available: true,
        evidence: ["Apple M4"],
        source: "system_profiler",
      },
    })

    expect(decision.device).toBe("webgpu")
    expect(decision.reason).toBe("runtime-adapter-and-system-gpu-detected")
  })

  test("stays on wasm when system gpu exists but runtime webgpu is unavailable", () => {
    const decision = decideTransformersDevice({
      runtimeWebGPU: false,
      systemGPU: {
        available: true,
        evidence: ["Apple M4"],
        source: "system_profiler",
      },
    })

    expect(decision.device).toBeUndefined()
    expect(decision.reason).toBe("system-gpu-detected-runtime-webgpu-unavailable")
  })

  test("honors explicit webgpu override only when runtime support exists", () => {
    const unavailable = decideTransformersDevice({
      runtimeWebGPU: false,
      systemGPU: {
        available: true,
        evidence: ["Apple M4"],
        source: "system_profiler",
      },
      override: "webgpu",
    })
    const available = decideTransformersDevice({
      runtimeWebGPU: true,
      systemGPU: {
        available: false,
        evidence: [],
        source: "system_profiler",
      },
      override: "webgpu",
    })

    expect(unavailable.device).toBeUndefined()
    expect(unavailable.reason).toBe("forced-webgpu-runtime-unavailable")
    expect(available.device).toBe("webgpu")
    expect(available.reason).toBe("forced-webgpu")
  })
})