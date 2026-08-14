import { describe, expect, it } from "vitest";
import { buildUserPrompt, extractTestSource, sourceSnippet } from "../src/prompt.js";
import type { Mutant } from "../src/types.js";

const MUTANT: Mutant = {
  id: "7",
  path: "lib/guard.ts",
  mutatorName: "ConditionalExpression",
  status: "Survived",
  line: 12,
  column: 5,
  endLine: 12,
  endColumn: 14,
  replacement: "false",
  original: "ch === '\"'",
};

describe("buildUserPrompt", () => {
  it("뮤턴트의 위치·원본·변이를 모두 담는다", () => {
    const p = buildUserPrompt({ mutant: MUTANT, sourceSnippet: "12 | ..." });
    expect(p).toContain("lib/guard.ts:12:5");
    expect(p).toContain("ConditionalExpression");
    expect(p).toContain(MUTANT.original);
    expect(p).toContain("false");
  });

  it("형제 테스트가 있으면 스타일 참고로 넣는다", () => {
    const p = buildUserPrompt({
      mutant: MUTANT,
      sourceSnippet: "x",
      siblingTest: { path: "tests/guard.test.ts", content: "import { it } from 'vitest';" },
    });
    expect(p).toContain("tests/guard.test.ts");
    expect(p).toContain("import { it } from 'vitest';");
  });

  it("형제 테스트가 없으면 해당 섹션을 넣지 않는다", () => {
    expect(buildUserPrompt({ mutant: MUTANT, sourceSnippet: "x" })).not.toContain(
      "기존 테스트 파일",
    );
  });

  it("거대한 형제 테스트를 잘라 쿼터를 아낀다", () => {
    const p = buildUserPrompt({
      mutant: MUTANT,
      sourceSnippet: "x",
      siblingTest: { path: "t.ts", content: "x".repeat(20_000) },
    });
    expect(p).toContain("(생략)");
    expect(p.length).toBeLessThan(12_000);
  });

  it("kills-mutant 실패에는 왜 놓쳤는지 구체적 지침을 붙인다", () => {
    const p = buildUserPrompt({
      mutant: MUTANT,
      sourceSnippet: "x",
      previousFailure: { gate: "kills-mutant", detail: "뮤턴트가 살아남았다" },
    });
    expect(p).toContain("단언이 느슨해서");
  });

  it("다른 게이트 실패에는 일반 재시도 지침을 붙인다", () => {
    const p = buildUserPrompt({
      mutant: MUTANT,
      sourceSnippet: "x",
      previousFailure: { gate: "passes-on-original", detail: "SyntaxError" },
    });
    expect(p).toContain("SyntaxError");
    expect(p).not.toContain("단언이 느슨해서");
  });
});

describe("extractTestSource", () => {
  it("마크다운 펜스를 벗긴다", () => {
    expect(extractTestSource("설명\n```ts\nconst a = 1;\n```\n끝")).toBe(
      "const a = 1;",
    );
  });

  it("언어 태그가 없는 펜스도 처리한다", () => {
    expect(extractTestSource("```\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("펜스가 없으면 본문을 그대로 쓴다", () => {
    expect(extractTestSource("  const a = 1;  ")).toBe("const a = 1;");
  });

  it("첫 코드 블록만 취한다", () => {
    expect(extractTestSource("```ts\nfirst\n```\n```ts\nsecond\n```")).toBe("first");
  });
});

describe("sourceSnippet", () => {
  const SRC = ["a", "b", "c", "d"].join("\n");

  it("줄 번호를 붙여 잘라낸다", () => {
    expect(sourceSnippet(SRC, 2, 3)).toBe("2 | b\n3 | c");
  });

  it("파일 경계를 넘지 않는다", () => {
    expect(sourceSnippet(SRC, 0, 99)).toBe("1 | a\n2 | b\n3 | c\n4 | d");
  });
});
