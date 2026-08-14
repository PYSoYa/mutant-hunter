import type { EvalRun } from "./metrics.js";

export type Stat = {
  values: number[];
  mean: number;
  min: number;
  max: number;
  /** max - min. 관측된 흔들림의 폭. */
  range: number;
  /** 표본표준편차 (n-1). 관측이 2회 미만이면 0. */
  stdev: number;
};

export type NoiseFloor = {
  runs: number;
  acceptRate: Stat;
  accepted: Stat;
  llmCalls: Stat;
  /**
   * 효과라고 주장하려면 넘어야 하는 최소 변화폭 (퍼센트포인트).
   *
   * 관측된 범위를 그대로 쓴다. 표본이 적을 때 표준편차 기반 신뢰구간은
   * 실제보다 좁게 나오기 쉬운데, 범위는 최소한 "이 정도는 그냥 흔들렸다"를
   * 보수적으로 말해준다.
   */
  minimumDetectableChange: number;
};

export function computeStat(values: number[]): Stat {
  if (values.length === 0) {
    return { values, mean: 0, min: 0, max: 0, range: 0, stdev: 0 };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  // 표본표준편차. 관측 1회로는 흔들림을 말할 수 없다.
  const stdev =
    values.length < 2
      ? 0
      : Math.sqrt(
          values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1),
        );

  return { values, mean, min, max, range: max - min, stdev };
}

/** 같은 조건으로 반복 실행한 결과들에서 잡음 폭을 뽑는다. */
export function computeNoiseFloor(runs: EvalRun[]): NoiseFloor {
  const acceptRate = computeStat(runs.map((r) => r.aggregate.acceptRate ?? 0));
  const accepted = computeStat(runs.map((r) => r.aggregate.accepted ?? 0));
  const llmCalls = computeStat(runs.map((r) => r.aggregate.llmCalls ?? 0));

  return {
    runs: runs.length,
    acceptRate,
    accepted,
    llmCalls,
    minimumDetectableChange: acceptRate.range,
  };
}

/** 어떤 변화가 잡음 폭 안인지 판정한다. */
export function isWithinNoise(deltaPp: number, floor: NoiseFloor): boolean {
  return Math.abs(deltaPp) <= floor.minimumDetectableChange;
}

export function renderNoiseFloor(floor: NoiseFloor, label: string): string {
  const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

  const lines = [
    `# 잡음 폭 측정 — ${label}`,
    "",
    `같은 조건으로 **${floor.runs}회** 반복 실행했다. 프롬프트도 모델도 표본도 바꾸지 않았다.`,
    "",
    "| 지표 | 관측값 | 평균 | 범위 |",
    "|---|---|---|---|",
    `| 채택률 (%) | ${floor.acceptRate.values.map(f).join(", ")} | ${f(floor.acceptRate.mean)} | ${f(floor.acceptRate.range)} |`,
    `| 채택 수 | ${floor.accepted.values.map(f).join(", ")} | ${f(floor.accepted.mean)} | ${f(floor.accepted.range)} |`,
    `| LLM 호출 | ${floor.llmCalls.values.map(f).join(", ")} | ${f(floor.llmCalls.mean)} | ${f(floor.llmCalls.range)} |`,
    "",
    "## 판정 기준",
    "",
    `채택률이 **${f(floor.minimumDetectableChange)}%p** 이하로 움직인 것은 ` +
      `효과라고 주장할 수 없다. 같은 조건에서도 그만큼은 흔들렸다.`,
    "",
  ];

  if (floor.runs < 3) {
    lines.push(
      "> ⚠️ 반복이 3회 미만이라 이 폭은 신뢰하기 어렵다. 하한으로만 쓴다.",
      "",
    );
  } else {
    lines.push(
      `> 반복 ${floor.runs}회는 분포를 말하기엔 여전히 적다. ` +
        "이 폭은 '적어도 이만큼은 흔들린다'는 하한으로 읽어야 하며, " +
        "실제 잡음은 더 클 수 있다.",
      "",
    );
  }

  return lines.join("\n");
}
