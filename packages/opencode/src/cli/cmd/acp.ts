import { Log } from "@/util/log"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { MasterBootstrapCoordinator } from "@/daemon/bootstrap/master-bootstrap"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: async (args) => {
    process.env.OPENCODE_CLIENT = "acp"
    await bootstrap(process.cwd(), async () => {
      const namespaceID = "local"
      const coordinator = new MasterBootstrapCoordinator()
      const opts = await resolveNetworkOptions(args)
      const result = await coordinator.ensureMaster({
        namespaceID,
        start: async () => {
          const server = Server.listen(opts)
          const endpoint = `http://${server.hostname}:${server.port}`
          return {
            endpoint,
            pid: process.pid,
            stop: async () => {
              await server.stop(true)
            },
          }
        },
      })

      const sdk = createOpencodeClient({
        baseUrl: result.endpoint,
      })

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          process.stdin.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          process.stdin.on("end", () => controller.close())
          process.stdin.on("error", (err) => controller.error(err))
        },
      })

      const stream = ndJsonStream(input, output)
      const agent = await ACP.init({ sdk })

      new AgentSideConnection((conn) => {
        return agent.create(conn, { sdk })
      }, stream)

      log.info("setup connection")
      process.stdin.resume()
      try {
        await new Promise((resolve, reject) => {
          process.stdin.on("end", resolve)
          process.stdin.on("error", reject)
        })
      } finally {
        if (result.mode === "started") {
          await result.stop()
        }
      }
    })
  },
})
