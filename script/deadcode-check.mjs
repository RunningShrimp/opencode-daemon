import { execSync } from "node:child_process"

const targets = [
  { cwd: "packages/opencode", maxUnusedFiles: 6, maxUnresolvedImports: 0 },
  { cwd: "packages/app", maxUnusedFiles: 10, maxUnresolvedImports: 0 },
  { cwd: "packages/web", maxUnusedFiles: 1, maxUnresolvedImports: 0 },
]

const root = process.cwd()
const failures = []

function runKnip(cwd) {
  const command = `bunx knip --reporter json --no-progress --config "${root}/knip.json"`
  try {
    return execSync(command, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    })
  } catch (error) {
    return error.stdout
  }
}

for (const target of targets) {
  const json = runKnip(`${root}/${target.cwd}`)
  const result = JSON.parse(json)

  const unusedFiles = Array.isArray(result.files) ? result.files.length : 0
  const unresolvedImports = Array.isArray(result.issues)
    ? result.issues.reduce(
        (sum, issue) => sum + (Array.isArray(issue.unresolved) ? issue.unresolved.length : 0),
        0,
      )
    : 0

  console.log(
    `${target.cwd}: unusedFiles=${unusedFiles}/${target.maxUnusedFiles}, unresolvedImports=${unresolvedImports}/${target.maxUnresolvedImports}`,
  )

  if (unusedFiles > target.maxUnusedFiles || unresolvedImports > target.maxUnresolvedImports) {
    failures.push(
      `${target.cwd} exceeded threshold: unusedFiles=${unusedFiles} unresolvedImports=${unresolvedImports}`,
    )
  }
}

if (failures.length > 0) {
  console.error("\nDead code check failed:")
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}
