import { AIRuntimeSupervisor } from "@/daemon/ai-runtime/ai-runtime-supervisor"
import { parseEmbedRequest } from "@/daemon/ai-runtime/ai-runtime-protocol"

export interface EmbeddingIPCChannelOptions {
  supervisor?: Pick<AIRuntimeSupervisor, "embed" | "stats">
}

export class EmbeddingIPCChannel {
  private readonly supervisor: Pick<AIRuntimeSupervisor, "embed" | "stats">

  constructor(options: EmbeddingIPCChannelOptions = {}) {
    this.supervisor = options.supervisor ?? new AIRuntimeSupervisor()
  }

  async dispatch(request: Request): Promise<Response> {
    const method = request.method.toUpperCase()

    if (method === "GET") {
      try {
        const stats = await this.supervisor.stats()
        return Response.json({ ok: true, stats })
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

    if (method !== "POST") {
      return Response.json({ ok: false, error: "embedding-ipc expects GET or POST" }, { status: 405 })
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return Response.json({ ok: false, error: "invalid-json" }, { status: 400 })
    }

    try {
      parseEmbedRequest(payload)
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
      const response = await this.supervisor.embed(payload)
      return Response.json({ ok: true, response })
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
}
