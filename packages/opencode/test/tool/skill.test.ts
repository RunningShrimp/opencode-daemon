import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { PermissionNext } from "../../src/permission/next"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

describe("tool.skill", () => {
  test("description lists skill location URL", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const skillPath = path.join(tmp.path, ".opencode", "skill", "tool-skill", "SKILL.md")
          expect(tool.description).toContain(`**tool-skill**: Skill for tool tests.`)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("execute returns skill content block with files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "tool-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        )
        await Bun.write(path.join(skillDir, "scripts", "demo.txt"), "demo")
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async (req) => {
              requests.push(req)
            },
          }

          const result = await tool.execute({ name: "tool-skill" }, ctx)
          const dir = path.join(tmp.path, ".opencode", "skill", "tool-skill")
          const file = path.resolve(dir, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")

          expect(result.metadata.dir).toBe(dir)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(dir).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("throws error when skill not found", async () => {
    await using tmp = await tmpdir({ git: true })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          await expect(tool.execute({ name: "nonexistent-skill" }, ctx)).rejects.toThrow(
            'Skill "nonexistent-skill" not found. Available skills: none',
          )
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("throws error when skill not found with available skills listed", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "existing-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: existing-skill
description: An existing skill.
---

# Existing Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          await expect(tool.execute({ name: "nonexistent-skill" }, ctx)).rejects.toThrow(
            'Skill "nonexistent-skill" not found. Available skills: existing-skill',
          )
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("throws friendly error when permission denied", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "denied-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: denied-skill
description: A skill that will be denied.
---

# Denied Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {
              throw new PermissionNext.DeniedError({ ruleset: [] })
            },
          }

          await expect(tool.execute({ name: "denied-skill" }, ctx)).rejects.toThrow(
            'Permission denied for skill "denied-skill"',
          )
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("description shows no skills message when no skills available", async () => {
    await using tmp = await tmpdir({ git: true })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          expect(tool.description).toContain("No skills are currently available.")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("limits file list to 10 files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "many-files-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: many-files-skill
description: A skill with many files.
---

# Many Files Skill
`,
        )
        for (let i = 1; i <= 15; i++) {
          await Bun.write(path.join(skillDir, `file${i}.txt`), `content ${i}`)
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          const result = await tool.execute({ name: "many-files-skill" }, ctx)
          const fileMatches = result.output.match(/<file>.*?<\/file>/g)
          expect(fileMatches).not.toBeNull()
          expect(fileMatches!.length).toBeLessThanOrEqual(10)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("handles abort signal during file scanning", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "abort-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: abort-skill
description: A skill for testing abort.
---

# Abort Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const controller = new AbortController()
          controller.abort()

          const ctx: Tool.Context = {
            ...baseCtx,
            abort: controller.signal,
            ask: async () => {},
          }

          await expect(tool.execute({ name: "abort-skill" }, ctx)).rejects.toThrow()
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("handles skill with empty content", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "empty-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: empty-skill
description: A skill with empty content.
---

`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          const result = await tool.execute({ name: "empty-skill" }, ctx)
          expect(result.output).toContain('<skill_content name="empty-skill">')
          expect(result.output).toContain("# Skill: empty-skill")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("rethrows non-DeniedError permission errors", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "error-skill")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: error-skill
description: A skill that will error.
---

# Error Skill
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const customError = new Error("Custom permission error")
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {
              throw customError
            },
          }

          await expect(tool.execute({ name: "error-skill" }, ctx)).rejects.toThrow("Custom permission error")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })

  test("handles skill name with special characters", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skill", "skill-with-dashes")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: skill-with-dashes
description: A skill with special characters.
---

# Skill With Dashes
`,
        )
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await SkillTool.init()
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: async () => {},
          }

          const result = await tool.execute({ name: "skill-with-dashes" }, ctx)
          expect(result.output).toContain('<skill_content name="skill-with-dashes">')
          expect(result.metadata.name).toBe("skill-with-dashes")
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
