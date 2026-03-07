import { Log } from "./log"

const log = Log.create({ service: "metrics" })

export interface MetricValue {
  name: string
  value: number
  unit: string
  timestamp: number
  tags: Record<string, string>
}

export interface MetricSummary {
  name: string
  count: number
  sum: number
  min: number
  max: number
  avg: number
  lastUpdated: number
}

export class Metrics {
  private counters: Map<string, number> = new Map()
  private gauges: Map<string, number> = new Map()
  private histograms: Map<string, number[]> = new Map()
  private maxHistogramSize = 1000

  increment(name: string, value: number = 1, tags: Record<string, string> = {}): void {
    const key = this.buildKey(name, tags)
    const current = this.counters.get(key) || 0
    this.counters.set(key, current + value)
    log.debug("counter incremented", { name, value, total: current + value })
  }

  decrement(name: string, value: number = 1, tags: Record<string, string> = {}): void {
    this.increment(name, -value, tags)
  }

  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    const key = this.buildKey(name, tags)
    this.gauges.set(key, value)
    log.debug("gauge set", { name, value })
  }

  histogram(name: string, value: number, tags: Record<string, string> = {}): void {
    const key = this.buildKey(name, tags)
    let values = this.histograms.get(key) || []
    values.push(value)

    if (values.length > this.maxHistogramSize) {
      values = values.slice(-this.maxHistogramSize)
    }

    this.histograms.set(key, values)
    log.debug("histogram recorded", { name, value })
  }

  timing(name: string, durationMs: number, tags: Record<string, string> = {}): void {
    this.histogram(`${name}_ms`, durationMs, tags)
  }

  time<T>(name: string, fn: () => T, tags: Record<string, string> = {}): T {
    const start = Date.now()
    try {
      return fn()
    } finally {
      this.timing(name, Date.now() - start, tags)
    }
  }

  async timeAsync<T>(name: string, fn: () => Promise<T>, tags: Record<string, string> = {}): Promise<T> {
    const start = Date.now()
    try {
      return await fn()
    } finally {
      this.timing(name, Date.now() - start, tags)
    }
  }

  getCounter(name: string, tags: Record<string, string> = {}): number {
    const key = this.buildKey(name, tags)
    return this.counters.get(key) || 0
  }

  getGauge(name: string, tags: Record<string, string> = {}): number | undefined {
    const key = this.buildKey(name, tags)
    return this.gauges.get(key)
  }

  getHistogramSummary(name: string, tags: Record<string, string> = {}): MetricSummary | null {
    const key = this.buildKey(name, tags)
    const values = this.histograms.get(key)

    if (!values || values.length === 0) {
      return null
    }

    const sum = values.reduce((a, b) => a + b, 0)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const avg = sum / values.length

    return {
      name,
      count: values.length,
      sum,
      min,
      max,
      avg,
      lastUpdated: Date.now(),
    }
  }

  private buildKey(name: string, tags: Record<string, string>): string {
    const tagStr = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",")

    return tagStr ? `${name}:{${tagStr}}` : name
  }

  getAllMetrics(): {
    counters: Record<string, number>
    gauges: Record<string, number>
    histograms: Record<string, MetricSummary>
  } {
    const counters: Record<string, number> = {}
    const gauges: Record<string, number> = {}
    const histograms: Record<string, MetricSummary> = {}

    for (const [key, value] of this.counters) {
      counters[key] = value
    }

    for (const [key, value] of this.gauges) {
      gauges[key] = value
    }

    for (const [key] of this.histograms) {
      const summary = this.getHistogramSummary(key)
      if (summary) {
        histograms[key] = summary
      }
    }

    return { counters, gauges, histograms }
  }

  clear(): void {
    this.counters.clear()
    this.gauges.clear()
    this.histograms.clear()
    log.info("metrics cleared")
  }
}

export const globalMetrics = new Metrics()

export function createMetrics(): Metrics {
  return new Metrics()
}
