import { randomUUID } from "node:crypto"
import z from "zod"

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{1,126}[a-z0-9])?$/i

function assertIdentifier(kind: string, value: string) {
  const trimmed = value.trim()
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    throw new Error(`${kind} must match ${IDENTIFIER_PATTERN}`)
  }
  return trimmed
}

function randomID(prefix: string) {
  const suffix = randomUUID().replace(/-/g, "")
  return `${prefix}.${suffix}`
}

function createZodIdentifier(kind: string) {
  return z.string().transform((value, ctx) => {
    try {
      return assertIdentifier(kind, value)
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      })
      return z.NEVER
    }
  })
}

export type NamespaceID = string
export type WorkerID = string
export type LaneID = string
export type ToolchainCellID = string
export type LeaseToken = string
export type ResumeToken = string

export const NamespaceID = {
  make(value: string): NamespaceID {
    return assertIdentifier("NamespaceID", value)
  },
  random(prefix = "ns"): NamespaceID {
    return NamespaceID.make(randomID(prefix))
  },
  zod: createZodIdentifier("NamespaceID"),
}

export const WorkerID = {
  make(value: string): WorkerID {
    return assertIdentifier("WorkerID", value)
  },
  random(prefix = "worker"): WorkerID {
    return WorkerID.make(randomID(prefix))
  },
  zod: createZodIdentifier("WorkerID"),
}

export const LaneID = {
  make(value: string): LaneID {
    return assertIdentifier("LaneID", value)
  },
  random(prefix = "lane"): LaneID {
    return LaneID.make(randomID(prefix))
  },
  zod: createZodIdentifier("LaneID"),
}

export const ToolchainCellID = {
  make(value: string): ToolchainCellID {
    return assertIdentifier("ToolchainCellID", value)
  },
  random(prefix = "cell"): ToolchainCellID {
    return ToolchainCellID.make(randomID(prefix))
  },
  zod: createZodIdentifier("ToolchainCellID"),
}

export const LeaseToken = {
  make(value: string): LeaseToken {
    return assertIdentifier("LeaseToken", value)
  },
  random(prefix = "lease"): LeaseToken {
    return LeaseToken.make(randomID(prefix))
  },
  zod: createZodIdentifier("LeaseToken"),
}

export const ResumeToken = {
  make(value: string): ResumeToken {
    return assertIdentifier("ResumeToken", value)
  },
  random(prefix = "resume"): ResumeToken {
    return ResumeToken.make(randomID(prefix))
  },
  zod: createZodIdentifier("ResumeToken"),
}
