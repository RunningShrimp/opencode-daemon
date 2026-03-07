/**
 * 安全 HTML 工具函数
 * 用于净化用户输入的 HTML 内容，防止 XSS 攻击
 */

/**
 * HTML 实体编码映射
 */
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;",
}

/**
 * 转义 HTML 特殊字符
 * @param text 要转义的文本
 * @returns 转义后的文本
 */
export function escapeHtml(text: string | undefined | null): string {
  if (text === undefined || text === null) return ""
  return text.replace(/[&<>"'/]/g, (char) => HTML_ENTITIES[char] || char)
}

/**
 * 安全的属性值转义
 * @param value 要转义的值
 * @returns 转义后的值
 */
export function escapeAttr(value: string | undefined | null): string {
  if (value === undefined || value === null) return ""
  return value.replace(/[&<>"'`\s]/g, (char) => HTML_ENTITIES[char] || char)
}

/**
 * 允许的协议白名单
 * 仅允许安全的协议
 */
const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:", "tel:"]

/**
 * 验证 URL 是否安全
 * @param url 要验证的 URL
 * @param baseUrl 可选的基础 URL，用于解析相对路径（在 SSR 环境中使用）
 * @returns 安全返回 true，否则返回 false
 */
export function isSafeUrl(url: string, baseUrl?: string): boolean {
  try {
    const base =
      baseUrl ??
      (typeof window !== "undefined" && window.location && window.location.origin
        ? window.location.origin
        : "http://localhost")
    const parsed = new URL(url, base)
    return ALLOWED_PROTOCOLS.includes(parsed.protocol)
  } catch {
    // 如果无法解析为 URL，检查是否是不带协议的相对路径
    return !url.startsWith("javascript:") && !url.startsWith("data:") && !url.startsWith("vbscript:")
  }
}

/**
 * 净化 HTML 内容
 * 使用白名单策略移除危险的标签和属性，保留基本格式
 * @param html 要净化的 HTML 字符串
 * @returns 净化后的 HTML 字符串
 */
export function sanitizeHtml(html: string | undefined | null): string {
  if (html === undefined || html === null) return ""

  // 使用 DOMParser 解析 HTML 字符串
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")
  const body = doc.body

  // 允许的基础格式标签白名单
  const ALLOWED_TAGS = new Set<string>([
    "A",
    "B",
    "I",
    "EM",
    "STRONG",
    "U",
    "S",
    "SPAN",
    "P",
    "BR",
    "DIV",
    "UL",
    "OL",
    "LI",
    "PRE",
    "CODE",
    "BLOCKQUOTE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
  ])

  // 允许的通用属性白名单
  const ALLOWED_ATTRS = new Set<string>([
    "href",
    "src",
    "alt",
    "title",
    "class",
    "id",
    "rel",
    "target",
  ])

  const sanitizeNode = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      const tagName = el.tagName.toUpperCase()

      // 如果标签不在白名单中，则移除标签但保留其子节点（尽量保留文本内容）
      if (!ALLOWED_TAGS.has(tagName)) {
        const parent = el.parentNode
        if (parent) {
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el)
          }
          parent.removeChild(el)
        }
        return
      }

      // 清理不安全属性
      const attributes = Array.from(el.attributes)
      for (const attr of attributes) {
        const name = attr.name.toLowerCase()

        // 移除所有事件处理器属性（onClick 等）
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name)
          continue
        }

        // 只保留白名单属性
        if (!ALLOWED_ATTRS.has(name)) {
          el.removeAttribute(attr.name)
          continue
        }

        // 特殊处理 URL 属性
        if (name === "href" || name === "src") {
          const value = attr.value
          if (!isSafeUrl(value)) {
            el.removeAttribute(attr.name)
          }
        }
      }
    }

    // 递归处理子节点
    let child = node.firstChild
    while (child) {
      const next = child.nextSibling
      sanitizeNode(child)
      child = next
    }
  }

  sanitizeNode(body)
  return body.innerHTML
}

/**
 * 创建安全的文本节点
 * @param text 文本内容
 * @returns 可以安全用于 textContent 的文本
 */
export function createSafeText(text: string | undefined | null): string {
  return escapeHtml(text)
}

/**
 * 验证并净化 URL
 * @param url 原始 URL
 * @returns 安全的 URL，如果不安全返回空字符串
 */
export function sanitizeUrl(url: string | undefined | null): string {
  if (!url) return ""
  if (isSafeUrl(url)) return url
  return ""
}
