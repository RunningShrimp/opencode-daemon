import { marked } from "marked"
import { codeToHtml } from "shiki"
import markedShiki from "marked-shiki"
import { createOverflow, useShareMessages } from "./common"
import { CopyButton } from "./copy-button"
import { createResource, createSignal } from "solid-js"
import { escapeAttr } from "../../lib/sanitize"
import style from "./content-markdown.module.css"

const markedWithShiki = marked.use(
  {
    renderer: {
      link({ href, title, text }) {
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : ""
        // href 已由 marked 库进行基本转义，这里额外添加安全属性
        return `<a href="${escapeAttr(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
      },
    },
  },
  markedShiki({
    highlight(code, lang) {
      return codeToHtml(code, {
        lang: lang || "text",
        themes: {
          light: "github-light",
          dark: "github-dark",
        },
      })
    },
  }),
)

interface Props {
  text: string
  expand?: boolean
  highlight?: boolean
}
export function ContentMarkdown(props: Props) {
  const [html] = createResource(
    () => strip(props.text),
    async (markdown) => {
      return markedWithShiki.parse(markdown)
    },
  )
  const [expanded, setExpanded] = createSignal(false)
  const overflow = createOverflow()
  const messages = useShareMessages()

  return (
    <div
      class={style.root}
      data-highlight={props.highlight === true ? true : undefined}
      data-expanded={expanded() || props.expand === true ? true : undefined}
    >
      <div data-slot="markdown" ref={overflow.ref} innerHTML={html()} />

      {!props.expand && overflow.status && (
        <button
          type="button"
          data-component="text-button"
          data-slot="expand-button"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded() ? messages.show_less : messages.show_more}
        </button>
      )}
      <CopyButton text={props.text} />
    </div>
  )
}

function strip(text: string): string {
  const wrappedRe = /^\s*<([A-Za-z]\w*)>\s*([\s\S]*?)\s*<\/\1>\s*$/
  const match = text.match(wrappedRe)
  return match ? match[2] : text
}
