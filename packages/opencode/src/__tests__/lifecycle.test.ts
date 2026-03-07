import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Destroyable, register, unregister, destroyAll, size } from "../util/lifecycle"

describe("lifecycle", () => {
  beforeEach(() => {
    while (size() > 0) {
      unregister({})
    }
  })

  afterEach(async () => {
    await destroyAll()
  })

  describe("Destroyable", () => {
    test("isDestroyable returns true for objects with destroy", () => {
      const obj = {
        destroy: () => {},
      }
      expect(Destroyable.isDestroyable(obj)).toBe(true)
    })

    test("isDestroyable returns false for objects without destroy", () => {
      expect(Destroyable.isDestroyable({})).toBe(false)
      expect(Destroyable.isDestroyable(null)).toBe(false)
      expect(Destroyable.isDestroyable(undefined)).toBe(false)
      expect(Destroyable.isDestroyable("string")).toBe(false)
      expect(Destroyable.isDestroyable(123)).toBe(false)
    })

    test("safeDestroy calls destroy on destroyable objects", async () => {
      let called = false
      const obj = {
        destroy: () => {
          called = true
        },
      }

      await Destroyable.safeDestroy(obj)
      expect(called).toBe(true)
    })

    test("safeDestroy handles async destroy", async () => {
      let called = false
      const obj = {
        destroy: async () => {
          await sleep(10)
          called = true
        },
      }

      await Destroyable.safeDestroy(obj)
      expect(called).toBe(true)
    })

    test("safeDestroy does not throw on non-destroyable", async () => {
      await expect(Destroyable.safeDestroy({})).resolves.toBeUndefined()
      await expect(Destroyable.safeDestroy(null)).resolves.toBeUndefined()
    })

    test("safeDestroy catches errors", async () => {
      const obj = {
        destroy: () => {
          throw new Error("destroy failed")
        },
      }

      await expect(Destroyable.safeDestroy(obj)).resolves.toBeUndefined()
    })
  })

  describe("registry", () => {
    test("register adds cleanup function", () => {
      const owner = {}
      register(owner, () => {})
      expect(size()).toBe(1)
    })

    test("unregister removes cleanup function", () => {
      const owner = {}
      register(owner, () => {})
      unregister(owner)
      expect(size()).toBe(0)
    })

    test("register ignores duplicate owners", () => {
      const owner = {}
      register(owner, () => {})
      register(owner, () => {})
      expect(size()).toBe(1)
    })
  })

  describe("destroyAll", () => {
    test("calls all cleanup functions", async () => {
      const results: number[] = []
      const owner1 = { id: 1 }
      const owner2 = { id: 2 }

      register(owner1, () => {
        results.push(1)
      })
      register(owner2, () => {
        results.push(2)
      })

      await destroyAll()

      expect(results).toContain(1)
      expect(results).toContain(2)
    })

    test("handles async cleanup functions", async () => {
      const results: number[] = []
      const owner = {}

      register(owner, async () => {
        await sleep(10)
        results.push(1)
      })

      await destroyAll()
      expect(results).toContain(1)
    })

    test("clears registry after cleanup", async () => {
      const owner = {}
      register(owner, () => {})

      await destroyAll()
      expect(size()).toBe(0)
    })

    test("continues on cleanup error", async () => {
      const results: number[] = []
      const owner1 = { id: 1 }
      const owner2 = { id: 2 }

      register(owner1, () => {
        throw new Error("failed")
      })
      register(owner2, () => {
        results.push(2)
      })

      await destroyAll()

      expect(results).toContain(2)
    })
  })
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
