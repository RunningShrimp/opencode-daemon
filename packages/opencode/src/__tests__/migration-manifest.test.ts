import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  assertBundledMigrations,
  loadMigrationJournal,
  loadRequiredMigrationJournal,
} from "../storage/migration-manifest"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createMigrationRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-migration-manifest-"))
  tempRoots.push(root)
  return root
}

function writeMigration(root: string, name: string, sql: string) {
  const migrationDir = path.join(root, name)
  mkdirSync(migrationDir, { recursive: true })
  writeFileSync(path.join(migrationDir, "migration.sql"), sql)
}

describe("migration manifest", () => {
  test("loads timestamped migrations in chronological order", () => {
    const root = createMigrationRoot()
    writeMigration(root, "20260318020816_init", "CREATE TABLE project (id text primary key);")
    writeMigration(root, "20260319010101_followup", "ALTER TABLE project ADD COLUMN name text;")

    const entries = loadRequiredMigrationJournal(root)

    expect(entries.map((entry) => entry.name)).toEqual([
      "20260318020816_init",
      "20260319010101_followup",
    ])
    expect(entries[0]?.sql).toContain("CREATE TABLE project")
    expect(entries[1]?.sql).toContain("ALTER TABLE project")
  })

  test("rejects migration directories that are missing migration.sql", () => {
    const root = createMigrationRoot()
    mkdirSync(path.join(root, "20260318020816_init"), { recursive: true })

    expect(() => loadMigrationJournal(root)).toThrow(/missing migration\.sql/i)
  })

  test("rejects packaged builds without any generated migrations", () => {
    const root = createMigrationRoot()

    expect(() => loadRequiredMigrationJournal(root)).toThrow(/No generated migrations were found/i)
    expect(() => assertBundledMigrations([])).toThrow(/Bundled runtime is missing schema migrations/i)
  })
})