import { describe, expect, it } from "vitest";
import { isMutableSource, parseUnifiedDiff } from "../src/diff.js";

describe("parseUnifiedDiff", () => {
  it("훅 하나에서 추가된 줄 번호를 뽑는다", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 111..222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,0 +11,2 @@",
      "+const a = 1;",
      "+const b = 2;",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "src/foo.ts", changedLines: [11, 12] },
    ]);
  });

  it("훅 여러 개와 파일 여러 개를 경로별로 모은다", () => {
    const diff = [
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -5,0 +6,1 @@",
      "+x",
      "@@ -20,0 +22,3 @@",
      "+y",
    ].join("\n");

    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "src/a.ts", changedLines: [6, 22, 23, 24] },
      { path: "src/b.ts", changedLines: [1] },
    ]);
  });

  it("순수 삭제 훅도 인접 줄을 접점으로 남긴다", () => {
    const diff = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -7,3 +6,0 @@", "-gone"].join(
      "\n",
    );
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "src/x.ts", changedLines: [6] },
    ]);
  });

  it("삭제된 파일은 대상에서 제외한다", () => {
    const diff = [
      "--- a/src/dead.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-gone",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it("훅 헤더의 함수 컨텍스트 꼬리표에 속지 않는다", () => {
    const diff = [
      "--- a/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -3,0 +4,1 @@ export function outer() {",
      "+  const z = 1;",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: "src/f.ts", changedLines: [4] },
    ]);
  });
});

describe("isMutableSource", () => {
  it("소스 파일을 통과시킨다", () => {
    expect(isMutableSource("src/lib/a.ts")).toBe(true);
    expect(isMutableSource("app/page.tsx")).toBe(true);
  });

  it("테스트·선언·빌드 산출물을 제외한다", () => {
    expect(isMutableSource("src/a.test.ts")).toBe(false);
    expect(isMutableSource("tests/helpers/db.ts")).toBe(false);
    expect(isMutableSource("src/types.d.ts")).toBe(false);
    expect(isMutableSource("dist/index.js")).toBe(false);
    expect(isMutableSource("node_modules/x/index.js")).toBe(false);
  });

  it("소스가 아닌 확장자를 제외한다", () => {
    expect(isMutableSource("README.md")).toBe(false);
    expect(isMutableSource("package.json")).toBe(false);
  });
});
