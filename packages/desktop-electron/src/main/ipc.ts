import { execFile } from "node:child_process"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { getStore } from "./store"

/**
 * 验证字符串输入是否符合安全要求
 * @param value - 要验证的值
 * @param maxLength - 最大允许长度
 * @param allowNull - 是否允许 null/undefined
 * @returns 验证通过返回原值，否则抛出错误
 */
function validateStringInput(
  value: unknown,
  maxLength: number = 4096,
  allowNull: boolean = false,
): string {
  if (value === null || value === undefined) {
    if (allowNull) {
      throw new Error("Value cannot be null or undefined")
    }
    throw new Error("Value cannot be null or undefined")
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string, got ${typeof value}`)
  }
  if (value.length > maxLength) {
    throw new Error(`String exceeds maximum length of ${maxLength}`)
  }
  return value
}

/**
 * 验证 WSL 模式参数
 * @param mode - 要验证的模式
 * @returns 验证通过返回模式值，否则抛出错误
 */
function validateWslMode(mode: unknown): "windows" | "linux" | null {
  if (mode === null || mode === undefined) return null
  if (mode === "windows" || mode === "linux") return mode
  throw new Error(`Invalid WSL mode: ${mode}`)
}

/**
 * 验证 store 名称是否符合规范
 * @param name - store 名称
 * @returns 验证通过返回名称，否则抛出错误
 */
function validateStoreName(name: unknown): string {
  const validName = validateStringInput(name, 256)
  // 防止路径遍历攻击
  if (validName.includes("..")) {
    throw new Error("Store name cannot contain path traversal")
  }
  return validName
}

/**
 * 验证 store key 是否符合规范
 * @param key - store key
 * @returns 验证通过返回 key，否则抛出错误
 */
function validateStoreKey(key: unknown): string {
  const validKey = validateStringInput(key, 1024)
  // 防止原型链污染
  if (validKey === "__proto__" || validKey === "constructor") {
    throw new Error("Invalid store key")
  }
  return validKey
}

/**
 * 验证文件路径是否安全
 * @param path - 文件路径
 * @returns 验证通过返回路径，否则抛出错误
 */
function validateFilePath(path: unknown): string {
  const validPath = validateStringInput(path, 8192)
  // 检查危险字符和模式
  // 防止命令注入
  if (validPath.includes("&&") || validPath.includes("||") || validPath.includes(";")) {
    throw new Error("Path contains dangerous characters")
  }
  // 防止路径遍历
  if (validPath.includes("../") || validPath.includes("..\\")) {
    throw new Error("Path contains path traversal")
  }
  return validPath
}

/**
 * 验证应用名称是否安全
 * @param appName - 应用名称
 * @returns 验证通过返回应用名称，否则抛出错误
 */
function validateAppName(appName: unknown): string {
  const validName = validateStringInput(appName, 512)
  // 应用名称只允许字母、数字、空格、连字符、下划线和点
  if (validName && !/^[a-zA-Z0-9\s\-_.]+$/.test(validName)) {
    throw new Error("App name contains invalid characters")
  }
  return validName
}

type Deps = {
  killSidecar: () => void
  installCli: () => Promise<string>
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("install-cli", () => deps.installCli())
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => {
    const safeMarkdown = validateStringInput(markdown, 1_000_000) // 支持大型 Markdown
    return deps.parseMarkdown(safeMarkdown ?? "")
  })
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: unknown) => {
    const safeName = validateAppName(appName)
    return deps.checkAppExists(safeName)
  })
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: unknown, mode: unknown) => {
    const safePath = validateFilePath(path)
    const safeMode = validateWslMode(mode)
    return deps.wslPath(safePath ?? "", safeMode)
  })
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: unknown) => {
    const safeName = validateAppName(appName)
    return deps.resolveAppPath(safeName)
  })
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: unknown, key: unknown) => {
    const safeName = validateStoreName(name)
    const safeKey = validateStoreKey(key)
    const store = getStore(safeName)
    const value = store.get(safeKey)
    if (value === undefined || value === null) return null
    return typeof value === "string" ? value : JSON.stringify(value)
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: unknown, key: unknown, value: unknown) => {
    const safeName = validateStoreName(name)
    const safeKey = validateStoreKey(key)
    const safeValue = validateStringInput(value, 1_000_000) ?? ""
    getStore(safeName).set(safeKey, safeValue)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: unknown, key: unknown) => {
    const safeName = validateStoreName(name)
    const safeKey = validateStoreKey(key)
    getStore(safeName).delete(safeKey)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: unknown) => {
    const safeName = validateStoreName(name)
    getStore(safeName).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: unknown) => {
    const safeName = validateStoreName(name)
    const store = getStore(safeName)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: unknown) => {
    const safeName = validateStoreName(name)
    const store = getStore(safeName)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      // 验证选项参数
      const safeOpts = opts ? {
        multiple: typeof opts.multiple === 'boolean' ? opts.multiple : false,
        title: validateStringInput(opts.title, 256) ?? "Choose a folder",
        defaultPath: validateFilePath(opts.defaultPath),
      } : undefined

      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(safeOpts?.multiple ? ["multiSelections" as const] : [])],
        title: safeOpts?.title ?? "Choose a folder",
        defaultPath: safeOpts?.defaultPath,
      })
      if (result.canceled) return null
      return safeOpts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      // 验证选项参数
      const safeOpts = opts ? {
        multiple: typeof opts.multiple === 'boolean' ? opts.multiple : false,
        title: validateStringInput(opts.title, 256) ?? "Choose a file",
        defaultPath: validateFilePath(opts.defaultPath),
      } : undefined

      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(safeOpts?.multiple ? ["multiSelections" as const] : [])],
        title: safeOpts?.title ?? "Choose a file",
        defaultPath: safeOpts?.defaultPath,
      })
      if (result.canceled) return null
      return safeOpts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      // 验证选项参数
      const safeOpts = opts ? {
        title: validateStringInput(opts.title, 256) ?? "Save file",
        defaultPath: validateFilePath(opts.defaultPath),
      } : undefined

      const result = await dialog.showSaveDialog({
        title: safeOpts?.title ?? "Save file",
        defaultPath: safeOpts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  // 验证 URL 协议，防止恶意链接执行任意命令
  // 仅允许 http 和 https 协议，防止 javascript:, data: 等危险协议
  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    try {
      const parsed = new URL(url)
      // 仅允许 http 和 https 协议
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        void shell.openExternal(url)
      } else {
        console.warn("Blocked external link with unsupported protocol:", parsed.protocol)
      }
    } catch {
      // 无效的 URL 忽略
      console.warn("Blocked invalid URL:", url)
    }
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: unknown, app?: unknown) => {
    // 验证文件路径
    const safePath = validateFilePath(path)
    if (!safePath) {
      throw new Error("Invalid file path")
    }

    // 验证应用名称（如果提供）
    const safeApp = app ? validateAppName(app) : undefined

    if (!safeApp) return shell.openPath(safePath)

    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", safeApp, safePath]] as const) : ([safeApp, [safePath]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => event.sender.setZoomFactor(factor))
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
