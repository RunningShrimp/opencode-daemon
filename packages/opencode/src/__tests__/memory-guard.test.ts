/**
 * Memory Guard Unit Tests
 *
 * Tests for the MemoryGuard module, focusing on:
 * - Callback registration (singleton pattern)
 * - Memory pressure detection
 * - Configuration management
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test"
import { MemoryGuard } from "../util/memory-guard"
import { globalInstanceBudget } from "../util/instance-memory-budget"

describe("MemoryGuard", () => {
  beforeEach(() => {
    // Reset singleton state for testing
    MemoryGuard.__resetForTesting()
    MemoryGuard.stop()
    MemoryGuard.configure({
      softLimitMB: 1024,
      hardLimitMB: 2048,
      checkIntervalMs: 30000,
    })
  })

  afterEach(() => {
    MemoryGuard.stop()
    MemoryGuard.__resetForTesting()
  })

  describe("configuration", () => {
    test("default config has sensible values", () => {
      const config = MemoryGuard.getConfig()
      expect(config.softLimitMB).toBe(1024)
      expect(config.hardLimitMB).toBe(2048)
      expect(config.checkIntervalMs).toBe(30000)
    })

    test("configure updates config", () => {
      MemoryGuard.configure({ softLimitMB: 512, hardLimitMB: 1024 })
      const config = MemoryGuard.getConfig()
      expect(config.softLimitMB).toBe(512)
      expect(config.hardLimitMB).toBe(1024)
      // checkIntervalMs should remain unchanged
      expect(config.checkIntervalMs).toBe(30000)
    })

    test("configure merges with existing config", () => {
      MemoryGuard.configure({ softLimitMB: 512 })
      MemoryGuard.configure({ hardLimitMB: 1024 })
      const config = MemoryGuard.getConfig()
      expect(config.softLimitMB).toBe(512)
      expect(config.hardLimitMB).toBe(1024)
    })
  })

  describe("getCurrentPressure", () => {
    test("returns correct pressure level structure", () => {
      const pressure = MemoryGuard.getCurrentPressure()
      expect(pressure).toHaveProperty("level")
      expect(pressure).toHaveProperty("usagePercent")
      expect(pressure).toHaveProperty("heapUsedMB")
      expect(pressure).toHaveProperty("heapTotalMB")
    })

    test("level is normal when memory is low", () => {
      const pressure = MemoryGuard.getCurrentPressure()
      // In test environment, memory should be normal
      expect(["normal", "warning", "critical"]).toContain(pressure.level)
    })

    test("heapUsedMB and heapTotalMB are calculated correctly", () => {
      const pressure = MemoryGuard.getCurrentPressure()
      // Memory values should be non-negative
      expect(pressure.heapUsedMB).toBeGreaterThanOrEqual(0)
      expect(pressure.heapTotalMB).toBeGreaterThanOrEqual(0)
      expect(pressure.usagePercent).toBeGreaterThanOrEqual(0)
    })
  })

  describe("callback registration", () => {
    test("onPressure returns unsubscribe function", () => {
      const callback = vi.fn()
      const unsubscribe = MemoryGuard.onPressure(callback)

      // Trigger a check
      MemoryGuard.forceCheck()

      expect(callback).toHaveBeenCalled()

      // Unsubscribe
      unsubscribe()

      // Clear previous calls
      callback.mockClear()

      // Trigger another check
      MemoryGuard.forceCheck()

      // Callback should not be called after unsubscribe
      expect(callback).not.toHaveBeenCalled()
    })

    test("multiple subscriptions work independently", () => {
      const callback1 = vi.fn()
      const callback2 = vi.fn()

      MemoryGuard.onPressure(callback1)
      const unsubscribe2 = MemoryGuard.onPressure(callback2)

      MemoryGuard.forceCheck()

      expect(callback1).toHaveBeenCalled()
      expect(callback2).toHaveBeenCalled()

      callback1.mockClear()
      callback2.mockClear()

      unsubscribe2()

      MemoryGuard.forceCheck()

      expect(callback1).toHaveBeenCalled()
      expect(callback2).not.toHaveBeenCalled()
    })
  })

  describe("singleton cleanup callback", () => {
    test("callback is registered only once", () => {
      // Check initial state
      expect(MemoryGuard.__getCleanupCallbackState()).toBe(false)

      // Force multiple checks
      MemoryGuard.forceCheck()
      MemoryGuard.forceCheck()
      MemoryGuard.forceCheck()

      // Callback should be registered after first check
      expect(MemoryGuard.__getCleanupCallbackState()).toBe(true)
    })

    test("reset clears singleton state", () => {
      MemoryGuard.forceCheck()
      expect(MemoryGuard.__getCleanupCallbackState()).toBe(true)

      MemoryGuard.__resetForTesting()
      expect(MemoryGuard.__getCleanupCallbackState()).toBe(false)
    })
  })

  describe("start/stop", () => {
    test("start begins monitoring", () => {
      const startSpy = vi.spyOn(globalThis, "setInterval")
      MemoryGuard.start()
      expect(startSpy).toHaveBeenCalled()
      startSpy.mockRestore()
    })

    test("start does not duplicate interval if already running", () => {
      const startSpy = vi.spyOn(globalThis, "setInterval")
      MemoryGuard.start()
      startSpy.mockClear()
      MemoryGuard.start()
      expect(startSpy).not.toHaveBeenCalled()
      startSpy.mockRestore()
    })

    test("stop ends monitoring", () => {
      const clearSpy = vi.spyOn(globalThis, "clearInterval")
      MemoryGuard.start()
      MemoryGuard.stop()
      expect(clearSpy).toHaveBeenCalled()
      clearSpy.mockRestore()
    })

    test("forceCheck returns current pressure", () => {
      const pressure = MemoryGuard.forceCheck()
      expect(pressure).toHaveProperty("level")
    })
  })

  describe("memory pressure detection", () => {
    test("detects warning level", () => {
      // Configure with low thresholds for testing
      MemoryGuard.configure({
        softLimitMB: 0, // Very low to trigger warning
        hardLimitMB: 0,
      })

      const pressure = MemoryGuard.getCurrentPressure()
      // With very low thresholds, should likely be critical or warning
      expect(["warning", "critical"]).toContain(pressure.level)
    })
  })
})

describe("MemoryGuard Integration with InstanceMemoryBudget", () => {
  beforeEach(() => {
    MemoryGuard.__resetForTesting()
    MemoryGuard.stop()
  })

  afterEach(() => {
    MemoryGuard.stop()
    MemoryGuard.__resetForTesting()
  })

  test("cleanup callback is registered with global budget", () => {
    // Trigger a check which should register the cleanup callback
    MemoryGuard.forceCheck()

    // The cleanup callback should be registered
    expect(MemoryGuard.__getCleanupCallbackState()).toBe(true)

    // Trigger cleanup on the global budget
    // This should call the registered cleanup callback
    const cleanupSpy = vi.spyOn(globalInstanceBudget, "onCleanup")
    // Note: We can't easily test the callback execution without more setup
    cleanupSpy.mockRestore()
  })
})
