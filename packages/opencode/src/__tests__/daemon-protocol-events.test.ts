import { describe, expect, test } from "bun:test"
import { parseControlEvent } from "@/daemon/protocol/control-events"
import { parseProjectDataEvent } from "@/daemon/protocol/data-events"

describe("daemon protocol events", () => {
  test("parses valid control event", () => {
    const event = parseControlEvent({
      id: "2a8a86f1-5190-4d00-a7f3-a8f7c0c7fcc4",
      type: "lane.acquire",
      workerID: "worker.alpha",
      laneID: "lane.alpha",
      emittedAt: Date.now(),
      payload: {
        directory: "/tmp/project",
        sessionID: "session-1",
      },
    })

    expect(event.type).toBe("lane.acquire")
    if (event.type !== "lane.acquire") {
      throw new Error("Expected lane.acquire event")
    }
    expect(event.payload.sessionID).toBe("session-1")
  })

  test("rejects invalid control event", () => {
    expect(() =>
      parseControlEvent({
        id: "not-a-uuid",
        type: "lane.acquire",
      }),
    ).toThrow()
  })

  test("parses valid project data event", () => {
    const event = parseProjectDataEvent({
      type: "embedding.request",
      laneID: "lane.alpha",
      streamID: "stream-1",
      seq: 0,
      emittedAt: Date.now(),
      payload: {
        requestID: "req-1",
        content: "hello",
        model: "text-embedding-3-large",
      },
    })

    expect(event.type).toBe("embedding.request")
    if (event.type !== "embedding.request") {
      throw new Error("Expected embedding.request event")
    }
    expect(event.payload.requestID).toBe("req-1")
  })
})
