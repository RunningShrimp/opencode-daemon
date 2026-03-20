import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { MasterBootstrapCoordinator } from "@/daemon/bootstrap/master-bootstrap"

function authHeaders() {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  }
}

function shouldConfigurePublicListener(opts: { hostname: string; port: number; mdns?: boolean; cors?: string[] }) {
  const explicit = ["--hostname", "--port", "--mdns", "--mdns-domain", "--cors"].some((flag) => process.argv.includes(flag))
  if (!explicit) return false
  if (opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1") return true
  if (opts.port !== 0) return true
  if (opts.mdns) return true
  if ((opts.cors?.length ?? 0) > 0) return true
  return false
}

async function configureAttachedPublicListener(endpoint: string, opts: Awaited<ReturnType<typeof resolveNetworkOptions>>) {
  const response = await fetch(new URL("/global/public-listener", endpoint), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(authHeaders() ?? {}),
    },
    body: JSON.stringify({
      hostname: opts.hostname,
      port: opts.port,
      mdns: opts.mdns,
      mdnsDomain: opts.mdnsDomain,
      cors: opts.cors,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Failed to configure public listener on attached master (${response.status}): ${body}`)
  }

  const payload = (await response.json().catch(() => undefined)) as { url?: string } | undefined
  return payload?.url
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }

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

    if (result.mode === "attached") {
      if (shouldConfigurePublicListener(opts)) {
        const configuredURL = await configureAttachedPublicListener(result.endpoint, opts)
        console.log(
          configuredURL
            ? `opencode master already running at ${result.endpoint}; public listener configured at ${configuredURL}`
            : `opencode master already running at ${result.endpoint}; public listener configured`,
        )
        return
      }

      console.log(`opencode master already running at ${result.endpoint}; attach mode enabled`)
      return
    }

    console.log(`opencode server listening on ${result.endpoint}`)

    const shutdown = async () => {
      await result.stop()
    }

    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0))
    })
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0))
    })

    await new Promise(() => {})
    await shutdown()
  },
})
