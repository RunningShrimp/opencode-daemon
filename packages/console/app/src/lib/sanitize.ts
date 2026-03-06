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
 * @returns 安全返回 true，否则返回 false
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin)
    return ALLOWED_PROTOCOLS.includes(parsed.protocol)
  } catch {
    // 如果无法解析为 URL，检查是否是不带协议的相对路径
    return !url.startsWith("javascript:") && !url.startsWith("data:") && !url.startsWith("vbscript:")
  }
}

/**
 * 净化 HTML 内容
 * 移除危险的标签和属性，保留基本格式
 * @param html 要净化的 HTML 字符串
 * @returns 净化后的 HTML 字符串
 */
export function sanitizeHtml(html: string | undefined | null): string {
  if (html === undefined || html === null) return ""

  // 1. 转义 HTML 实体（基本防护）
  let sanitized = escapeHtml(html)

  // 2. 移除危险的事件处理器属性
  const dangerousAttrs = [
    /on\w+\s*=/gi, // onClick, onMouseOver, etc.
    /javascript:/gi,
    /data:/gi,
    /vbscript:/gi,
  ]

  for (const pattern of dangerousAttrs) {
    sanitized = sanitized.replace(pattern, "")
  }

  // 3. 移除危险标签
  const dangerousTags = ["script", "iframe", "object", "embed", "form", "input", "button", "link"]
  for (const tag of dangerousTags) {
    const tagPattern = new RegExp(`<\\s*${tag}[\\s>][^>]*>`, "gi")
    sanitized = sanitized.replace(tagPattern, "")
    const closeTagPattern = new RegExp(`</\\s*${tag}\\s*>`, "gi")
    sanitized = sanitized.replace(closeTagPattern, "")
  }

  // 4. 移除 JavaScript 协议链接
  sanitized = sanitized.replace(/href\s*=\s*["']?\s*javascript:[^"'>\s]*/gi, 'href=""')

  // 5. 移除 data: 协议图片（可选，data: 可能用于内联图片）
  // sanitized = sanitized.replace(/src\s*=\s*["']?\s*data:/gi, 'src=""')

  return sanitized
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
