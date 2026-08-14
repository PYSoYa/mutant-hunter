import { describe, expect, it } from "vitest";
import { dedupeKey, explainMutant, oneLine } from "../src/explain.js";
import type { Mutant } from "../src/types.js";

function mutant(over: Partial<Mutant>): Mutant {
  return {
    id: "1",
    path: "src/a.ts",
    mutatorName: "ConditionalExpression",
    status: "Survived",
    line: 10,
    column: 1,
    endLine: 10,
    endColumn: 5,
    replacement: "false",
    original: "x > y",
    ...over,
  };
}

describe("explainMutant", () => {
  it("조건이 항상 거짓이 되는 경우를 구분한다", () => {
    expect(explainMutant(mutant({ replacement: "false" }))).toContain("항상 거짓");
  });

  it("조건이 항상 참이 되는 경우를 구분한다", () => {
    expect(explainMutant(mutant({ replacement: "true" }))).toContain("항상 참");
  });

  it("경계 연산자 변형을 사람 말로 옮긴다", () => {
    expect(explainMutant(mutant({ mutatorName: "EqualityOperator" }))).toContain(
      "경계가 한 칸 밀려도",
    );
  });

  it("블록 제거를 사람 말로 옮긴다", () => {
    expect(explainMutant(mutant({ mutatorName: "BlockStatement" }))).toContain(
      "통째로 사라져도",
    );
  });

  it("옵셔널 체이닝 제거의 결과를 설명한다", () => {
    expect(explainMutant(mutant({ mutatorName: "OptionalChaining" }))).toContain(
      "값이 없을 때 터지게",
    );
  });

  it("모르는 뮤테이터도 문장이 깨지지 않는다", () => {
    const out = explainMutant(mutant({ mutatorName: "알수없음" }));
    expect(out).toContain("어떤 테스트도 실패하지 않습니다");
  });

  it("항상 결론을 굵게 붙인다", () => {
    // 이 한 문장이 코멘트의 핵심이다. 뮤테이션 테스팅을 몰라도 읽혀야 한다.
    for (const name of ["ConditionalExpression", "BlockStatement", "Regex"]) {
      expect(explainMutant(mutant({ mutatorName: name }))).toMatch(
        /\*\*어떤 테스트도 실패하지 않습니다\.\*\*$/,
      );
    }
  });

  it("도구 용어를 노출하지 않는다", () => {
    // "뮤턴트", "Stryker" 같은 말이 나오면 대부분의 리뷰어는 읽지 않는다.
    const out = explainMutant(mutant({}));
    expect(out).not.toMatch(/뮤턴트|Stryker|mutant/i);
  });
});

describe("dedupeKey", () => {
  it("같은 줄·같은 종류는 같은 키다", () => {
    expect(dedupeKey(mutant({ column: 1 }))).toBe(dedupeKey(mutant({ column: 9 })));
  });

  it("줄이 다르면 다른 키다", () => {
    expect(dedupeKey(mutant({ line: 10 }))).not.toBe(dedupeKey(mutant({ line: 11 })));
  });

  it("종류가 다르면 다른 키다", () => {
    expect(dedupeKey(mutant({ mutatorName: "A" }))).not.toBe(
      dedupeKey(mutant({ mutatorName: "B" })),
    );
  });

  it("파일이 다르면 다른 키다", () => {
    expect(dedupeKey(mutant({ path: "a.ts" }))).not.toBe(
      dedupeKey(mutant({ path: "b.ts" })),
    );
  });
});

describe("oneLine", () => {
  it("줄바꿈과 연속 공백을 접는다", () => {
    expect(oneLine("a\n  b\t c")).toBe("a b c");
  });

  it("길면 자르고 표시를 남긴다", () => {
    expect(oneLine("x".repeat(200), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("짧으면 그대로 둔다", () => {
    expect(oneLine("짧다", 10)).toBe("짧다");
  });
});
