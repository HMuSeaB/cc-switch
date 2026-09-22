import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    // 单个测试的默认超时。App.test.tsx 这种"挂载整个 App + 走真实 hooks +
    // MSW"的集成测试单独跑就要 ~9s，默认 5s 必然超时；超时的测试走不完
    // afterEach，残留 DOM 会让同文件后续测试报 "Found multiple elements"。
    testTimeout: 20_000,
    // 关掉测试文件间的并发。
    //
    // 原因：jsdom 环境很重（单文件 setup 就要 2~3s，107 个文件并行时 worker 互相
    // 抢占，实测 environment 累计时间从 292s 飙到 3500s+），负载一高就出现：
    //   - 集成测试超时（App.test.tsx 单独跑 9s，并行下能到 40s+）
    //   - 超时测试的 DOM 没被清理，同文件后续测试报
    //     "Found multiple elements by [data-testid=...]"
    //   - 失败的文件和条数每次都不一样（试过 forks 进程隔离也一样，说明是资源
    //     争抢而非共享 document）
    //
    // 代价：全量从 ~80s 涨到 ~580s。正确性优先，且这本来就是一次性检查。
    // 要提速应该拆小 App.test.tsx（它一个文件占了 ~45s），而不是重开并发。
    fileParallelism: false,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
