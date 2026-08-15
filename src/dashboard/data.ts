import type { EvalRun } from "../eval/metrics.js";

export type Point = {
  label: string;
  provider?: string;
  /** 시도한 뮤턴트 수 */
  attempted: number;
  accepted: number;
  acceptRate: number;
  apiCalls: number;
  gateRejections: Record<string, number>;
  failureKinds: Record<string, number>;
};

/**
 * 같은 표본 크기·같은 provider로 돌린 것끼리만 비교할 수 있다.
 *
 * 뮤턴트 24개 실행과 102개 실행을 한 줄에 그리면 분해능이 다른 숫자를
 * 나란히 놓게 된다. 24개에서 1건은 4.17%p이고 102개에서는 0.98%p다.
 */
export type Cohort = {
  key: string;
  attempted: number;
  provider?: string;
  points: Point[];
  /**
   * 이 표본 크기에서 뮤턴트 1건이 차지하는 퍼센트포인트.
   * 어떤 변화도 이보다 작을 수 없다 — 측정의 최소 눈금이다.
   */
  resolutionPp: number;
  /**
   * 같은 조건 반복에서 실제로 관측된 흔들림 폭.
   * 반복 측정이 없으면 undefined — 그때는 "모른다"고 말해야 한다.
   */
  measuredNoisePp?: number;
};

export type Dashboard = {
  cohorts: Cohort[];
  totalRuns: number;
  /** 생성 단계를 돌리지 않아 비교 대상이 아닌 실행 */
  scanOnly: string[];
};

export function toPoint(run: EvalRun): Point | undefined {
  const a = run.aggregate;
  // 생성을 돌리지 않은 실행은 채택률이 없다. 0으로 그리면 거짓말이 된다.
  if (a.attempted === undefined || a.attempted === 0) return undefined;

  return {
    label: run.label,
    provider: run.provider,
    attempted: a.attempted,
    accepted: a.accepted ?? 0,
    acceptRate: a.acceptRate ?? 0,
    apiCalls: a.apiCalls ?? a.llmCalls ?? 0,
    gateRejections: a.gateRejections ?? {},
    failureKinds: a.failureKinds ?? {},
  };
}

export function buildDashboard(runs: EvalRun[]): Dashboard {
  const scanOnly: string[] = [];
  const points: Point[] = [];

  for (const run of runs) {
    const p = toPoint(run);
    if (p) points.push(p);
    else scanOnly.push(run.label);
  }

  const groups = new Map<string, Point[]>();
  for (const p of points) {
    const key = `${p.attempted}:${p.provider ?? "unknown"}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const cohorts: Cohort[] = [...groups.entries()]
    .map(([key, ps]) => {
      const attempted = ps[0]!.attempted;
      return {
        key,
        attempted,
        provider: ps[0]!.provider,
        points: ps,
        resolutionPp: 100 / attempted,
        measuredNoisePp: measuredNoise(ps),
      };
    })
    // 표본이 큰 코호트가 더 믿을 만하다. 위에 둔다.
    .sort((a, b) => b.attempted - a.attempted || b.points.length - a.points.length);

  return { cohorts, totalRuns: runs.length, scanOnly };
}

/**
 * 반복 측정에서 관측된 폭.
 *
 * 관측이 3회 미만이면 폭을 말하지 않는다. 두 점의 차이는 흔들림일 수도
 * 효과일 수도 있고, 그걸 구분하려고 반복하는 것이다.
 */
function measuredNoise(points: Point[]): number | undefined {
  const repeats = points.filter((p) => /run\d+$/.test(p.label));
  if (repeats.length < 3) return undefined;
  const rates = repeats.map((p) => p.acceptRate);
  return Math.max(...rates) - Math.min(...rates);
}

/** 어떤 변화가 판정 가능한가. 잡음 폭을 모르면 최소 눈금으로 대신한다. */
export function isDetectable(deltaPp: number, cohort: Cohort): boolean {
  const floor = cohort.measuredNoisePp ?? cohort.resolutionPp;
  return Math.abs(deltaPp) > floor;
}
