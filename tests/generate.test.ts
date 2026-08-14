import { describe, expect, it } from "vitest";
import { summarize, type GenerationResult } from "../src/generate.js";
import { MockProvider } from "../src/llm/provider.js";
import { backoffMs } from "../src/llm/gemini.js";
import type { Mutant } from "../src/types.js";

const MUTANT: Mutant = {
  id: "1",
  path: "lib/a.ts",
  mutatorName: "ConditionalExpression",
  status: "Survived",
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  replacement: "false",
  original: "x",
};

function result(over: Partial<GenerationResult>): GenerationResult {
  return { mutant: MUTANT, accepted: false, attempts: [], ...over };
}

describe("summarize", () => {
  it("채택 수와 시도 수를 센다", () => {
    const s = summarize([
      result({ accepted: true, attempts: [{ index: 0, gates: [] }] }),
      result({ attempts: [{ index: 0, gates: [] }, { index: 1, gates: [] }] }),
    ]);
    expect(s.total).toBe(2);
    expect(s.accepted).toBe(1);
    expect(s.totalAttempts).toBe(3);
  });

  it("마지막 시도가 떨어진 게이트로 사유를 집계한다", () => {
    const s = summarize([
      result({ attempts: [{ index: 0, gates: [], rejectedAt: "kills-mutant" }] }),
      result({ attempts: [{ index: 0, gates: [], rejectedAt: "kills-mutant" }] }),
      result({ attempts: [{ index: 0, gates: [], rejectedAt: "passes-on-original" }] }),
    ]);
    expect(s.rejectedBy).toEqual({ "kills-mutant": 2, "passes-on-original": 1 });
  });

  it("LLM 오류는 게이트 폐기와 구분한다", () => {
    // 쿼터 소진과 "테스트가 나빴다"를 섞으면 품질 지표가 오염된다.
    const s = summarize([result({ error: "429 quota" })]);
    expect(s.rejectedBy).toEqual({ "llm-error": 1 });
  });

  it("채택된 것은 사유 집계에 넣지 않는다", () => {
    expect(summarize([result({ accepted: true })]).rejectedBy).toEqual({});
  });
});

describe("summarize — 게이트 폐기 전수 집계", () => {
  it("모든 시도의 게이트 폐기를 센다", () => {
    // rejectedBy는 마지막 시도만 센다. 1차에서 걸렸다가 2차에 통과하면
    // "게이트가 걸러냈다"는 사실이 사라진다 — 안전망 크기 측정에 정반대다.
    const s = summarize([
      result({
        accepted: true,
        attempts: [
          { index: 0, gates: [], rejectedAt: "kills-mutant" },
          { index: 1, gates: [] },
        ],
      }),
    ]);
    expect(s.gateRejections).toEqual({ "kills-mutant": 1 });
    expect(s.rejectedBy).toEqual({});
    expect(s.rescuedByRetry).toBe(1);
  });

  it("게이트에 걸린 적 없이 채택된 것은 구조된 게 아니다", () => {
    const s = summarize([
      result({ accepted: true, attempts: [{ index: 0, gates: [] }] }),
    ]);
    expect(s.rescuedByRetry).toBe(0);
    expect(s.gateRejections).toEqual({});
  });

  it("끝내 폐기된 것은 양쪽 모두에 잡힌다", () => {
    const s = summarize([
      result({
        attempts: [
          { index: 0, gates: [], rejectedAt: "kills-mutant" },
          { index: 1, gates: [], rejectedAt: "passes-on-original" },
        ],
      }),
    ]);
    expect(s.gateRejections).toEqual({
      "kills-mutant": 1,
      "passes-on-original": 1,
    });
    expect(s.rejectedBy).toEqual({ "passes-on-original": 1 });
    expect(s.rescuedByRetry).toBe(0);
  });

  it("LLM 오류는 게이트 폐기로 세지 않는다", () => {
    // 쿼터 소진을 안전망 실적에 섞으면 게이트 효과가 부풀려진다.
    const s = summarize([result({ error: "429" })]);
    expect(s.gateRejections).toEqual({});
    expect(s.rejectedBy).toEqual({ "llm-error": 1 });
  });
});

describe("MockProvider", () => {
  it("정해둔 응답을 순서대로 돌려준다", async () => {
    const p = new MockProvider(["첫번째", "두번째"]);
    expect((await p.generate()).text).toBe("첫번째");
    expect((await p.generate()).text).toBe("두번째");
  });

  it("응답이 떨어지면 빈 문자열을 준다", async () => {
    const p = new MockProvider([]);
    expect((await p.generate()).text).toBe("");
  });
});

describe("backoffMs", () => {
  it("지수적으로 늘어난다", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
  });

  it("상한을 넘지 않는다", () => {
    // 무료 티어 분당 제한을 기다리되, CI를 무한정 붙잡지 않는다.
    expect(backoffMs(10)).toBe(8000);
  });
});
