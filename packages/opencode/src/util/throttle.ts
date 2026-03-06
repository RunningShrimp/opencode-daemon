// 简单的 throttle 实现，用于节流频繁调用的函数
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  ms: number,
): T {
  let lastCall = 0
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  return ((...args: Parameters<T>) => {
    const now = Date.now()
    const remaining = ms - (now - lastCall)

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      lastCall = now
      fn(...args)
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now()
        timeoutId = undefined
        fn(...args)
      }, remaining)
    }
  }) as T
}
