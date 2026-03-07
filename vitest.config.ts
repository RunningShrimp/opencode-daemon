import { defineConfig } from "vitest/config"
import { alias } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      lines: 80,
      statements: 50,
      branches: 50,
      functions: 50,
      perFile: true,
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ["./test/setup.ts"],
  },
  resolve: {
    "@": path.resolve(__dirname, "./src"),
  },
})
