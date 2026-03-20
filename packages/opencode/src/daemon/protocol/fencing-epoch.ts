const EPOCH_PATTERN = /^epoch-v1:(\d{13}):(\d+):(\d+)$/

export type FencingEpoch = string & { readonly __brand: "FencingEpoch" }

export interface ParsedFencingEpoch {
  raw: FencingEpoch
  timestampMs: number
  processID: number
  sequence: number
}

export class FencingEpochGenerator {
  private lastTimestamp = 0
  private sequence = 0

  constructor(private readonly processID = process.pid) {}

  next(now = Date.now()): FencingEpoch {
    const timestamp = Math.max(now, this.lastTimestamp)
    if (timestamp === this.lastTimestamp) {
      this.sequence += 1
    } else {
      this.sequence = 0
      this.lastTimestamp = timestamp
    }

    const value = `epoch-v1:${timestamp}:${this.processID}:${this.sequence}`
    return parseFencingEpoch(value).raw
  }
}

export function parseFencingEpoch(value: string): ParsedFencingEpoch {
  const match = value.match(EPOCH_PATTERN)
  if (!match) {
    throw new Error("Invalid FencingEpoch format")
  }

  const [, timestampText, processIDText, sequenceText] = match
  return {
    raw: value as FencingEpoch,
    timestampMs: Number(timestampText),
    processID: Number(processIDText),
    sequence: Number(sequenceText),
  }
}

export function compareFencingEpoch(left: FencingEpoch, right: FencingEpoch): number {
  const a = parseFencingEpoch(left)
  const b = parseFencingEpoch(right)

  if (a.timestampMs !== b.timestampMs) {
    return a.timestampMs < b.timestampMs ? -1 : 1
  }

  if (a.sequence !== b.sequence) {
    return a.sequence < b.sequence ? -1 : 1
  }

  if (a.processID !== b.processID) {
    return a.processID < b.processID ? -1 : 1
  }

  return 0
}

export function isEpochNewer(candidate: FencingEpoch, baseline: FencingEpoch) {
  return compareFencingEpoch(candidate, baseline) > 0
}
