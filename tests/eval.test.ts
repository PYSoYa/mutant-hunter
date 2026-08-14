import { describe, expect, it } from "vitest";
import { CorpusError, parseCorpus } from "../src/eval/corpus.js";
import {
  aggregate,
  compareRuns,
  computeMetrics,
  type EntryMetrics,
  type EvalRun,
} from "../src/eval/metrics.js";
import { renderEvalReport } from "../src/eval/report.js";
import type { PipelineResult } from "../src/pipeline.js";

const VALID = {
  entries: [
    {
      name: "sample",
      source: { type: "git", url: "https://x/y.git", sha: "a1b2c3d" },
      diff: { type: "refs", base: "HEAD~1", head: "HEAD" },
    },
  ],
};

describe("parseCorpus", () => {
  it("올바른 코퍼스를 통과시킨다", () => {
    expect(parseCorpus(VALID).entries).toHaveLength(1);
  });

  it("git 표본의 브랜치 이름을 거부한다", () => {
    // 표본이 움직이면 회귀 비교가 무의미해진다.
    const raw = {
      entries: [{ ...VALID.entries[0], source: { type: "git", url: "u", sha: "main" } }],
    };
    expect(() => parseCorpus(raw)).toThrow(/커밋 SHA/);
  });

  it("짧은 SHA는 허용한다", () => {
    const raw = {
      entries: [{ ...VALID.entries[0], source: { type: "git", url: "u", sha: "a1b2c3d" } }],
    };
    expect(() => parseCorpus(raw)).not.toThrow();
  });

  it("이름 중복을 거부한다", () => {
    // 겹치면 결과 비교에서 조용히 한쪽을 덮어쓴다.
    const raw = { entries: [VALID.entries[0], VALID.entries[0]] };
    expect(() => parseCorpus(raw)).toThrow(/중복/);
  });

  it("local 표본은 path를 요구한다", () => {
    const raw = { entries: [{ ...VALID.entries[0], source: { type: "local" } }] };
    expect(() => parseCorpus(raw)).toThrow(/path/);
  });

  it("알 수 없는 source.type을 거부한다", () => {
    const raw = { entries: [{ ...VALID.entries[0], source: { type: "svn" } }] };
    expect(() => parseCorpus(raw)).toThrow(CorpusError);
  });

  it("entries가 없으면 거부한다", () => {
    expect(() => parseCorpus({})).toThrow(/entries/);
    expect(() => parseCorpus(null)).toThrow(CorpusError);
  });
});

describe("computeMetrics", () => {
  const scanned: PipelineResult = {
    status: "scanned",
    ranges: [],
    scan: {
      candidates: [],
      filtered: [],
      stats: {
        total: 100,
        killed: 60,
        survived: 30,
        noCoverage: 10,
        timeout: 0,
        mutationScore: 60,
      },
    },
  };

  it("스캔 지표를 뽑는다", () => {
    const m = computeMetrics("a", scanned, 1500);
    expect(m.mutationScore).toBe(60);
    expect(m.totalMutants).toBe(100);
    expect(m.durationMs).toBe(1500);
    expect(m.acceptRate).toBeUndefined();
  });

  it("생성이 돌았으면 채택률을 계산한다", () => {
    const m = computeMetrics(
      "a",
      {
        ...scanned,
        status: "generated",
        summary: { total: 4, accepted: 3, rejectedBy: { "kills-mutant": 1 }, totalAttempts: 6 },
      },
      100,
    );
    expect(m.acceptRate).toBe(75);
    expect(m.llmCalls).toBe(6);
  });

  it("시도가 0이면 채택률은 0이다", () => {
    const m = computeMetrics(
      "a",
      {
        ...scanned,
        status: "generated",
        summary: { total: 0, accepted: 0, rejectedBy: {}, totalAttempts: 0 },
      },
      100,
    );
    expect(m.acceptRate).toBe(0);
  });
});

describe("aggregate", () => {
  const entry = (over: Partial<EntryMetrics>): EntryMetrics => ({
    name: "x",
    status: "scanned",
    durationMs: 0,
    mutationScore: 0,
    totalMutants: 0,
    survived: 0,
    noCoverage: 0,
    candidates: 0,
    filtered: {},
    ...over,
  });

  it("뮤테이션 스코어를 뮤턴트 수로 가중한다", () => {
    // 표본별 단순 평균이면 50%가 나온다. 큰 표본이 지배해야 맞다.
    const a = aggregate([
      entry({ totalMutants: 10, mutationScore: 100 }),
      entry({ totalMutants: 990, mutationScore: 0 }),
    ]);
    expect(a.weightedMutationScore).toBeCloseTo(1, 5);
  });

  it("뮤턴트가 없으면 0으로 둔다", () => {
    expect(aggregate([]).weightedMutationScore).toBe(0);
  });

  it("생성 지표가 없으면 채택률을 만들지 않는다", () => {
    expect(aggregate([entry({})]).acceptRate).toBeUndefined();
  });

  it("폐기 사유를 합산한다", () => {
    const a = aggregate([
      entry({ attempted: 2, accepted: 1, llmCalls: 3, rejectedBy: { "kills-mutant": 1 } }),
      entry({ attempted: 2, accepted: 0, llmCalls: 4, rejectedBy: { "kills-mutant": 2 } }),
    ]);
    expect(a.rejectedBy).toEqual({ "kills-mutant": 3 });
    expect(a.acceptRate).toBe(25);
    expect(a.llmCalls).toBe(7);
  });
});

describe("compareRuns", () => {
  const run = (label: string, over: Partial<EvalRun["aggregate"]>, names = ["a"]): EvalRun => ({
    label,
    entries: names.map((n) => ({
      name: n,
      status: "generated" as const,
      durationMs: 0,
      mutationScore: 0,
      totalMutants: 0,
      survived: 0,
      noCoverage: 0,
      candidates: 0,
      filtered: {},
    })),
    aggregate: {
      entries: names.length,
      totalMutants: 0,
      totalCandidates: 0,
      weightedMutationScore: 0,
      totalDurationMs: 0,
      ...over,
    },
  });

  it("채택률 하락을 회귀로 본다", () => {
    const c = compareRuns(run("before", { acceptRate: 80 }), run("after", { acceptRate: 70 }));
    expect(c.hasRegression).toBe(true);
    expect(c.deltas.find((d) => d.metric === "acceptRate")?.delta).toBe(-10);
  });

  it("임계치 이내 변동은 회귀가 아니다", () => {
    const c = compareRuns(run("b", { acceptRate: 80 }), run("a", { acceptRate: 79 }));
    expect(c.hasRegression).toBe(false);
  });

  it("채택률 상승은 회귀가 아니다", () => {
    const c = compareRuns(run("b", { acceptRate: 70 }), run("a", { acceptRate: 90 }));
    expect(c.hasRegression).toBe(false);
  });

  it("LLM 호출이 크게 늘면 회귀로 본다", () => {
    const c = compareRuns(
      run("b", { acceptRate: 80, llmCalls: 10 }),
      run("a", { acceptRate: 80, llmCalls: 20 }),
    );
    expect(c.deltas.find((d) => d.metric === "llmCalls")?.regression).toBe(true);
  });

  it("표본이 사라지면 회귀로 본다", () => {
    // 어려운 표본을 빼면 점수는 언제든 올라간다.
    const c = compareRuns(
      run("b", { acceptRate: 80 }, ["a", "b"]),
      run("a", { acceptRate: 90 }, ["a"]),
    );
    expect(c.hasRegression).toBe(true);
    expect(c.removed).toEqual(["b"]);
  });

  it("provider가 바뀐 비교를 표시한다", () => {
    // 모델과 프롬프트를 한 번에 바꾸면 무엇이 효과를 냈는지 알 수 없다.
    const before = { ...run("b", { acceptRate: 80 }), provider: "gemini" };
    const after = { ...run("a", { acceptRate: 80 }), provider: "mistral" };
    expect(compareRuns(before, after).providerChanged).toBe(true);
  });

  it("같은 provider면 표시하지 않는다", () => {
    const before = { ...run("b", { acceptRate: 80 }), provider: "gemini" };
    const after = { ...run("a", { acceptRate: 80 }), provider: "gemini" };
    expect(compareRuns(before, after).providerChanged).toBe(false);
  });

  it("provider 정보가 없으면 판정하지 않는다", () => {
    expect(compareRuns(run("b", {}), run("a", {})).providerChanged).toBe(false);
  });

  it("표본 추가는 회귀가 아니다", () => {
    const c = compareRuns(
      run("b", { acceptRate: 80 }, ["a"]),
      run("a", { acceptRate: 80 }, ["a", "b"]),
    );
    expect(c.hasRegression).toBe(false);
    expect(c.added).toEqual(["b"]);
  });
});

describe("renderEvalReport", () => {
  const run: EvalRun = {
    label: "baseline",
    entries: [
      {
        name: "sample",
        status: "scanned",
        durationMs: 1200,
        mutationScore: 63.16,
        totalMutants: 57,
        survived: 17,
        noCoverage: 4,
        candidates: 12,
        filtered: {},
      },
    ],
    aggregate: {
      entries: 1,
      totalMutants: 57,
      totalCandidates: 12,
      weightedMutationScore: 63.16,
      totalDurationMs: 1200,
    },
  };

  it("생성 없이 돌았으면 그렇다고 밝힌다", () => {
    const md = renderEvalReport(run);
    expect(md).toContain("생성 단계를 실행하지 않았습니다");
    expect(md).toContain("63.16%");
  });

  it("회귀를 눈에 띄게 표시한다", () => {
    const md = renderEvalReport(run, {
      deltas: [
        { metric: "acceptRate", before: 80, after: 60, delta: -20, regression: true },
      ],
      added: [],
      removed: [],
      providerChanged: false,
      hasRegression: true,
    });
    expect(md).toContain("회귀가 감지됐습니다");
    expect(md).toContain("⚠️");
  });
});
