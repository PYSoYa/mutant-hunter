import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMutant, offsetOf, withMutantApplied } from "../src/apply.js";
import type { Mutant } from "../src/types.js";

const SRC = ["const a = 1;", "if (x > y) {", "  return 'high';", "}"].join("\n");

function mutant(over: Partial<Mutant>): Mutant {
  return {
    id: "1",
    path: "src/a.ts",
    mutatorName: "ConditionalExpression",
    status: "Survived",
    line: 2,
    column: 5,
    endLine: 2,
    endColumn: 10,
    replacement: "false",
    original: "x > y",
    ...over,
  };
}

describe("offsetOf", () => {
  it("첫 줄 첫 칸은 0이다", () => {
    expect(offsetOf(SRC, 1, 1)).toBe(0);
  });

  it("줄바꿈을 넘겨 오프셋을 센다", () => {
    expect(offsetOf(SRC, 2, 1)).toBe(13);
  });

  it("줄 끝을 넘는 칸은 줄 끝으로 고정한다", () => {
    expect(offsetOf(SRC, 1, 999)).toBe(12);
  });

  it("파일 끝을 넘는 줄은 전체 길이로 고정한다", () => {
    expect(offsetOf(SRC, 999, 1)).toBe(SRC.length);
  });
});

describe("applyMutant", () => {
  it("지목한 범위를 replacement로 갈아끼운다", () => {
    expect(applyMutant(SRC, mutant({}))).toContain("if (false) {");
  });

  it("원본 문자열을 변형하지 않는다", () => {
    const before = SRC;
    applyMutant(SRC, mutant({}));
    expect(SRC).toBe(before);
  });

  it("여러 줄에 걸친 범위를 처리한다", () => {
    const out = applyMutant(
      SRC,
      mutant({ line: 2, column: 12, endLine: 4, endColumn: 2, replacement: "{}" }),
    );
    expect(out).toBe("const a = 1;\nif (x > y) {}");
  });

  it("빈 replacement로 코드를 제거할 수 있다", () => {
    expect(applyMutant(SRC, mutant({ replacement: "" }))).toContain("if () {");
  });

  it("범위가 뒤집히면 실패한다", () => {
    expect(() =>
      applyMutant(SRC, mutant({ line: 3, column: 1, endLine: 2, endColumn: 1 })),
    ).toThrow(/뒤집/);
  });
});

describe("withMutantApplied", () => {
  const tmpFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, SRC);
    return file;
  };

  it("실행 중에는 뮤턴트가 적용돼 있다", async () => {
    const file = tmpFile();
    const seen = await withMutantApplied(file, mutant({}), async () =>
      readFileSync(file, "utf8"),
    );
    expect(seen).toContain("if (false) {");
  });

  it("실행이 끝나면 원본으로 되돌린다", async () => {
    const file = tmpFile();
    await withMutantApplied(file, mutant({}), async () => undefined);
    expect(readFileSync(file, "utf8")).toBe(SRC);
  });

  it("실행이 실패해도 원본으로 되돌린다", async () => {
    // 복원 실패는 곧 사용자 코드 손상이므로 예외 경로가 특히 중요하다.
    const file = tmpFile();
    await expect(
      withMutantApplied(file, mutant({}), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(readFileSync(file, "utf8")).toBe(SRC);
  });
});
