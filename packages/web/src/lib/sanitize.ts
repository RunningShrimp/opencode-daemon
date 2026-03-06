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
 */
const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:", "tel:"]

/**
 * 验证 URL 是否安全
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost")
    return ALLOWED_PROTOCOLS.includes(parsed.protocol)
  } catch {
    return !url.startsWith("javascript:") && !url.startsWith("data:") && !url.startsWith("vbscript:")
  }
}

/**
 * 净化 HTML 内容
 */
export function sanitizeHtml(html: string | undefined | null): string {
  if (html === undefined || html === null) return ""

  let sanitized = escapeHtml(html)

  // 移除危险的事件处理器
  sanitized = sanitized.replace(/on\w+\s*=/gi, "")
  sanitized = sanitized.replace(/javascript:/gi, "")
  sanitized = sanitized.replace(/data:/gi, "")
  sanitized = sanitized.replace(/vbscript:/gi, "")

  // 移除危险标签
  const dangerousTags = ["script", "iframe", "object", "embed", "form"]
  for (const tag of dangerousTags) {
    sanitized = sanitized.replace(new RegExp(`<\\s*${tag}[\\s>][^>]*>`, "gi"), "")
    sanitized = sanitized.replace(new RegExp(`</\\s*${tag}\\s*>`, "gi"), "")
  }

  // 移除 JavaScript 协议链接
  sanitized = sanitized.replace(/href\s*=\s*["']?\s*javascript:[^"'>\s]*/gi, 'href=""')

  return sanitized
}

export function sanitizeUrl(url: string | undefined | null): string {
  if (!url) return ""
  if (isSafeUrl(url)) return url
  return ""
}
