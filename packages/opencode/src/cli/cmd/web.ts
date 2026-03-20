import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { MasterBootstrapCoordinator } from "@/daemon/bootstrap/master-bootstrap"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
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
    const endpoint = new URL(result.endpoint)
    const port = endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80

    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (result.mode === "attached") {
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Attached to:      ", UI.Style.TEXT_NORMAL, result.endpoint)
      open(result.endpoint).catch(() => {})
      return
    }

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${port}`,
        )
      }

      // Open localhost in browser
      open(localhostUrl.toString()).catch(() => {})
    } else {
      const displayUrl = result.endpoint
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

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
