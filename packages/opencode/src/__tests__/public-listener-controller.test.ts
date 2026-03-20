import { afterEach, describe, expect, test } from "bun:test"
import {
  configurePublicListener,
  disablePublicListener,
  getPublicListenerStatus,
  registerPublicListenerController,
  resetPublicListenerControllerForTests,
} from "@/server/public-listener"

afterEach(async () => {
  await resetPublicListenerControllerForTests()
})

describe("public listener controller", () => {
  test("configures and reports active listener", async () => {
    let nextPort = 7100
    registerPublicListenerController((opts) => ({
      hostname: opts.hostname,
      port: opts.port === 0 ? nextPort++ : opts.port,
      url: new URL(`http://${opts.hostname}:${opts.port === 0 ? nextPort - 1 : opts.port}`),
      stop: async () => 0,
    }))

    const configured = await configurePublicListener({
      hostname: "0.0.0.0",
      port: 0,
      mdns: true,
      mdnsDomain: "opencode.local",
    })

    expect(configured.active).toBe(true)
    expect(configured.url).toContain("http://0.0.0.0:")

    const status = getPublicListenerStatus()
    expect(status.active).toBe(true)
    expect(status.options?.mdns).toBe(true)
  })

  test("is idempotent for same options and restarts for changed options", async () => {
    let stopCount = 0
    registerPublicListenerController((opts) => ({
      hostname: opts.hostname,
      port: opts.port,
      url: new URL(`http://${opts.hostname}:${opts.port}`),
      stop: async () => {
        stopCount += 1
        return 0
      },
    }))

    await configurePublicListener({ hostname: "127.0.0.1", port: 5050 })
    await configurePublicListener({ hostname: "127.0.0.1", port: 5050 })
    expect(stopCount).toBe(0)

    await configurePublicListener({ hostname: "127.0.0.1", port: 5051 })
    expect(stopCount).toBe(1)
  })

  test("disables current listener", async () => {
    let stopped = false
    registerPublicListenerController((opts) => ({
      hostname: opts.hostname,
      port: opts.port,
      url: new URL(`http://${opts.hostname}:${opts.port}`),
      stop: async () => {
        stopped = true
        return 0
      },
    }))

    await configurePublicListener({ hostname: "127.0.0.1", port: 6060 })
    const result = await disablePublicListener()

    expect(result.active).toBe(false)
    expect(stopped).toBe(true)
    expect(getPublicListenerStatus().active).toBe(false)
  })
})
