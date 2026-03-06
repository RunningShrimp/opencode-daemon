/**
 * Log Module
 *
 * Provides structured logging with file and console output.
 * Implements log rotation and cleanup to prevent disk space leaks.
 */

import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import { Global } from "../global"
import z from "zod"
import { Glob } from "./glob"
import { WriteBuffer } from "./write-buffer"

/**
 * Maximum number of log files to retain
 * Used to prevent disk space exhaustion
 */
const MAX_LOG_FILES = 5

/**
 * Log cleanup interval in milliseconds (1 hour)
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Reference to the cleanup interval timer
 */
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
  }

  let logpath = ""
  export function file() {
    return logpath
  }
  let write = (msg: any) => {
    process.stderr.write(msg)
    return msg.length
  }
  let buffer: WriteBuffer | null = null

  /**
   * Clean up old log files in the specified directory
   * Keeps only the most recent MAX_LOG_FILES
   * Exported as a namespace member for testing
   */
  export async function cleanupLogs(dir: string): Promise<void> {
    try {
      const files = await Glob.scan("????-??-??T??????.log", {
        cwd: dir,
        absolute: true,
        include: "file",
      })

      // No cleanup needed if at or below the limit
      if (files.length <= MAX_LOG_FILES) {
        return
      }

      // Sort files by name (which represents timestamp)
      const sortedFiles = files.sort((a, b) => a.localeCompare(b))

      // Delete all but the most recent MAX_LOG_FILES
      const filesToDelete = sortedFiles.slice(0, sortedFiles.length - MAX_LOG_FILES)

      // Delete in parallel
      await Promise.all(
        filesToDelete.map(async (file) => {
          try {
            await fs.unlink(file)
          } catch {
            // Ignore errors during deletion
          }
        })
      )
    } catch {
      // Silently ignore cleanup errors to prevent affecting main functionality
    }
  }

  /**
   * Start periodic log cleanup
   * Cleans up old log files every hour
   */
  function startPeriodicCleanup(): void {
    if (cleanupIntervalId !== null) {
      return // Already running
    }

    cleanupIntervalId = setInterval(() => {
      cleanupLogs(Global.Path.log).catch(() => {})
    }, CLEANUP_INTERVAL_MS)

    // Allow the timer to not prevent process exit
    cleanupIntervalId.unref()
  }

  /**
   * Stop periodic log cleanup
   */
  export function stopPeriodicCleanup(): void {
    if (cleanupIntervalId !== null) {
      clearInterval(cleanupIntervalId)
      cleanupIntervalId = null
    }
  }

  export async function init(options: Options) {
    if (options.level) level = options.level

    // Initial cleanup on startup
    await cleanupLogs(Global.Path.log)

    // Start periodic cleanup
    startPeriodicCleanup()

    if (options.print) return

    logpath = path.join(
      Global.Path.log,
      options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    await fs.truncate(logpath).catch(() => {})

    const stream = createWriteStream(logpath, { flags: "a" })
    buffer = new WriteBuffer(
      {
        maxSize: 64 * 1024,
        minFlushSize: 4 * 1024,
        flushInterval: 500,
      },
      (data: Buffer) => {
        stream.write(data)
      },
    )

    write = async (msg: any) => {
      const data = typeof msg === "string" ? msg : String(msg)
      buffer?.write(data)
      return data.length
    }
  }

  function formatError(error: Error, depth = 0): string {
    const result = error.message
    return error.cause instanceof Error && depth < 10
      ? result + " Caused by: " + formatError(error.cause, depth + 1)
      : result
  }

  let last = Date.now()
  export function create(tags?: Record<string, any>) {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(message: any, extra?: Record<string, any>) {
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === "object") return prefix + JSON.stringify(value)
          return prefix + value
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
    }
    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldLog("DEBUG")) {
          write("DEBUG " + build(message, extra))
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          write("INFO  " + build(message, extra))
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          write("ERROR " + build(message, extra))
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          write("WARN  " + build(message, extra))
        }
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }

  export async function flush(): Promise<void> {
    if (buffer) {
      await buffer.flush()
    }
  }
}
