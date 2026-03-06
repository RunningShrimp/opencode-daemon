import Store from "electron-store"

import { SETTINGS_STORE } from "./constants"

/**
 * LRU 缓存的最大容量
 * 超过此数量时，最旧的条目将被移除
 */
const MAX_CACHE_SIZE = 20

/**
 * LRU 缓存实现
 * 用于存储 electron-store 实例，防止重复创建
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>()

  /**
   * 获取缓存值，如果存在则更新其位置为最新
   * @param key 缓存键
   * @returns 缓存值，如果不存在则返回 undefined
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value === undefined) return undefined

    // 删除并重新设置，以将其移动到最新位置
    this.cache.delete(key)
    this.cache.set(key, value)
    return value
  }

  /**
   * 设置缓存值
   * @param key 缓存键
   * @param value 缓存值
   */
  set(key: K, value: V): void {
    // 如果键已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    // 添加新值
    this.cache.set(key, value)

    // 如果超过最大容量，删除最旧的条目
    if (this.cache.size > MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }
  }

  /**
   * 检查缓存中是否存在指定的键
   * @param key 缓存键
   * @returns 是否存在
   */
  has(key: K): boolean {
    return this.cache.has(key)
  }

  /**
   * 删除指定的缓存条目
   * @param key 缓存键
   * @returns 是否成功删除
   */
  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 获取当前缓存大小
   * @returns 缓存条目数量
   */
  size(): number {
    return this.cache.size
  }
}

/**
 * 全局 LRU 缓存实例
 * 用于存储 electron-store 实例，避免重复创建
 */
const cache = new LRUCache<string, Store>()

/**
 * 获取或创建 electron-store 实例
 * 使用 LRU 缓存管理，防止内存泄漏
 * @param name store 名称，默认为设置 store
 * @returns electron-store 实例
 */
export function getStore(name = SETTINGS_STORE): Store {
  const cached = cache.get(name)
  if (cached) return cached

  const next = new Store({ name })
  cache.set(name, next)
  return next
}

export const store = getStore(SETTINGS_STORE)
