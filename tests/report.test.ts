import { describe, expect, it } from "vitest";
import type { PipelineResult } from "../src/pipeline.js";
import { renderReport } from "../src/report.js";
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

describe("renderReport", () => {
  it("변경이 없으면 짧게 알린다", () => {
    const md = renderReport({ status: "no-changes", ranges: [] });
    expect(md).toContain("대상 소스 변경이 없습니다");
  });

  it("Stryker 실패는 경고와 로그를 보여준다", () => {
    const md = renderReport({
      status: "stryker-failed",
      ranges: [],
      error: "boom",
    });
    expect(md).toContain("⚠️");
    expect(md).toContain("boom");
  });

  it("스캔 결과의 핵심 수치를 표로 낸다", () => {
    const md = renderReport({ status: "scanned", ranges: [], scan: scan() });
    expect(md).toContain("63.2%");
    expect(md).toContain("| 살아남은 뮤턴트 | 17개 |");
    expect(md).toContain("테스트 생성은 실행하지 않았습니다");
  });

  it("제외한 뮤턴트를 접이식으로 항상 밝힌다", () => {
    // 조용한 절삭은 "다 훑었다"는 착시를 만든다.
    const md = renderReport({
      status: "scanned",
      ranges: [],
      scan: scan({
        filtered: [
          { mutant: MUTANT, reason: "noise-string-literal" },
          { mutant: MUTANT, reason: "no-coverage" },
        ],
      }),
    });
    expect(md).toContain("필터로 제외한 뮤턴트");
    expect(md).toContain("`noise-string-literal`: 1개");
    expect(md).toContain("`no-coverage`: 1개");
  });

  it("채택된 제안에 diff와 테스트 소스를 담는다", () => {
    const result: PipelineResult = {
      status: "generated",
      ranges: [],
      scan: scan(),
      results: [
        {
          mutant: MUTANT,
          accepted: true,
          testSource: "it('x', () => {});",
          testFileRel: "tests/guard.mh-29-0.test.ts",
          attempts: [{ index: 0, gates: [] }],
        },
      ],
      summary: { total: 1, accepted: 1, rejectedBy: {}, totalAttempts: 1, gateRejections: {}, rescuedByRetry: 0 },
    };
    const md = renderReport(result);
    expect(md).toContain("### 제안 1건");
    expect(md).toContain("lib/guard.ts:38");
    expect(md).toContain("+ false");
    expect(md).toContain("tests/guard.mh-29-0.test.ts");
  });

  it("채택이 없으면 증명 못 한 것은 제안하지 않는다고 밝힌다", () => {
    const md = renderReport({
      status: "generated",
      ranges: [],
      scan: scan(),
      results: [
        {
          mutant: MUTANT,
          accepted: false,
          attempts: [{ index: 0, gates: [], rejectedAt: "kills-mutant" }],
        },
      ],
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
    expect(md).toContain("kills-mutant 1");
  });
});
