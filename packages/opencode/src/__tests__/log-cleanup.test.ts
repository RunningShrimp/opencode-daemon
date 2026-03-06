/**
 * Log Module Unit Tests
 *
 * Tests for log cleanup functionality and configuration
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"

describe("Log Cleanup", () => {
  let testDir: string

  beforeEach(async () => {
    // Create a temporary directory for testing
    testDir = await mkdtemp(path.join(tmpdir(), "log-cleanup-test-"))
  })

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test("cleanup keeps most recent files when exceeding limit", async () => {
    // Create 7 log files (more than MAX_LOG_FILES = 5)
    for (let i = 0; i < 7; i++) {
      const filename = `2026-01-01T${String(i).padStart(6, "0")}.log`
      await writeFile(path.join(testDir, filename), `test content ${i}`)
      // Add small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // Run cleanup
    await Log.cleanupLogs(testDir)

    // Check remaining files
    const files = await fs.readdir(testDir)
    const logFiles = files.filter((f) => f.endsWith(".log"))

    // Should keep only 5 most recent files
    expect(logFiles.length).toBe(5)
  })

  test("cleanup does nothing when at or below limit", async () => {
    // Create 3 log files (at or below MAX_LOG_FILES = 5)
    for (let i = 0; i < 3; i++) {
      const filename = `2026-01-01T${String(i).padStart(6, "0")}.log`
      await writeFile(path.join(testDir, filename), `test content ${i}`)
    }

    // Run cleanup
    await Log.cleanupLogs(testDir)

    // Check remaining files
    const files = await fs.readdir(testDir)
    const logFiles = files.filter((f) => f.endsWith(".log"))

    // Should keep all 3 files
    expect(logFiles.length).toBe(3)
  })

  test("cleanup handles empty directory", async () => {
    // Run cleanup on empty directory
    await Log.cleanupLogs(testDir)

    // Should not throw
    const files = await fs.readdir(testDir)
    expect(files.length).toBe(0)
  })

  test("cleanup handles non-existent directory gracefully", async () => {
    const nonExistentDir = path.join(tmpdir(), "non-existent-dir-" + Date.now().toString())

    // Should not throw - the cleanup function silently ignores errors
    // Note: Glob.scan may not throw for non-existent directories
    const result = await Log.cleanupLogs(nonExistentDir)
    expect(result).toBeUndefined()
  })

  test("cleanup sorts files correctly and keeps newest", async () => {
    // Create files with timestamps that are not in order
    const files = [
      { name: "2026-01-01T000001.log", content: "oldest" },
      { name: "2026-01-01T000005.log", content: "newest" },
      { name: "2026-01-01T000003.log", content: "middle" },
      { name: "2026-01-01T000002.log", content: "second" },
      { name: "2026-01-01T000004.log", content: "fourth" },
      { name: "2026-01-01T000006.log", content: "should-be-kept" },
    ]

    // Create files in random order
    for (const file of files) {
      await writeFile(path.join(testDir, file.name), file.content)
    }

    // Run cleanup
    await Log.cleanupLogs(testDir)

    // Check remaining files
    const remainingFiles = await fs.readdir(testDir)
    const logFiles = remainingFiles.filter((f) => f.endsWith(".log")).sort()

    // Should keep 5 newest files
    expect(logFiles.length).toBe(5)

    // Should include the newest file
    expect(logFiles).toContain("2026-01-01T000006.log")
    // Should not include the oldest file
    expect(logFiles).not.toContain("2026-01-01T000001.log")
  })

  test("cleanup handles mixed file types in directory", async () => {
    // Create a mix of log files and other files
    await writeFile(path.join(testDir, "2026-01-01T000001.log"), "log content")
    await writeFile(path.join(testDir, "2026-01-01T000002.log"), "log content")
    await writeFile(path.join(testDir, "2026-01-01T000003.log"), "log content")
    await writeFile(path.join(testDir, "2026-01-01T000004.log"), "log content")
    await writeFile(path.join(testDir, "2026-01-01T000005.log"), "log content")
    await writeFile(path.join(testDir, "2026-01-01T000006.log"), "log content")
    await writeFile(path.join(testDir, "2026-01-01T000007.log"), "log content")
    await writeFile(path.join(testDir, "readme.txt"), "not a log file")
    await writeFile(path.join(testDir, "data.json"), "{}")

    // Run cleanup
    await Log.cleanupLogs(testDir)

    // Check remaining files
    const files = await fs.readdir(testDir)
    const logFiles = files.filter((f) => f.endsWith(".log"))
    const otherFiles = files.filter((f) => !f.endsWith(".log"))

    // Should keep 5 log files
    expect(logFiles.length).toBe(5)
    // Should not delete other file types
    expect(otherFiles.length).toBe(2)
  })
})

describe("Log Level Configuration", () => {
  test("Level enum is properly defined", () => {
    expect(Log.Level.options).toContain("DEBUG")
    expect(Log.Level.options).toContain("INFO")
    expect(Log.Level.options).toContain("WARN")
    expect(Log.Level.options).toContain("ERROR")
  })
})
