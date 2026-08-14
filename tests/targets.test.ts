import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createProject,
  mergeRanges,
  resolveMutateRanges,
  toStrykerMutateArgs,
} from "../src/targets.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/sample.ts", import.meta.url));

function ranges(lines: number[]) {
  return resolveMutateRanges(createProject(), FIXTURE, "sample.ts", lines);
}

describe("resolveMutateRanges", () => {
  it("함수 본문의 한 줄을 함수 전체 범위로 넓힌다", () => {
    // L5 = `return "high";` → classify 전체(L3~L8)
    expect(ranges([5])).toEqual([
      { path: "sample.ts", start: 3, end: 8, symbol: "classify" },
    ]);
  });

  it("중첩 화살표 함수는 가장 바깥 선언까지 올라간다", () => {
    // L13 = `.filter((n) => n > 0)` → 안쪽 화살표가 아니라 transform 전체
    const out = ranges([13]);
    expect(out).toHaveLength(1);
    expect(out[0]!.symbol).toBe("transform");
    expect(out[0]!.start).toBe(10);
  });

  it("메서드는 클래스 전체 범위로 확장한다", () => {
    const out = ranges([19]);
    expect(out[0]!.symbol).toBe("Reporter");
  });

  it("최상위 문장은 해당 줄만 대상으로 삼는다", () => {
    expect(ranges([1])).toEqual([
      { path: "sample.ts", start: 1, end: 1, symbol: "(top-level)" },
    ]);
  });

  it("같은 함수 안의 여러 변경을 한 범위로 합친다", () => {
    expect(ranges([4, 5, 7])).toHaveLength(1);
  });

  it("파일 끝을 넘는 줄 번호를 무시한다", () => {
    expect(ranges([9999])).toEqual([]);
  });
});

describe("mergeRanges", () => {
  it("겹치는 범위를 합치고 심볼을 누적한다", () => {
    const merged = mergeRanges([
      { path: "a.ts", start: 1, end: 5, symbol: "f" },
      { path: "a.ts", start: 4, end: 9, symbol: "g" },
    ]);
    expect(merged).toEqual([
      { path: "a.ts", start: 1, end: 9, symbol: "f, g" },
    ]);
  });

  it("맞닿은 범위도 합친다", () => {
    const merged = mergeRanges([
      { path: "a.ts", start: 1, end: 3, symbol: "f" },
      { path: "a.ts", start: 4, end: 6, symbol: "g" },
    ]);
    expect(merged).toHaveLength(1);
  });

  it("떨어진 범위는 유지한다", () => {
    expect(
      mergeRanges([
        { path: "a.ts", start: 1, end: 3, symbol: "f" },
        { path: "a.ts", start: 20, end: 25, symbol: "g" },
      ]),
    ).toHaveLength(2);
  });

  it("다른 파일은 절대 합치지 않는다", () => {
    expect(
      mergeRanges([
        { path: "a.ts", start: 1, end: 3, symbol: "f" },
        { path: "b.ts", start: 2, end: 4, symbol: "g" },
      ]),
    ).toHaveLength(2);
  });

  it("빈 입력을 견딘다", () => {
    expect(mergeRanges([])).toEqual([]);
  });
});

describe("toStrykerMutateArgs", () => {
  it("Stryker가 이해하는 path:start-end 형식으로 직렬화한다", () => {
    expect(
      toStrykerMutateArgs([{ path: "src/a.ts", start: 3, end: 8, symbol: "f" }]),
    ).toEqual(["src/a.ts:3-8"]);
  });
});
