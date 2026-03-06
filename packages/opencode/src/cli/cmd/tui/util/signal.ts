import { createSignal, type Accessor } from "solid-js"
import { debounce, type Scheduled } from "@solid-primitives/scheduled"

/**
 * Creates a debounced signal with automatic cleanup capability
 *
 * @param value - Initial value for the signal
 * @param ms - Debounce delay in milliseconds
 * @returns Tuple of [getter, setter, cleanup function]
 *
 * @example
 * const [value, setValue, cleanup] = createDebouncedSignal("", 300)
 * setValue("new value") // Debounced - won't update immediately
 * cleanup() // Cancel pending updates and release resources
 */
export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, Scheduled<[value: T]>, () => void] {
  const [get, set] = createSignal(value)
  const scheduled = debounce((v: T) => set(() => v), ms)

  // Provide cleanup function to cancel pending updates
  const cleanup = () => {
    scheduled.abort()
  }

  return [get, scheduled, cleanup]
}
