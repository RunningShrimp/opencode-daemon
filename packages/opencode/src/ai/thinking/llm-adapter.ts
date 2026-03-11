import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import type { LLMClient } from "./tree-of-thought"

const log = Log.create({ service: "ai.thinking.adapter" })

export class OpencodeLLMAdapter implements LLMClient {
  private model: Provider.Model
  private sessionID: string

  constructor(model: Provider.Model, sessionID: string) {
    this.model = model
    this.sessionID = sessionID
  }

  async generate(prompt: string, system?: string): Promise<string> {
    try {
      const languageModel = await Provider.getLanguage(this.model)
      
      const result = await generateText({
        model: languageModel,
        prompt,
        system,
        maxRetries: 2,
        // We can add more options here if needed, like temperature
      })

      return result.text
    } catch (error) {
      log.error("Failed to generate text", { error, sessionID: this.sessionID })
      throw error
    }
  }
}
