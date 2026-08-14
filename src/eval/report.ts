import type { Comparison, EvalRun } from "./metrics.js";

export function renderEvalReport(run: EvalRun, comparison?: Comparison): string {
  const a = run.aggregate;
  const lines: string[] = [
    `# 평가 결과 — ${run.label}`,
    "",
    `표본 ${a.entries}개 / 뮤턴트 ${a.totalMutants}개 / ` +
      `${(a.totalDurationMs / 1000).toFixed(1)}초` +
      (run.provider ? ` / provider \`${run.provider}\`` : ""),
    "",
    "| 지표 | 값 |",
    "|---|---|",
    `| 가중 뮤테이션 스코어 | ${a.weightedMutationScore.toFixed(2)}% |`,
    `| 제안 후보 | ${a.totalCandidates}개 |`,
  ];

  if (a.attempted !== undefined) {
    lines.push(
      `| 시도한 뮤턴트 | ${a.attempted}개 |`,
      `| 채택 | ${a.accepted}개 |`,
      `| **채택률** | **${(a.acceptRate ?? 0).toFixed(1)}%** |`,
      `| 생성 시도 | ${a.llmCalls}회 |`,
      `| **API 호출** | **${a.apiCalls ?? a.llmCalls}회**` +
        `${(a.cacheHits ?? 0) > 0 ? ` (캐시 적중 ${a.cacheHits}회)` : ""} |`,
    );
  } else {
    lines.push("", "> 생성 단계를 실행하지 않았습니다 (API 키 없음).");
  }

  const gateRejected = Object.entries(a.gateRejections ?? {});
  if (gateRejected.length > 0) {
    const total = a.totalGateRejections ?? 0;
    lines.push(
      "",
      "## 게이트가 걸러낸 것",
      "",
      `생성된 테스트 중 **${total}건**이 게이트를 통과하지 못했다. ` +
        `그중 ${a.rescuedByRetry ?? 0}건은 재시도로 살아났다.`,
      "",
      "이 숫자가 안전망의 크기다. 증명하지 못한 것은 제안하지 않는다.",
      "",
      "| 게이트 | 폐기 |",
      "|---|---|",
      ...gateRejected
        .sort((x, y) => y[1] - x[1])
        .map(([reason, n]) => `| \`${reason}\` | ${n} |`),
    );
  }

  const rejected = Object.entries(a.rejectedBy ?? {});
  if (rejected.length > 0) {
    lines.push(
      "",
      "## 최종 폐기 사유",
      "",
      "재시도까지 실패해 제안하지 못한 뮤턴트.",
      "",
      "| 사유 | 건수 |",
      "|---|---|",
      ...rejected
        .sort((x, y) => y[1] - x[1])
        .map(([reason, n]) => `| \`${reason}\` | ${n} |`),
    );
  }

  // 실제로 뮤테이션이 돈 표본과 그냥 건너뛴 표본을 구분한다.
  // "0.0% / 뮤턴트 0개"는 결과처럼 보이지만 아무것도 안 돌았다는 뜻일 수 있다.
  const skipped = run.entries.filter((e) => e.totalMutants === 0);
  if (skipped.length > 0) {
    lines.push(
      "",
      `> ⚠️ 표본 ${skipped.length}개가 뮤테이션 없이 끝났습니다. ` +
        `평균에 0%로 섞이지 않도록 아래 상태를 확인하세요.`,
      "",
      ...skipped.map((e) => `> - \`${e.name}\`: ${describeStatus(e.status)}`),
    );
  }

  lines.push(
    "",
    "## 표본별",
    "",
    "| 표본 | 상태 | 스코어 | 뮤턴트 | 후보 | 채택 | 시간 |",
    "|---|---|---|---|---|---|---|",
    ...run.entries.map(
      (e) =>
        `| ${e.name} | ${e.status} | ` +
        `${e.totalMutants === 0 ? "—" : `${e.mutationScore.toFixed(1)}%`} | ` +
        `${e.totalMutants} | ${e.candidates} | ${e.accepted ?? "-"} | ` +
        `${(e.durationMs / 1000).toFixed(1)}s |`,
    ),
  );

  if (comparison) {
    lines.push("", ...renderComparison(comparison));
  }

  return lines.join("\n");
}

function renderComparison(c: Comparison): string[] {
  const lines = [
    "## 이전 실행과 비교",
    "",
    c.hasRegression ? "⚠️ **회귀가 감지됐습니다.**" : "✅ 회귀 없음.",
    "",
    "| 지표 | 이전 | 이후 | 변화 |",
    "|---|---|---|---|",
    ...c.deltas.map(
      (d) =>
        `| ${d.metric} | ${fmt(d.before)} | ${fmt(d.after)} | ` +
        `${d.delta >= 0 ? "+" : ""}${fmt(d.delta)}${d.regression ? " ⚠️" : ""} |`,
    ),
  ];

  if (c.removed.length > 0) {
    // 어려운 표본을 빼면 점수는 언제든 올라간다. 그걸 개선으로 읽으면 안 된다.
    lines.push(
      "",
      `⚠️ 사라진 표본: ${c.removed.join(", ")}`,
      "",
      "표본이 줄면 점수가 오르기 쉽다. 축소 자체를 회귀로 본다.",
    );
  }
  if (c.providerChanged) {
    // 모델과 프롬프트를 한 번에 바꾸면 무엇이 효과를 냈는지 알 수 없다.
    lines.push(
      "",
      "⚠️ provider가 바뀌었다. 이 비교로는 프롬프트 개선과 모델 교체를 구분할 수 없다.",
    );
  }
  if (c.added.length > 0) {
    lines.push("", `추가된 표본: ${c.added.join(", ")}`);
  }

  return lines;
}

function describeStatus(status: string): string {
  switch (status) {
    case "no-changes":
      return "diff에 뮤테이션 대상 소스 변경이 없음";
    case "no-ranges":
      return "변경된 줄을 감싸는 선언을 찾지 못함";
    case "stryker-failed":
      return "뮤테이션 실행 실패";
    default:
      return status;
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
