import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { $ } from "bun"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "./instance"
import { FileWatcher } from "@/file/watcher"
import { getOrSet } from "@/util/cache"
import { throttle } from "@/util/throttle"

const log = Log.create({ service: "vcs" })

// 分支检查缓存 TTL: 5秒
// 注意: throttle 已经提供了1秒的节流，此缓存主要用于直接调用 currentBranch() 的场景
const GIT_BRANCH_CACHE_TTL = 5000

export namespace Vcs {
  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  async function currentBranch() {
    // 使用缓存避免频繁调用 git rev-parse
    const cacheKey = `git-branch:${Instance.worktree}`
    return getOrSet(
      "idempotency",
      cacheKey,
      async () => {
        return $`git rev-parse --abbrev-ref HEAD`
          .quiet()
          .nothrow()
          .cwd(Instance.worktree)
          .text()
          .then((x) => x.trim())
          .catch(() => undefined)
      },
      { ttl: GIT_BRANCH_CACHE_TTL },
    ) as Promise<string | undefined>
  }

  const state = Instance.state(
    async () => {
      if (Instance.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await currentBranch()
      log.info("initialized", { branch: current })

      // 使用 throttle 节流，避免频繁触发分支检查
      const throttledCheck = throttle(async (evt: { properties: { file: string } }) => {
        if (evt.properties.file.endsWith("HEAD")) return
        const next = await currentBranch()
        if (next !== current) {
          log.info("branch changed", { from: current, to: next })
          current = next
          Bus.publish(Event.BranchUpdated, { branch: next })
        }
      }, 1000) // 最多每秒检查一次

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, throttledCheck)

      return {
        branch: async () => current,
        unsubscribe,
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  export async function init() {
    return state()
  }

  export async function branch() {
    return await state().then((s) => s.branch())
  }
}
