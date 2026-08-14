import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  extractTestSource,
  sourceSnippet,
  SYSTEM_PROMPT,
} from "../src/prompt.js";
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

describe("SYSTEM_PROMPT", () => {
  it("기대값을 짐작하지 말라고 명시한다", () => {
    // 실측에서 가장 흔한 실패가 기대값 오판이었다 (passes-on-original).
    expect(SYSTEM_PROMPT).toMatch(/짐작하지 마라/);
  });

  it("확신 없을 때의 대안을 제시한다", () => {
    // 값을 못 짚겠으면 갈리는 성질을 단언하라 — 막연한 금지보다 낫다.
    expect(SYSTEM_PROMPT).toMatch(/갈리는 성질/);
  });

  it("기존 테스트를 복사하지 말라고 명시한다", () => {
    // 실측에서 기존 21개를 그대로 베끼고 1개만 더한 응답이 나왔다.
    // 적용하면 같은 테스트가 두 번 돈다.
    expect(SYSTEM_PROMPT).toMatch(/복사하지 마라/);
  });

  it("그래도 단독 실행되어야 한다고 덧붙인다", () => {
    // 복사 금지만 말하면 import까지 빼먹어 게이트 1에서 떨어진다.
    expect(SYSTEM_PROMPT).toMatch(/단독으로\s*\n?\s*실행되도록/);
  });

  it("죽이기 어려운 뮤턴트를 무리하지 말라고 한다", () => {
    // 거대한 픽스처가 필요한 상한 검사에 재시도를 태우면 쿼터만 낭비된다.
    expect(SYSTEM_PROMPT).toMatch(/죽이기 어렵다/);
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
