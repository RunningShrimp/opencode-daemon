import { existsSync, readFileSync, readdirSync } from "fs"
import path from "path"

export interface MigrationJournalEntry {
  sql: string
  timestamp: number
  name: string
}

const MIGRATION_DIRECTORY_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:_.+)?$/

function toTimestamp(tag: string) {
  const match = MIGRATION_DIRECTORY_PATTERN.exec(tag)
  if (!match) {
    return 0
  }

  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function loadMigrationEntry(rootDir: string, name: string): MigrationJournalEntry {
  const file = path.join(rootDir, name, "migration.sql")
  if (!existsSync(file)) {
    throw new Error(
      `Migration directory \"${name}\" is missing migration.sql. Regenerate migrations with \"bun run db generate --name <slug>\" before building a packaged binary.`,
    )
  }

  const sql = readFileSync(file, "utf-8").trim()
  if (!sql) {
    throw new Error(
      `Migration directory \"${name}\" has an empty migration.sql. Regenerate migrations with \"bun run db generate --name <slug>\" before building a packaged binary.`,
    )
  }

  return {
    sql,
    timestamp: toTimestamp(name),
    name,
  }
}

/**
 * Loads the on-disk Drizzle migration journal from the standard per-folder layout.
 */
export function loadMigrationJournal(rootDir: string): MigrationJournalEntry[] {
  const directories = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MIGRATION_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name)

  return directories
    .map((name) => loadMigrationEntry(rootDir, name))
    .sort((first, second) => first.timestamp - second.timestamp)
}

/**
 * Ensures packaged builds only proceed when at least one valid schema migration exists.
 */
export function loadRequiredMigrationJournal(rootDir: string): MigrationJournalEntry[] {
  const entries = loadMigrationJournal(rootDir)
  if (entries.length === 0) {
    throw new Error(
      `No generated migrations were found in \"${rootDir}\". Run \"bun run db generate --name <slug>\" before building a packaged binary.`,
    )
  }
  return entries
}

/**
 * Rejects bundled runtimes that were compiled without schema migrations.
 */
export function assertBundledMigrations(entries: readonly MigrationJournalEntry[]): MigrationJournalEntry[] {
  if (entries.length === 0) {
    throw new Error(
      'Bundled runtime is missing schema migrations. Rebuild after generating migrations with "bun run db generate --name <slug>".',
    )
  }
  return entries.map((entry) => ({ ...entry }))
}