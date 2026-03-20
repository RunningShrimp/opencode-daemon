import { parseControlEvent, type ControlEvent } from "@/daemon/protocol/control-events"

export interface ControlRPCDispatchResult {
  ok: true
  eventType: ControlEvent["type"]
  result: unknown
}

export interface ControlRPCHandlerContext {
  request: Request
}

export interface ControlRPCChannelOptions {
  handle?: (event: ControlEvent, context: ControlRPCHandlerContext) => Promise<unknown> | unknown
}

export class ControlRPCChannel {
  private readonly handle: (event: ControlEvent, context: ControlRPCHandlerContext) => Promise<unknown> | unknown

  constructor(options: ControlRPCChannelOptions = {}) {
    this.handle = options.handle ?? (() => ({ accepted: true }))
  }

  async dispatch(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== "POST") {
      return Response.json({ ok: false, error: "control-rpc expects POST" }, { status: 405 })
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return Response.json({ ok: false, error: "invalid-json" }, { status: 400 })
    }

    let event: ControlEvent
    try {
      event = parseControlEvent(payload)
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      )
    }

    try {
      const result = await this.handle(event, { request })
      const response: ControlRPCDispatchResult = {
        ok: true,
        eventType: event.type,
        result,
      }
      return Response.json(response)
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      )
    }
  }
}
