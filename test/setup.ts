import { beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import { vi } from "vitest"

/**
 * Test setup utilities
 */
export class TestSetup {
  private static logMessages: string[] = []

  static captureLog() {
    const originalLog = console.log
    console.log = (...args: any[]) => {
      this.logMessages.push(args.join(" "))
    }
    return this.logMessages
  }

  static restoreLog() {
    console.log = console.log
  }

  static getLogMessages() {
    return this.logMessages
  }

  static clearLogMessages() {
    this.logMessages = []
  }
}

/**
 * Mock factory for creating test doubles
 */
export class MockFactory {
  static createMock<T>(): vi.Mock<T> {
    return vi.fn() as any
  }

  static createMockResolved<T>(value: T): vi.Mock<T> {
    const mock = vi.fn() as any
    mock.mockResolvedValue(value)
    return mock
  }

  static createMockRejected<T>(error: Error): vi.Mock<T> {
    const mock = vi.fn() as any
    mock.mockRejectedValue(error)
    return mock
  }
}

/**
 * Test data fixtures
 */
export const testData = {
  validPrompt: "Write a function that adds two numbers",
  invalidPrompt: "",
  complexPrompt: "Create a REST API endpoint that handles user authentication with JWT tokens",

  validCode: `
function add(a: number, b: number): number {
  return a + b
}
`,

  invalidCode: `
function broken( {
  // Syntax error
}
`,

  complexCode: `
import express from 'express'
import jwt from 'jsonwebtoken'

const app = express()

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body
  
  // Validate credentials
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

beforeAll(() => {
  // Suppress console.log in tests unless needed
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  // Reset test state before each test
  TestSetup.clearLogMessages()
})
