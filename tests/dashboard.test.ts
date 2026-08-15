import { describe, expect, it } from "vitest";
import { buildDashboard, isDetectable, toPoint } from "../src/dashboard/data.js";
import { renderDashboard } from "../src/dashboard/render.js";
import type { EvalRun } from "../src/eval/metrics.js";

function run(over: {
  label: string;
  provider?: string;
  attempted?: number;
  accepted?: number;
  acceptRate?: number;
}): EvalRun {
  return {
    label: over.label,
    provider: over.provider,
    entries: [],
    aggregate: {
      entries: 1,
      totalMutants: 0,
      totalCandidates: 0,
      weightedMutationScore: 0,
      totalDurationMs: 0,
      attempted: over.attempted,
      accepted: over.accepted,
      acceptRate: over.acceptRate,
      apiCalls: 10,
    },
  };
}

describe("toPoint", () => {
  it("생성을 돌린 실행을 점으로 만든다", () => {
    const p = toPoint(run({ label: "a", attempted: 24, accepted: 6, acceptRate: 25 }));
    expect(p?.acceptRate).toBe(25);
  });

  it("스캔만 한 실행은 점이 아니다", () => {
    // 0으로 그리면 평균이 오염된다.
    expect(toPoint(run({ label: "scan" }))).toBeUndefined();
  });

  it("시도가 0이면 점이 아니다", () => {
    expect(toPoint(run({ label: "x", attempted: 0 }))).toBeUndefined();
  });
});

describe("buildDashboard", () => {
  it("표본 크기와 provider로 코호트를 나눈다", () => {
    // 24개 실행과 102개 실행을 한 줄에 그리면 분해능이 다른 숫자를 나란히 놓게 된다.
    const d = buildDashboard([
      run({ label: "a", provider: "mistral", attempted: 24, acceptRate: 25 }),
      run({ label: "b", provider: "mistral", attempted: 102, acceptRate: 26 }),
    ]);
    expect(d.cohorts).toHaveLength(2);
  });

  it("provider가 다르면 다른 코호트다", () => {
    const d = buildDashboard([
      run({ label: "a", provider: "mistral", attempted: 24, acceptRate: 25 }),
      run({ label: "b", provider: "gemini", attempted: 24, acceptRate: 25 }),
    ]);
    expect(d.cohorts).toHaveLength(2);
  });

  it("표본이 큰 코호트를 위에 둔다", () => {
    const d = buildDashboard([
      run({ label: "a", provider: "m", attempted: 24, acceptRate: 25 }),
      run({ label: "b", provider: "m", attempted: 102, acceptRate: 26 }),
    ]);
    expect(d.cohorts[0]!.attempted).toBe(102);
  });

  it("최소 눈금은 뮤턴트 1건이다", () => {
    const d = buildDashboard([run({ label: "a", attempted: 24, acceptRate: 25 })]);
    expect(d.cohorts[0]!.resolutionPp).toBeCloseTo(4.17, 2);
  });

  it("반복 실행 3회 이상이면 관측된 흔들림을 낸다", () => {
    const d = buildDashboard([
      run({ label: "n-run1", provider: "m", attempted: 24, acceptRate: 29.17 }),
      run({ label: "n-run2", provider: "m", attempted: 24, acceptRate: 25 }),
      run({ label: "n-run3", provider: "m", attempted: 24, acceptRate: 25 }),
    ]);
    expect(d.cohorts[0]!.measuredNoisePp).toBeCloseTo(4.17, 2);
  });

  it("반복이 3회 미만이면 흔들림을 말하지 않는다", () => {
    // 두 점의 차이는 흔들림일 수도 효과일 수도 있다.
    const d = buildDashboard([
      run({ label: "x-run1", provider: "m", attempted: 24, acceptRate: 20 }),
      run({ label: "x-run2", provider: "m", attempted: 24, acceptRate: 30 }),
    ]);
    expect(d.cohorts[0]!.measuredNoisePp).toBeUndefined();
  });

  it("스캔만 한 실행을 따로 세운다", () => {
    const d = buildDashboard([run({ label: "scan-only" })]);
    expect(d.scanOnly).toEqual(["scan-only"]);
    expect(d.cohorts).toEqual([]);
  });
});

describe("isDetectable", () => {
  const cohort = buildDashboard([
    run({ label: "a", provider: "m", attempted: 24, acceptRate: 25 }),
  ]).cohorts[0]!;

  it("최소 눈금 이하는 판정할 수 없다", () => {
    expect(isDetectable(4, cohort)).toBe(false);
  });

  it("눈금을 넘으면 판정 가능하다", () => {
    expect(isDetectable(9, cohort)).toBe(true);
  });

  it("관측된 잡음이 있으면 그것을 기준으로 쓴다", () => {
    const measured = buildDashboard([
      run({ label: "n-run1", provider: "m", attempted: 102, acceptRate: 20 }),
      run({ label: "n-run2", provider: "m", attempted: 102, acceptRate: 30 }),
      run({ label: "n-run3", provider: "m", attempted: 102, acceptRate: 25 }),
    ]).cohorts[0]!;
    // 최소 눈금은 0.98%p지만 실제로는 10%p 흔들렸다.
    expect(isDetectable(5, measured)).toBe(false);
  });
});

describe("renderDashboard", () => {
  const data = buildDashboard([
    run({ label: "a", provider: "mistral", attempted: 24, accepted: 6, acceptRate: 25 }),
  ]);

  it("외부 의존 없이 자기완결 HTML을 만든다", () => {
    const html = renderDashboard(data, "2026-08-15 09:00");
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/<script[^>]*src=/);
    expect(html).not.toMatch(/<link[^>]*href=/);
  });

  it("잡음 폭을 설명한다", () => {
    // 채택률만 그리면 흔들림을 효과로 읽게 된다.
    const html = renderDashboard(data, "x");
    expect(html).toContain("효과라고 주장할 수 없다");
  });

  it("반복 측정이 없으면 그렇다고 밝힌다", () => {
    expect(renderDashboard(data, "x")).toContain("실제 잡음은 더 클 수 있다");
  });

  it("라벨의 HTML을 이스케이프한다", () => {
    const evil = buildDashboard([
      run({ label: "<img src=x onerror=alert(1)>", attempted: 4, acceptRate: 50 }),
    ]);
    const html = renderDashboard(evil, "x");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
