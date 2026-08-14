import { describe, expect, it } from "vitest";
import type { GenerationResult } from "../src/generate.js";
import type { PipelineResult } from "../src/pipeline.js";
import { COMMENT_MARKER, renderReport } from "../src/report.js";
import type { Mutant, MutantScanResult } from "../src/types.js";

const MUTANT: Mutant = {
  id: "29",
  path: "lib/guard.ts",
  mutatorName: "ConditionalExpression",
  status: "Survived",
  line: 38,
  column: 9,
  endLine: 38,
  endColumn: 19,
  replacement: "false",
  original: "ch === '\"'",
};

function scan(over: Partial<MutantScanResult> = {}): MutantScanResult {
  return {
    candidates: [MUTANT],
    filtered: [],
    stats: {
      total: 57,
      killed: 35,
      survived: 17,
      noCoverage: 4,
      timeout: 1,
      mutationScore: 63.16,
    },
    ...over,
  };
}

function accepted(over: Partial<Mutant> = {}): GenerationResult {
  return {
    mutant: { ...MUTANT, ...over },
    accepted: true,
    testSource: "it('x', () => {});",
    testFileRel: "tests/guard.mh-29-0.test.ts",
    attempts: [{ index: 0, gates: [] }],
  };
}

const RANGES = [{ path: "lib/guard.ts", start: 1, end: 60, symbol: "extractJson" }];

describe("renderReport — 공통", () => {
  it("모든 결과에 갱신용 표식을 넣는다", () => {
    // 표식이 없으면 커밋마다 새 코멘트가 쌓여 알림 피로로 도구가 죽는다.
    for (const status of ["no-changes", "no-ranges", "stryker-failed"] as const) {
      expect(renderReport({ status, ranges: [] })).toContain(COMMENT_MARKER);
    }
    expect(renderReport({ status: "scanned", ranges: [], scan: scan() })).toContain(
      COMMENT_MARKER,
    );
  });

  it("변경이 없으면 짧게 알린다", () => {
    expect(renderReport({ status: "no-changes", ranges: [] })).toContain(
      "대상 소스 변경이 없습니다",
    );
  });

  it("Stryker 실패는 경고와 로그를 보여준다", () => {
    const md = renderReport({ status: "stryker-failed", ranges: [], error: "boom" });
    expect(md).toContain("⚠️");
    expect(md).toContain("boom");
  });
});

describe("renderReport — 제안", () => {
  const base: PipelineResult = {
    status: "generated",
    ranges: RANGES,
    scan: scan(),
    results: [accepted()],
    summary: {
      total: 1,
      accepted: 1,
      rejectedBy: {},
      totalAttempts: 1,
      gateRejections: {},
      rescuedByRetry: 0,
    },
  };

  it("무엇을 찾았는지 도구 용어 없이 요약한다", () => {
    const md = renderReport(base);
    expect(md).toContain("테스트가 지키지 않는 지점");
  });

  it("지적을 사람 말로 설명한다", () => {
    expect(renderReport(base)).toContain("항상 거짓");
  });

  it("파일별로 묶어 보여준다", () => {
    const md = renderReport(base);
    expect(md).toContain("#### `lib/guard.ts`");
    expect(md).toContain("**L38**");
  });

  it("테스트 소스와 경로를 접이식으로 담는다", () => {
    const md = renderReport(base);
    expect(md).toContain("tests/guard.mh-29-0.test.ts");
    expect(md).toContain("it('x', () => {});");
    expect(md).toContain("<details>");
  });

  it("같은 줄의 같은 종류 지적을 한 번만 보여준다", () => {
    // 한 줄에 옵셔널 체이닝이 셋이면 뮤턴트도 셋이지만 사람에겐 같은 지적이다.
    const md = renderReport({
      ...base,
      results: [accepted({ column: 1 }), accepted({ column: 9 })],
    });
    expect(md.match(/\*\*L38\*\*/g)).toHaveLength(1);
  });

  it("줄이 다르면 각각 보여준다", () => {
    const md = renderReport({
      ...base,
      results: [accepted({ line: 38 }), accepted({ line: 42 })],
    });
    expect(md).toContain("**L38**");
    expect(md).toContain("**L42**");
  });

  it("채택 안 된 것은 제안에 넣지 않는다", () => {
    const md = renderReport({
      ...base,
      results: [{ ...accepted(), accepted: false }],
      summary: {
        total: 1,
        accepted: 0,
        rejectedBy: { "kills-mutant": 1 },
        totalAttempts: 1,
        gateRejections: { "kills-mutant": 1 },
        rescuedByRetry: 0,
      },
    });
    expect(md).toContain("제안할 테스트가 없습니다");
    expect(md).toContain("증명하지 못한 것은 제안하지 않습니다");
  });
});

describe("renderReport — 검증 요약", () => {
  it("게이트 이름을 사람 말로 옮긴다", () => {
    const md = renderReport({
      status: "generated",
      ranges: RANGES,
      scan: scan(),
      results: [accepted()],
      summary: {
        total: 3,
        accepted: 1,
        rejectedBy: { "kills-mutant": 2 },
        totalAttempts: 5,
        gateRejections: { "kills-mutant": 2, "passes-on-original": 1 },
        rescuedByRetry: 0,
      },
    });
    expect(md).toContain("결함을 실제로 잡는가");
    expect(md).toContain("현재 코드에서 통과하는가");
    expect(md).toContain("**3건**을 검증에서 걸러냈습니다");
  });

  it("제외한 뮤턴트를 사유와 함께 항상 밝힌다", () => {
    // 조용한 절삭은 "다 훑었다"는 착시를 만든다.
    const md = renderReport({
      status: "scanned",
      ranges: RANGES,
      scan: scan({
        filtered: [
          { mutant: MUTANT, reason: "noise-string-literal" },
          { mutant: MUTANT, reason: "no-coverage" },
        ],
      }),
    });
    expect(md).toContain("문자열 상수 변형");
    expect(md).toContain("테스트가 아예 없는 지점");
  });

  it("스캔만 했으면 그렇다고 밝힌다", () => {
    const md = renderReport({ status: "scanned", ranges: RANGES, scan: scan() });
    expect(md).toContain("테스트 생성은 실행하지 않았습니다");
  });
});

describe("renderReport — 길이 상한", () => {
  it("GitHub 상한을 넘지 않게 자르고 잘랐다고 밝힌다", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ...accepted({ line: i + 1 }),
      testSource: "x".repeat(500),
    }));
    const md = renderReport({
      status: "generated",
      ranges: RANGES,
      scan: scan(),
      results: many,
      summary: {
        total: 400,
        accepted: 400,
        rejectedBy: {},
        totalAttempts: 400,
        gateRejections: {},
        rescuedByRetry: 0,
      },
    });
    expect(md.length).toBeLessThanOrEqual(60_000);
    expect(md).toContain("일부를 생략했습니다");
  });
});
