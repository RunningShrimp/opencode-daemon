import { Clipboard } from "./clipboard"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type Renderer = {
  getSelection: () => { getSelectedText: () => string } | null
  clearSelection: () => void
}

export namespace Selection {
  /**
   * Copy selected text to clipboard
   * Properly handles the async copy operation to avoid race conditions
   * - Clears selection only after successful copy
   * - Preserves selection if copy fails
   */
  export async function copy(renderer: Renderer, toast: Toast): Promise<boolean> {
    const text = renderer.getSelection()?.getSelectedText()
    if (!text) return false

    try {
      await Clipboard.copy(text)
      // Clear selection only after successful copy
      renderer.clearSelection()
      toast.show({ message: "Copied to clipboard", variant: "info" })
      return true
    } catch (error) {
      // Preserve selection on failure so user can try again
      toast.error(error)
      return false
    }
  }
}
