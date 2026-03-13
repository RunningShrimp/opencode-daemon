#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"

const repo = "/Users/didi/Desktop/opencode/opencode-daemon"
const outputDir = path.join(repo, "tmp")

const files = [
  {
    name: "glm",
    input: path.join(outputDir, "glm-tui-proof.txt"),
    output: path.join(outputDir, "glm-tui-proof.svg"),
    title: "OpenCode TUI Proof - GLM-5",
  },
  {
    name: "minimax",
    input: path.join(outputDir, "minimax-tui-proof.txt"),
    output: path.join(outputDir, "minimax-tui-proof.svg"),
    title: "OpenCode TUI Proof - MiniMax-M2.5",
  },
]

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function buildSvg(title, content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const fontSize = 16
  const lineHeight = 24
  const paddingX = 28
  const paddingY = 34
  const width = 1600
  const headerHeight = 54
  const height = paddingY * 2 + headerHeight + lines.length * lineHeight
  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight
      return `<tspan x="${paddingX}" dy="${dy}">${escapeXml(line)}</tspan>`
    })
    .join("")

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0a0a0a"/>
  <rect x="18" y="18" width="${width - 36}" height="${height - 36}" rx="16" fill="#111214" stroke="#2d3138"/>
  <text x="${paddingX}" y="${paddingY}" fill="#e5e7eb" font-family="Menlo, Monaco, 'Courier New', monospace" font-size="28" font-weight="700">${escapeXml(title)}</text>
  <text x="${paddingX}" y="${paddingY + 26}" fill="#7dd3fc" font-family="Menlo, Monaco, 'Courier New', monospace" font-size="14">Derived from verified tmux source-run capture</text>
  <text x="${paddingX}" y="${paddingY + headerHeight}" fill="#d1d5db" font-family="Menlo, Monaco, 'Courier New', monospace" font-size="${fontSize}" xml:space="preserve">${tspans}</text>
</svg>`
}

for (const file of files) {
  if (!fs.existsSync(file.input)) {
    throw new Error(`Missing input proof file: ${file.input}`)
  }

  const content = fs.readFileSync(file.input, "utf8")
  const svg = buildSvg(file.title, content)
  fs.writeFileSync(file.output, svg)
  process.stdout.write(`${file.output}\n`)
}