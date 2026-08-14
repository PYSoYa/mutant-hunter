import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    // fixtures는 대상 repo에서 실행될 샘플이다. 우리 스위트의 일부가 아니다.
    exclude: ["tests/fixtures/**"],
  },
});
