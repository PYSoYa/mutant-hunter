import { describe, expect, it } from "vitest";
import type { EvalRun } from "../src/eval/metrics.js";
import {
  computeNoiseFloor,
  computeStat,
  isWithinNoise,
  renderNoiseFloor,
} from "../src/eval/variance.js";

function run(acceptRate: number, accepted: number, llmCalls: number): EvalRun {
  return {
    label: "x",
    provider: "mistral",
    entries: [],
    aggregate: {
      entries: 1,
      totalMutants: 0,
      totalCandidates: 0,
      weightedMutationScore: 0,
      totalDurationMs: 0,
      acceptRate,
      accepted,
      llmCalls,
    },
  };
}

describe("computeStat", () => {
  it("평균·최소·최대·범위를 낸다", () => {
    const s = computeStat([25, 29, 21]);
    expect(s.mean).toBeCloseTo(25, 5);
    expect(s.min).toBe(21);
    expect(s.max).toBe(29);
    expect(s.range).toBe(8);
  });

  it("표본표준편차를 n-1로 계산한다", () => {
    // 모집단 표준편차(n)로 나누면 흔들림을 실제보다 작게 보고하게 된다.
    expect(computeStat([2, 4, 6]).stdev).toBeCloseTo(2, 5);
  });

  it("관측이 1회면 흔들림을 말하지 않는다", () => {
    const s = computeStat([42]);
    expect(s.stdev).toBe(0);
    expect(s.range).toBe(0);
  });

  it("빈 입력을 견딘다", () => {
    expect(computeStat([]).mean).toBe(0);
  });

  it("모두 같으면 범위가 0이다", () => {
    expect(computeStat([5, 5, 5]).range).toBe(0);
  });
});

describe("computeNoiseFloor", () => {
  it("반복 실행에서 채택률 범위를 판정 기준으로 삼는다", () => {
    const floor = computeNoiseFloor([
      run(25, 6, 45),
      run(29.17, 7, 42),
      run(20.83, 5, 44),
    ]);
    expect(floor.runs).toBe(3);
    expect(floor.minimumDetectableChange).toBeCloseTo(8.34, 2);
    expect(floor.accepted.range).toBe(2);
  });

  it("생성 지표가 없는 실행도 0으로 처리한다", () => {
    const bare: EvalRun = {
      label: "x",
      entries: [],
      aggregate: {
        entries: 0,
        totalMutants: 0,
        totalCandidates: 0,
        weightedMutationScore: 0,
        totalDurationMs: 0,
      },
    };
    expect(() => computeNoiseFloor([bare])).not.toThrow();
  });
});

describe("isWithinNoise", () => {
  const floor = computeNoiseFloor([run(25, 6, 45), run(29, 7, 42), run(21, 5, 44)]);

  it("잡음 폭 안의 변화는 효과가 아니다", () => {
    expect(isWithinNoise(4, floor)).toBe(true);
    expect(isWithinNoise(-4, floor)).toBe(true);
  });

  it("폭을 넘으면 효과일 수 있다", () => {
    expect(isWithinNoise(20, floor)).toBe(false);
  });

  it("경계값은 잡음으로 본다", () => {
    // 애매하면 효과가 아니라고 보는 쪽이 안전하다.
    expect(isWithinNoise(floor.minimumDetectableChange, floor)).toBe(true);
  });
});

describe("renderNoiseFloor", () => {
  it("관측값과 판정 기준을 함께 보여준다", () => {
    const md = renderNoiseFloor(
      computeNoiseFloor([run(25, 6, 45), run(29, 7, 42), run(21, 5, 44)]),
      "noise",
    );
    expect(md).toContain("3회");
    expect(md).toContain("효과라고 주장할 수 없다");
  });

  it("반복이 적으면 신뢰하지 말라고 경고한다", () => {
    expect(renderNoiseFloor(computeNoiseFloor([run(25, 6, 45)]), "x")).toContain(
      "신뢰하기 어렵다",
    );
  });

  it("3회여도 하한으로만 읽으라고 덧붙인다", () => {
    // 3회로 분포를 말할 수 없다. 과신을 막는 문장이 필요하다.
    const md = renderNoiseFloor(
      computeNoiseFloor([run(25, 6, 45), run(29, 7, 42), run(21, 5, 44)]),
      "x",
    );
    expect(md).toContain("하한으로 읽어야");
  });
});
