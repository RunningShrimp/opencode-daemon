import { mock } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

export class MockFactory {
  static createMock<T extends (...args: any[]) => any>(): ReturnType<typeof mock<T>> {
    return mock<T>((() => {}) as T)
  }

  static createMockResolved<T>(value: T): ReturnType<typeof mock<() => Promise<T>>> {
    const fn = mock<() => Promise<T>>(async () => value)
    return fn
  }

  static createMockRejected<T>(error: Error): ReturnType<typeof mock<() => Promise<T>>> {
    const fn = mock<() => Promise<T>>(async () => {
      throw error
    })
    return fn
  }
}

export const testData = {
  validPrompt: "Write a function that adds two numbers",
  invalidPrompt: "",
  complexPrompt: "Create a REST API endpoint with JWT authentication",

  validCode: `
function add(a: number, b: number): number {
  return a + b
}
`,

  invalidCode: `
function broken( {
}
`,

  complexCode: `
import express from 'express'
import jwt from 'jsonwebtoken'

const app = express()

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body
  
  if (username === 'admin' && password === 'password') {
    const token = jwt.sign({ userId: 1 }, 'secret')
    res.json({ token })
  } else {
    res.status(401).json({ error: 'Invalid credentials' })
  }
})

export default app
`,
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function assertThrows(fn: () => Promise<any>): Promise<Error> {
  try {
    await fn()
    throw new Error("Expected function to throw")
  } catch (error) {
    return error as Error
  }
}

export function createTestDir(name: string): string {
  const dir = join(tmpdir(), "opencode-test", name)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

export function cleanupTestDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}
