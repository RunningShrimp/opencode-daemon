import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo, Show, Match, Switch } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
  onCancel?: () => void
  class?: string
}

// 预编译正则表达式（避免在循环中重复创建）
const WHITESPACE_REGEX = /\s+/g

// 空选项数组 - 显式类型
const EMPTY_OPTIONS: DialogSelectOption<string>[] = []

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  dialog.setSize("large")

  // 添加自定义回调处理
  const handleCancel = () => {
    props.onCancel?.()
    dialog.clear()
  }

  const [skills, { refetch }] = createResource(async () => {
    try {
      const result = await sdk.client.app.skills()
      return { data: result.data ?? [], error: null }
    } catch (error) {
      return { data: [], error: error as Error }
    }
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills()?.data ?? []
    if (list.length === 0) return []

    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => ({
      title: skill.name.padEnd(maxWidth),
      // 使用预编译的正则表达式
      description: skill.description?.replace(WHITESPACE_REGEX, " ").trim() ?? "",
      value: skill.name,
      category: "Skills",
      onSelect: () => {
        props.onSelect(skill.name)
        dialog.clear()
      },
    }))
  })

  // 计算状态
  const isLoading = () => skills.loading
  const hasError = () => skills()?.error !== null && skills()?.error !== undefined
  const isEmpty = () => !isLoading() && !hasError() && options().length === 0

  return (
    <Switch>
      {/* Loading 状态 */}
      <Match when={isLoading()}>
        <DialogSelect
          title="Skills"
          placeholder="Loading skills..."
          options={EMPTY_OPTIONS}
        />
      </Match>

      {/* Error 状态 */}
      <Match when={hasError()}>
        <DialogSelect
          title="Skills"
          placeholder="Error loading skills"
          options={EMPTY_OPTIONS}
        >
          <div style={{ padding: "1rem", color: "var(--color-error)" }}>
            Failed to load skills. Please try again.
            <button
              onClick={() => refetch()}
              style={{
                "margin-left": "0.5rem",
                background: "none",
                border: "1px solid currentColor",
                padding: "0.25rem 0.5rem",
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          </div>
        </DialogSelect>
      </Match>

      {/* Empty 状态 */}
      <Match when={isEmpty()}>
        <DialogSelect
          title="Skills"
          placeholder="No skills available"
          options={EMPTY_OPTIONS}
        >
          <div style={{ padding: "1rem", "text-align": "center", color: "var(--color-muted)" }}>
            No skills found. Create a skill in your project to get started.
          </div>
        </DialogSelect>
      </Match>

      {/* 正常状态 */}
      <Match when={!isLoading() && !hasError() && !isEmpty()}>
        <DialogSelect
          title="Skills"
          placeholder="Search skills..."
          options={options()}
        />
      </Match>
    </Switch>
  )
}
