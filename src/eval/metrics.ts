import type { PipelineResult } from "../pipeline.js";

export type EntryMetrics = {
  name: string;
  status: PipelineResult["status"];
  durationMs: number;
  /** 변경 범위의 뮤테이션 스코어 (%) */
  mutationScore: number;
  totalMutants: number;
  survived: number;
  noCoverage: number;
  /** LLM에 넘긴 후보 수 */
  candidates: number;
  filtered: Record<string, number>;

  // 생성 단계가 돌았을 때만 채워진다.
  attempted?: number;
  accepted?: number;
  /** 시도한 뮤턴트 중 게이트를 모두 통과한 비율 (%) */
  acceptRate?: number;
  llmCalls?: number;
  rejectedBy?: Record<string, number>;
  /** 모든 시도 기준 게이트 폐기 — 안전망의 크기 */
  gateRejections?: Record<string, number>;
  rescuedByRetry?: number;
};

export function computeMetrics(
  name: string,
  result: PipelineResult,
  durationMs: number,
): EntryMetrics {
  const stats = result.scan?.stats;
  const filtered: Record<string, number> = {};
  for (const f of result.scan?.filtered ?? []) {
    filtered[f.reason] = (filtered[f.reason] ?? 0) + 1;
  }

  const base: EntryMetrics = {
    name,
    status: result.status,
    durationMs,
    mutationScore: stats?.mutationScore ?? 0,
    totalMutants: stats?.total ?? 0,
    survived: stats?.survived ?? 0,
    noCoverage: stats?.noCoverage ?? 0,
    candidates: result.scan?.candidates.length ?? 0,
    filtered,
  };

  const summary = result.summary;
  if (!summary) return base;

  return {
    ...base,
    attempted: summary.total,
    accepted: summary.accepted,
    acceptRate: summary.total === 0 ? 0 : (summary.accepted / summary.total) * 100,
    llmCalls: summary.totalAttempts,
    rejectedBy: summary.rejectedBy,
    gateRejections: summary.gateRejections,
    rescuedByRetry: summary.rescuedByRetry,
  };
}

export type Aggregate = {
  entries: number;
  totalMutants: number;
  totalCandidates: number;
  /** 표본 전체를 하나로 본 뮤테이션 스코어. 표본별 평균이 아니다. */
  weightedMutationScore: number;
  totalDurationMs: number;
  attempted?: number;
  accepted?: number;
  acceptRate?: number;
  llmCalls?: number;
  rejectedBy?: Record<string, number>;
  gateRejections?: Record<string, number>;
  rescuedByRetry?: number;
  /** 게이트가 떨어뜨린 총 횟수 */
  totalGateRejections?: number;
};

/**
 * 표본을 합산한다.
 *
 * 뮤테이션 스코어는 표본별 평균이 아니라 뮤턴트 수로 가중한다.
 * 뮤턴트 3개짜리 표본과 500개짜리 표본을 같은 무게로 세면 숫자가 거짓말을 한다.
 */
export function aggregate(entries: EntryMetrics[]): Aggregate {
  let totalMutants = 0;
  let killedLike = 0;
  let totalCandidates = 0;
  let totalDurationMs = 0;

  let attempted = 0;
  let accepted = 0;
  let llmCalls = 0;
  let sawGeneration = false;
  let rescuedByRetry = 0;
  const rejectedBy: Record<string, number> = {};
  const gateRejections: Record<string, number> = {};

  for (const e of entries) {
    totalMutants += e.totalMutants;
    killedLike += (e.mutationScore / 100) * e.totalMutants;
    totalCandidates += e.candidates;
    totalDurationMs += e.durationMs;

    if (e.attempted !== undefined) {
      sawGeneration = true;
      attempted += e.attempted;
      accepted += e.accepted ?? 0;
      llmCalls += e.llmCalls ?? 0;
      rescuedByRetry += e.rescuedByRetry ?? 0;
      for (const [k, n] of Object.entries(e.rejectedBy ?? {})) {
        rejectedBy[k] = (rejectedBy[k] ?? 0) + n;
      }
      for (const [k, n] of Object.entries(e.gateRejections ?? {})) {
        gateRejections[k] = (gateRejections[k] ?? 0) + n;
      }
    }
  }

  const base: Aggregate = {
    entries: entries.length,
    totalMutants,
    totalCandidates,
    weightedMutationScore: totalMutants === 0 ? 0 : (killedLike / totalMutants) * 100,
    totalDurationMs,
  };

  if (!sawGeneration) return base;

  return {
    ...base,
    attempted,
    accepted,
    acceptRate: attempted === 0 ? 0 : (accepted / attempted) * 100,
    llmCalls,
    rejectedBy,
    gateRejections,
    rescuedByRetry,
    totalGateRejections: Object.values(gateRejections).reduce((a, b) => a + b, 0),
  };
}

export type EvalRun = {
  /** 호출자가 찍어 넣는다. 하네스는 시계를 직접 읽지 않는다. */
  label: string;
  /**
   * 이 실행에 쓴 provider. 생성 단계를 돌리지 않았으면 없다.
   *
   * 어떤 모델이 만든 숫자인지 모른 채 두 실행을 비교하면
   * 프롬프트 개선과 모델 교체를 구분할 수 없다.
   */
  provider?: string;
  entries: EntryMetrics[];
  aggregate: Aggregate;
};

export type MetricDelta = {
  metric: string;
  before: number;
  after: number;
  delta: number;
  /** 임계치를 넘는 악화인가 */
  regression: boolean;
};

export type Comparison = {
  deltas: MetricDelta[];
  /** 이전 실행에 없던 표본 */
  added: string[];
  /** 이번 실행에서 사라진 표본 — 조용한 커버리지 축소를 잡는다 */
  removed: string[];
  /** provider가 바뀌었는가. 바뀌었다면 프롬프트 개선과 구분할 수 없다 */
  providerChanged: boolean;
  hasRegression: boolean;
};

/** 악화로 볼 최소 변화폭 (퍼센트포인트). 잡음에 반응하지 않기 위한 것. */
const REGRESSION_THRESHOLD = 2;

/**
 * 두 실행을 비교한다. 좋아진 것보다 **나빠진 것**을 놓치지 않는 게 목적이다.
 *
 * acceptRate는 높을수록 좋고, 나머지 비용 지표는 낮을수록 좋다.
 * 방향을 섞으면 "개선"과 "악화"가 뒤집혀 보고된다.
 */
export function compareRuns(before: EvalRun, after: EvalRun): Comparison {
  const providerChanged =
    before.provider !== undefined &&
    after.provider !== undefined &&
    before.provider !== after.provider;

  const beforeNames = new Set(before.entries.map((e) => e.name));
  const afterNames = new Set(after.entries.map((e) => e.name));

  const deltas: MetricDelta[] = [
    higherIsBetter(
      "acceptRate",
      before.aggregate.acceptRate ?? 0,
      after.aggregate.acceptRate ?? 0,
    ),
    higherIsBetter(
      "weightedMutationScore",
      before.aggregate.weightedMutationScore,
      after.aggregate.weightedMutationScore,
    ),
    lowerIsBetter("llmCalls", before.aggregate.llmCalls ?? 0, after.aggregate.llmCalls ?? 0),
  ];

  const removed = [...beforeNames].filter((n) => !afterNames.has(n));

  return {
    deltas,
    added: [...afterNames].filter((n) => !beforeNames.has(n)),
    removed,
    providerChanged,
    // 표본이 사라진 것도 회귀다. 어려운 표본을 빼면 점수는 언제든 올라간다.
    hasRegression: deltas.some((d) => d.regression) || removed.length > 0,
  };
}

function higherIsBetter(metric: string, before: number, after: number): MetricDelta {
  const delta = after - before;
  return { metric, before, after, delta, regression: delta < -REGRESSION_THRESHOLD };
}

function lowerIsBetter(metric: string, before: number, after: number): MetricDelta {
  const delta = after - before;
  // 호출 수는 퍼센트가 아니라 절대값이므로 비율로 판정한다.
  const worseByRatio = before > 0 && delta / before > 0.2;
  return { metric, before, after, delta, regression: worseByRatio };
}
