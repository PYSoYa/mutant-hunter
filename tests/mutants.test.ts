import { describe, expect, it } from "vitest";
import { mutantKey, scanReport } from "../src/mutants.js";

function report(
  mutants: {
    id: string;
    mutatorName: string;
    status: string;
    line: number;
    col?: number;
    endCol?: number;
    replacement?: string;
  }[],
) {
  return {
    files: {
      "src/a.ts": {
        source: ["const x = 1;", "if (a > b) return 1;", "const s = 'hi';"].join(
          "\n",
        ),
        mutants: mutants.map((m) => ({
          id: m.id,
          mutatorName: m.mutatorName,
          status: m.status,
          replacement: m.replacement ?? "false",
          location: {
            start: { line: m.line, column: m.col ?? 1 },
            end: { line: m.line, column: m.endCol ?? 5 },
          },
        })),
      },
    },
  };
}

describe("scanReport", () => {
  it("생존 뮤턴트를 후보로 올린다", () => {
    const r = scanReport(
      report([{ id: "1", mutatorName: "ConditionalExpression", status: "Survived", line: 2 }]),
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.path).toBe("src/a.ts");
    expect(r.candidates[0]!.mutatorName).toBe("ConditionalExpression");
  });

  it("죽은 뮤턴트는 후보에도 필터에도 넣지 않는다", () => {
    const r = scanReport(
      report([
        { id: "1", mutatorName: "EqualityOperator", status: "Killed", line: 2 },
        { id: "2", mutatorName: "EqualityOperator", status: "Timeout", line: 2 },
      ]),
    );
    expect(r.candidates).toEqual([]);
    expect(r.filtered).toEqual([]);
    expect(r.stats.killed).toBe(1);
    expect(r.stats.timeout).toBe(1);
  });

  it("StringLiteral 변이를 노이즈로 걸러낸다", () => {
    const r = scanReport(
      report([{ id: "1", mutatorName: "StringLiteral", status: "Survived", line: 3 }]),
    );
    expect(r.candidates).toEqual([]);
    expect(r.filtered[0]!.reason).toBe("noise-string-literal");
  });

  it("등가 의심 목록에 있는 뮤턴트를 걸러낸다", () => {
    const raw = report([
      { id: "1", mutatorName: "MethodExpression", status: "Survived", line: 2, col: 7 },
    ]);
    const key = mutantKey({
      path: "src/a.ts",
      mutatorName: "MethodExpression",
      line: 2,
      column: 7,
    });
    const r = scanReport(raw, { suspectedEquivalents: new Set([key]) });
    expect(r.candidates).toEqual([]);
    expect(r.filtered[0]!.reason).toBe("suspected-equivalent");
  });

  it("커버리지 없는 뮤턴트는 별도 사유로 분리한다", () => {
    const r = scanReport(
      report([{ id: "1", mutatorName: "BlockStatement", status: "NoCoverage", line: 2 }]),
    );
    expect(r.candidates).toEqual([]);
    expect(r.filtered[0]!.reason).toBe("no-coverage");
    expect(r.stats.noCoverage).toBe(1);
  });

  it("CompileError 같은 상태는 갭 신호로 세지 않는다", () => {
    const r = scanReport(
      report([{ id: "1", mutatorName: "BlockStatement", status: "CompileError", line: 2 }]),
    );
    expect(r.candidates).toEqual([]);
    expect(r.stats.survived).toBe(0);
    expect(r.stats.mutationScore).toBe(100);
  });

  it("뮤테이션 스코어를 killed+timeout 기준으로 계산한다", () => {
    const r = scanReport(
      report([
        { id: "1", mutatorName: "A", status: "Killed", line: 2 },
        { id: "2", mutatorName: "B", status: "Timeout", line: 2 },
        { id: "3", mutatorName: "C", status: "Survived", line: 2 },
        { id: "4", mutatorName: "D", status: "NoCoverage", line: 2 },
      ]),
    );
    expect(r.stats.mutationScore).toBe(50);
  });

  it("뮤턴트가 하나도 없으면 100점으로 둔다", () => {
    expect(scanReport(report([])).stats.mutationScore).toBe(100);
  });

  it("원본 코드 조각을 뮤턴트에 붙인다", () => {
    const r = scanReport(
      report([
        {
          id: "1",
          mutatorName: "ConditionalExpression",
          status: "Survived",
          line: 2,
          col: 5,
          endCol: 10,
        },
      ]),
    );
    expect(r.candidates[0]!.original).toBe("a > b");
  });
});
