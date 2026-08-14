import type { Comparison, EvalRun } from "./metrics.js";

export function renderEvalReport(run: EvalRun, comparison?: Comparison): string {
  const a = run.aggregate;
  const lines: string[] = [
    `# 평가 결과 — ${run.label}`,
    "",
    `표본 ${a.entries}개 / 뮤턴트 ${a.totalMutants}개 / ${(a.totalDurationMs / 1000).toFixed(1)}초`,
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
      `| LLM 호출 | ${a.llmCalls}회 |`,
    );
  } else {
    lines.push("", "> 생성 단계를 실행하지 않았습니다 (API 키 없음).");
  }

  const rejected = Object.entries(a.rejectedBy ?? {});
  if (rejected.length > 0) {
    lines.push(
      "",
      "## 폐기 사유",
      "",
      "게이트가 무엇을 얼마나 걸러냈는지. 이 숫자가 곧 안전망의 크기다.",
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
