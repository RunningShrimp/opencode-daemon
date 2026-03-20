import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"
import { DaemonInfoService } from "@/daemon/master/daemon-info"
import {
  configurePublicListener,
  disablePublicListener,
  getPublicListenerStatus,
  type PublicListenerOptions,
} from "../public-listener"

const log = Log.create({ service: "server" })

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.VERSION })
      },
    )
    .get(
      "/daemon-info",
      describeRoute({
        summary: "Get daemon info",
        description: "Get daemon diagnostics including master, worker, lane, and toolchain cell metrics.",
        operationId: "global.daemon-info",
        responses: {
          200: {
            description: "Daemon diagnostics",
            content: {
              "application/json": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      async (c) => {
        const service = new DaemonInfoService({
          publicListenerProvider: () => getPublicListenerStatus(),
        })
        const payload = await service.collect("local")
        return c.json(payload)
      },
    )
    .get(
      "/public-listener",
      describeRoute({
        summary: "Get public listener status",
        description: "Get the current optional public listener status on this master process.",
        operationId: "global.public-listener.get",
        responses: {
          200: {
            description: "Public listener status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    active: z.boolean(),
                    url: z.string().optional(),
                    hostname: z.string().optional(),
                    port: z.number().optional(),
                    options: z
                      .object({
                        hostname: z.string(),
                        port: z.number(),
                        mdns: z.boolean().optional(),
                        mdnsDomain: z.string().optional(),
                        cors: z.array(z.string()).optional(),
                      })
                      .optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(getPublicListenerStatus())
      },
    )
    .put(
      "/public-listener",
      describeRoute({
        summary: "Configure public listener",
        description: "Create or reconfigure the optional public listener on this master process.",
        operationId: "global.public-listener.configure",
        responses: {
          200: {
            description: "Configured public listener status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    active: z.boolean(),
                    url: z.string().optional(),
                    hostname: z.string().optional(),
                    port: z.number().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          hostname: z.string().min(1),
          port: z.number().int().min(0).max(65535),
          mdns: z.boolean().optional(),
          mdnsDomain: z.string().optional(),
          cors: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json") as PublicListenerOptions
        const status = await configurePublicListener(body)
        return c.json(status)
      },
    )
    .delete(
      "/public-listener",
      describeRoute({
        summary: "Disable public listener",
        description: "Disable the optional public listener on this master process.",
        operationId: "global.public-listener.disable",
        responses: {
          200: {
            description: "Public listener disabled",
            content: {
              "application/json": {
                schema: resolver(z.object({ active: z.literal(false) })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await disablePublicListener())
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamSSE(c, async (stream) => {
          stream.writeSSE({
            data: JSON.stringify({
              payload: {
                type: "server.connected",
                properties: {},
              },
            }),
          })
          async function handler(event: any) {
            await stream.writeSSE({
              data: JSON.stringify(event),
            })
          }
          GlobalBus.on("event", handler)

          // Send heartbeat every 10s to prevent stalled proxy streams.
          const heartbeat = setInterval(() => {
            stream.writeSSE({
              data: JSON.stringify({
                payload: {
                  type: "server.heartbeat",
                  properties: {},
                },
              }),
            })
          }, 10_000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              clearInterval(heartbeat)
              GlobalBus.off("event", handler)
              resolve()
              log.info("global event disconnected")
            })
          })
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const next = await Config.updateGlobal(config)
        return c.json(next)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    ),
)
