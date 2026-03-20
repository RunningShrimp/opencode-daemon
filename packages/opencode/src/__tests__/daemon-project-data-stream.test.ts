import { describe, expect, test } from "bun:test"
import { ProjectDataStreamChannel } from "@/daemon/transport/project-data-stream"

describe("project data stream channel", () => {
  test("publishes and reads lane-scoped data events", async () => {
    const channel = new ProjectDataStreamChannel({ maxEventsPerLane: 10 })

    const post = await channel.dispatch(
      new Request("http://opencode.internal/__daemon/project-data-stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "prompt.chunk",
          laneID: "lane.data.1",
          streamID: "stream-1",
          seq: 1,
          emittedAt: 1_700_001_400_000,
          payload: {
            text: "hello",
            done: false,
          },
        }),
      }),
    )

    expect(post.status).toBe(200)

    const get = await channel.dispatch(
      new Request("http://opencode.internal/__daemon/project-data-stream?laneID=lane.data.1&after=0"),
    )

    expect(get.status).toBe(200)
    const payload = (await get.json()) as {
      ok: boolean
      events: Array<{ type: string; seq: number }>
    }

    expect(payload.ok).toBe(true)
    expect(payload.events).toHaveLength(1)
    expect(payload.events[0]?.type).toBe("prompt.chunk")
    expect(payload.events[0]?.seq).toBe(1)
  })

  test("keeps only recent events per lane according to maxEventsPerLane", async () => {
    const channel = new ProjectDataStreamChannel({ maxEventsPerLane: 2 })

    for (let seq = 1; seq <= 3; seq += 1) {
      await channel.dispatch(
        new Request("http://opencode.internal/__daemon/project-data-stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "prompt.chunk",
            laneID: "lane.data.2",
            streamID: "stream-2",
            seq,
            emittedAt: 1_700_001_401_000 + seq,
            payload: {
              text: `chunk-${seq}`,
              done: seq === 3,
            },
          }),
        }),
      )
    }

    const get = await channel.dispatch(
      new Request("http://opencode.internal/__daemon/project-data-stream?laneID=lane.data.2&after=0"),
    )
    const payload = (await get.json()) as { ok: boolean; events: Array<{ seq: number }> }

    expect(payload.ok).toBe(true)
    expect(payload.events.map((event) => event.seq)).toEqual([2, 3])
  })

  test("supports binary upload/read path for near-zero-copy payload delivery", async () => {
    const channel = new ProjectDataStreamChannel({ maxEventsPerLane: 10 })
    const bytes = new Uint8Array([1, 2, 3, 4, 5])

    const put = await channel.dispatch(
      new Request("http://opencode.internal/__daemon/project-data-stream", {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-opencode-lane-id": "lane.data.bin",
          "x-opencode-stream-id": "stream-bin",
          "x-opencode-seq": "7",
        },
        body: bytes,
      }),
    )
    expect(put.status).toBe(200)

    const get = await channel.dispatch(
      new Request(
        "http://opencode.internal/__daemon/project-data-stream?laneID=lane.data.bin&format=binary&streamID=stream-bin&seq=7",
      ),
    )

    expect(get.status).toBe(200)
    expect(get.headers.get("content-type")).toBe("application/octet-stream")

    const returned = new Uint8Array(await get.arrayBuffer())
    expect([...returned]).toEqual([1, 2, 3, 4, 5])
  })
})
