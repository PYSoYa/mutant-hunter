import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countBy, runPipeline } from "../src/pipeline.js";

/**
 * 4주차 dogfooding에서 pipeline.ts의 커버리지가 0이라는 게 드러났다.
 * Stryker가 필요한 경로는 통합 테스트 영역이지만, 그 이전에 끝나는
 * 조기 반환 분기는 여기서 지킬 수 있다.
 */
describe("runPipeline 조기 반환", () => {
  const repo = () => mkdtempSync(join(tmpdir(), "mh-pipe-"));

  it("소스 변경이 없으면 no-changes", async () => {
    const r = await runPipeline({ repoRoot: repo(), diff: "" });
    expect(r.status).toBe("no-changes");
    expect(r.ranges).toEqual([]);
  });

  it("테스트 파일만 바뀌었으면 no-changes", async () => {
    // 테스트 자체는 뮤테이션 대상이 아니다.
    const diff = ["--- a/tests/a.test.ts", "+++ b/tests/a.test.ts", "@@ -1,0 +2,1 @@", "+x"].join(
      "\n",
    );
    expect((await runPipeline({ repoRoot: repo(), diff })).status).toBe("no-changes");
  });

  it("소스가 아닌 파일만 바뀌었으면 no-changes", async () => {
    const diff = ["--- a/README.md", "+++ b/README.md", "@@ -1,0 +2,1 @@", "+x"].join("\n");
    expect((await runPipeline({ repoRoot: repo(), diff })).status).toBe("no-changes");
  });

  it("diff가 가리키는 파일이 없으면 no-ranges", async () => {
    // 삭제된 뒤의 diff를 다시 돌리는 경우 등.
    const diff = ["--- a/src/gone.ts", "+++ b/src/gone.ts", "@@ -1,0 +2,1 @@", "+x"].join("\n");
    expect((await runPipeline({ repoRoot: repo(), diff })).status).toBe("no-ranges");
  });

  it("파일 끝을 넘는 줄만 바뀌었으면 no-ranges", async () => {
    const root = repo();
    writeFileSync(join(root, "a.ts"), "export const x = 1;\n");
    const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -0,0 +9999,1 @@", "+x"].join("\n");
    expect((await runPipeline({ repoRoot: root, diff })).status).toBe("no-ranges");
  });

  it("로그 콜백이 없어도 죽지 않는다", async () => {
    await expect(runPipeline({ repoRoot: repo(), diff: "" })).resolves.toBeDefined();
  });
});

describe("countBy", () => {
  it("항목별로 센다", () => {
    expect(countBy(["a", "b", "a"])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("빈 입력은 빈 배열이다", () => {
    expect(countBy([])).toEqual([]);
  });

  it("처음 등장한 순서를 유지한다", () => {
    expect(countBy(["z", "a", "z"]).map(([k]) => k)).toEqual(["z", "a"]);
  });
});
