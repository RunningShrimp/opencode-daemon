/**
 * Session Error Handler
 *
 * Provides centralized error handling for session-related events.
 * Subscribes to Session.Event.Error and logs/handles errors appropriately.
 */

import { Bus } from "../bus"
import { Session } from "."
import { Log } from "../util/log"

const log = Log.create({ service: "session-error-handler" })

/**
 * Error handler configuration
 */
export interface ErrorHandlerConfig {
  /** Whether to log errors (default: true) */
  logErrors: boolean
  /** Whether to publish errors to GlobalBus for UI notification (default: true) */
  notifyUI: boolean
  /** Maximum number of errors to keep in history (default: 100) */
  maxHistorySize: number
}

/**
 * Error record for history
 */
interface ErrorRecord {
  timestamp: number
  sessionID: string | undefined
  error: any
  handled: boolean
}

/**
 * Session Error Handler
 *
 * Singleton handler that subscribes to session error events
 * and provides error history and reporting capabilities.
 */
export class SessionErrorHandler {
  private static instance: SessionErrorHandler | null = null
  private config: ErrorHandlerConfig
  private history: ErrorRecord[] = []
  private unsubscribe: (() => void) | null = null
  private initialized = false

  /**
   * Get the singleton instance
   */
  static getInstance(config?: Partial<ErrorHandlerConfig>): SessionErrorHandler {
    if (!SessionErrorHandler.instance) {
      SessionErrorHandler.instance = new SessionErrorHandler(config)
    }
    return SessionErrorHandler.instance
  }

  /**
   * Create a new SessionErrorHandler
   */
  constructor(config?: Partial<ErrorHandlerConfig>) {
    this.config = {
      logErrors: config?.logErrors ?? true,
      notifyUI: config?.notifyUI ?? true,
      maxHistorySize: config?.maxHistorySize ?? 100,
    }
  }

  /**
   * Initialize the error handler - subscribe to error events
   * Should be called once at application startup
   */
  initialize(): void {
    if (this.initialized) {
      log.warn("Error handler already initialized")
      return
    }

    // Subscribe to session error events
    this.unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
      this.handleError(event)
    })

    this.initialized = true
    log.info("Session error handler initialized", {
      config: this.config,
    })
  }

  /**
   * Handle a session error event
   */
  private handleError(event: {
    sessionID?: string
    error: any
  }): void {
    // Create error record
    const record: ErrorRecord = {
      timestamp: Date.now(),
      sessionID: event.sessionID,
      error: event.error,
      handled: false,
    }

    // Add to history
    this.history.push(record)

    // Trim history if needed
    if (this.history.length > this.config.maxHistorySize) {
      this.history.shift()
    }

    // Log the error
    if (this.config.logErrors) {
      log.error("Session error", {
        sessionID: event.sessionID,
        error: this.serializeError(event.error),
      })
    }

    // Mark as handled
    record.handled = true

    // TODO: Future enhancement - notify UI via GlobalBus if needed
    // This would require adding UI-specific error handling
  }

  /**
   * Get error history
   */
  getHistory(limit?: number): ErrorRecord[] {
    const history = [...this.history]
    if (limit !== undefined) {
      return history.slice(-limit)
    }
    return history
  }

  /**
   * Get errors for a specific session
   */
  getErrorsForSession(sessionID: string): ErrorRecord[] {
    return this.history.filter((r) => r.sessionID === sessionID)
  }

  /**
   * Clear error history
   */
  clearHistory(): void {
    this.history = []
    log.info("Error history cleared")
  }

  /**
   * Get error statistics
   */
  getStats(): {
    totalErrors: number
    errorsBySession: Record<string, number>
    recentErrors: number
  } {
    const errorsBySession: Record<string, number> = {}
    let recentErrors = 0

    const oneHourAgo = Date.now() - 3600000

    for (const record of this.history) {
      if (record.sessionID) {
        errorsBySession[record.sessionID] = (errorsBySession[record.sessionID] ?? 0) + 1
      }
      if (record.timestamp > oneHourAgo) {
        recentErrors++
      }
    }

    return {
      totalErrors: this.history.length,
      errorsBySession,
      recentErrors,
    }
  }

  /**
   * Serialize error for logging
   */
  private serializeError(error: any): any {
    if (!error) return error

    // Handle known error types
    if (typeof error === "object") {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.code ? { code: error.code } : {}),
        ...(error.cause ? { cause: this.serializeError(error.cause) } : {}),
      }
    }

    return error
  }

  /**
   * Dispose the error handler
   * Should be called on application shutdown
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.initialized = false
    this.history = []
    SessionErrorHandler.instance = null
    log.info("Session error handler disposed")
  }
}

/**
 * Initialize the global session error handler
 * Call this at application startup
 */
export function initializeSessionErrorHandler(config?: Partial<ErrorHandlerConfig>): SessionErrorHandler {
  const handler = SessionErrorHandler.getInstance(config)
  handler.initialize()
  return handler
}

/**
 * Get the global session error handler instance
 */
export function getSessionErrorHandler(): SessionErrorHandler {
  return SessionErrorHandler.getInstance()
}

/**
 * Subscribe to session errors with custom handler
 * Useful for testing or custom error handling
 */
export function onSessionError(
  handler: (event: { sessionID?: string; error: any }) => void
): () => void {
  return Bus.subscribe(Session.Event.Error, handler)
}
