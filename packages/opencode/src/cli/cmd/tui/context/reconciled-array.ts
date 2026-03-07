import { Binary } from "@opencode-ai/util/binary"
import { reconcile } from "solid-js/store"

export interface UseReconciledArrayOptions<T extends { id: string }> {
  array: T[]
  selector?: (item: T) => string
}

export interface ReconciledArrayResult<T> {
  found: boolean
  index: number
  item?: T
}

export namespace ReconciledArray {
  /**
   * Search an array by ID using binary search
   * @returns Result with found status, index, and optionally the item if found
   */
  export function search<T extends { id: string }>(
    array: T[],
    id: string,
    selector: (item: T) => string = (item) => item.id,
  ): ReconciledArrayResult<T> {
    const match = Binary.search(array, id, selector)
    return {
      found: match.found,
      index: match.index,
      item: match.found ? array[match.index] : undefined,
    }
  }

  /**
   * Create a reconcile function for updating an item in a sorted array
   * Uses binary search to find the item and reconcile for efficient updates
   */
  export function createReconcile<T extends { id: string }>(
    array: T[],
    selector: (item: T) => string = (item) => item.id,
  ) {
    return {
      update(id: string, newItem: T) {
        const match = Binary.search(array, id, selector)
        if (match.found) {
          return reconcile(newItem)
        }
        return undefined
      },
      insert(id: string, newItem: T) {
        const match = Binary.search(array, id, selector)
        if (!match.found) {
          return reconcile(newItem)
        }
        return undefined
      },
      delete(id: string) {
        const match = Binary.search(array, id, selector)
        if (match.found) {
          return (item: T) => item !== array[match.index]
        }
        return undefined
      },
    }
  }
}
