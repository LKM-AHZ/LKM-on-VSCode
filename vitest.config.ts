import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 让业务模块顶层的 `import * as vscode from "vscode"` 在 node 环境下
      // 解析到测试桩（@types/vscode 只是类型，运行时 node 没有该模块）。
      // 用 import.meta.url 而非 __dirname：配置若以 ESM 加载，__dirname 会直接未定义。
      vscode: fileURLToPath(new URL("test/mocks/vscode.ts", import.meta.url)),
    },
  },
  test: {
    // 同时收 .spec.ts，避免落在 src/ 下或写成 *.spec.ts 的测试被静默跳过而给出假绿灯。
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
    environment: "node",
  },
});
