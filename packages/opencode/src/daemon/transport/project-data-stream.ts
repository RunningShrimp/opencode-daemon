import { parseProjectDataEvent, type ProjectDataEvent } from "@/daemon/protocol/data-events"
import { LaneID } from "@/daemon/identity/ids"

export interface ProjectDataStreamChannelOptions {
  maxEventsPerLane?: number
}

interface BinaryChunk {
  laneID: string
  streamID: string
  seq: number
  mime: string
  data: Uint8Array
}

function parseAfter(value: string | null): number {
  if (!value) return -1
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return -1
  return Math.floor(parsed)
}

function parseRequired(value: string | null, field: string): string {
  const text = value?.trim() ?? ""
  if (!text) throw new Error(`${field} is required`)
  return text
}

function parsePositiveInt(value: string | null, field: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`)
  return Math.floor(parsed)
}

function binaryKey(input: { laneID: string; streamID: string; seq: number }): string {
  return `${input.laneID}:${input.streamID}:${input.seq}`
}

export class ProjectDataStreamChannel {
  private readonly maxEventsPerLane: number
  private readonly events = new Map<string, ProjectDataEvent[]>()
  private readonly binary = new Map<string, BinaryChunk>()

  constructor(options: ProjectDataStreamChannelOptions = {}) {
    this.maxEventsPerLane = Math.max(1, Math.floor(options.maxEventsPerLane ?? 500))
  }

  publish(event: ProjectDataEvent): void {
    const laneID = LaneID.make(event.laneID)
    const existing = this.events.get(laneID) ?? []
    const next = [...existing, event]
    if (next.length > this.maxEventsPerLane) {
      next.splice(0, next.length - this.maxEventsPerLane)
    }
    this.events.set(laneID, next)
  }

  read(input: { laneID: string; afterSeq?: number }): ProjectDataEvent[] {
    const laneID = LaneID.make(input.laneID)
    const afterSeq = input.afterSeq ?? -1
    const events = this.events.get(laneID) ?? []
    return events.filter((event) => event.seq > afterSeq)
  }

  publishBinary(input: BinaryChunk): void {
    const laneID = LaneID.make(input.laneID)
    const streamID = input.streamID.trim()
    if (!streamID) throw new Error("streamID is required")
    const key = binaryKey({ laneID, streamID, seq: input.seq })
    this.binary.set(key, {
      laneID,
      streamID,
      seq: input.seq,
      mime: input.mime || "application/octet-stream",
      data: input.data,
    })
  }

  readBinary(input: { laneID: string; streamID: string; seq: number }): BinaryChunk | undefined {
    const laneID = LaneID.make(input.laneID)
    const streamID = input.streamID.trim()
    if (!streamID) return undefined
    return this.binary.get(binaryKey({ laneID, streamID, seq: input.seq }))
  }

  async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()

    if (method === "PUT") {
      try {
        const laneID = parseRequired(request.headers.get("x-opencode-lane-id"), "x-opencode-lane-id")
        const streamID = parseRequired(request.headers.get("x-opencode-stream-id"), "x-opencode-stream-id")
        const seq = parsePositiveInt(request.headers.get("x-opencode-seq"), "x-opencode-seq")
        const mime = request.headers.get("content-type") || "application/octet-stream"
        const data = new Uint8Array(await request.arrayBuffer())
        this.publishBinary({ laneID, streamID, seq, mime, data })
        return Response.json({ ok: true, laneID, streamID, seq, binary: true })
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 400 },
        )
      }
    }

    if (method === "POST") {
      let payload: unknown
      try {
        payload = await request.json()
      } catch {
        return Response.json({ ok: false, error: "invalid-json" }, { status: 400 })
      }

      let event: ProjectDataEvent
      try {
        event = parseProjectDataEvent(payload)
      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 400 },
        )
      }

      this.publish(event)
      return Response.json({ ok: true, laneID: event.laneID, seq: event.seq })
    }

    if (method === "GET") {
      const laneID = url.searchParams.get("laneID")
      if (!laneID) {
        return Response.json({ ok: false, error: "laneID is required" }, { status: 400 })
      }

      if (url.searchParams.get("format") === "binary") {
        try {
          const streamID = parseRequired(url.searchParams.get("streamID"), "streamID")
          const seq = parsePositiveInt(url.searchParams.get("seq"), "seq")
          const chunk = this.readBinary({ laneID, streamID, seq })
          if (!chunk) {
            return Response.json({ ok: false, error: "binary-chunk-not-found" }, { status: 404 })
          }

          const payload = new Uint8Array(chunk.data).buffer
          return new Response(payload, {
            status: 200,
            headers: {
              "content-type": chunk.mime,
              "x-opencode-lane-id": chunk.laneID,
              "x-opencode-stream-id": chunk.streamID,
              "x-opencode-seq": String(chunk.seq),
            },
          })
        } catch (error) {
          return Response.json(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            { status: 400 },
          )
        }
      }

      const afterSeq = parseAfter(url.searchParams.get("after"))
      const events = this.read({ laneID, afterSeq })
      return Response.json({ ok: true, events })
    }

    return Response.json({ ok: false, error: "project-data-stream expects GET, POST, or PUT" }, { status: 405 })
  }
}
