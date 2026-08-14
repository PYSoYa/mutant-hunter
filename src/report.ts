import { countBy } from "./pipeline.js";
import type { PipelineResult } from "./pipeline.js";

/** PR 코멘트와 job summary가 공유하는 마크다운. */
export function renderReport(result: PipelineResult): string {
  const lines: string[] = ["## 🧬 MutantHunter"];

  switch (result.status) {
    case "no-changes":
      return [...lines, "", "뮤테이션 대상 소스 변경이 없습니다."].join("\n");
    case "no-ranges":
      return [...lines, "", "변경된 줄을 감싸는 뮤테이션 범위를 찾지 못했습니다."].join("\n");
    case "stryker-failed":
      return [
        ...lines,
        "",
        "⚠️ 뮤테이션 실행에 실패했습니다.",
        "",
        "```",
        (result.error ?? "").slice(-1500),
        "```",
      ].join("\n");
    default:
      break;
  }

  const scan = result.scan;
  if (!scan) return [...lines, "", "결과가 없습니다."].join("\n");

  const s = scan.stats;
  lines.push(
    "",
    `**뮤테이션 스코어 ${s.mutationScore.toFixed(1)}%** ` +
      `— 뮤턴트 ${s.total}개 중 ${s.killed}개를 기존 테스트가 잡았습니다.`,
    "",
    `| | |`,
    `|---|---|`,
    `| 검사한 범위 | ${result.ranges.length}개 |`,
    `| 살아남은 뮤턴트 | ${s.survived}개 |`,
    `| 커버리지 없음 | ${s.noCoverage}개 |`,
    `| 제안 후보 | ${scan.candidates.length}개 |`,
  );

  // 무엇을 왜 버렸는지 항상 밝힌다. 조용한 절삭은 "다 훑었다"는 착시를 만든다.
  const filtered = countBy(scan.filtered.map((f) => f.reason));
  if (filtered.length > 0) {
    lines.push(
      "",
      "<details><summary>필터로 제외한 뮤턴트</summary>",
      "",
      ...filtered.map(([reason, n]) => `- \`${reason}\`: ${n}개`),
      "",
      "</details>",
    );
  }

  const accepted = (result.results ?? []).filter((r) => r.accepted);

  if (result.status === "scanned") {
    lines.push("", "테스트 생성은 실행하지 않았습니다.");
    return lines.join("\n");
  }

  if (accepted.length === 0) {
    lines.push(
      "",
      "### 제안할 테스트가 없습니다",
      "",
      "생성한 테스트가 모두 검증 게이트를 통과하지 못했습니다. " +
        "증명하지 못한 것은 제안하지 않습니다.",
    );
  } else {
    lines.push("", `### 제안 ${accepted.length}건`, "");
    for (const r of accepted) {
      const m = r.mutant;
      lines.push(
        `<details><summary><code>${m.path}:${m.line}</code> — ${m.mutatorName}</summary>`,
        "",
        `이 코드를 아래처럼 바꿔도 **어떤 테스트도 실패하지 않습니다.**`,
        "",
        "```diff",
        `- ${oneLine(m.original)}`,
        `+ ${oneLine(m.replacement)}`,
        "```",
        "",
        `아래 테스트는 원본에서 통과하고 위 변형에서 실패하는 것을 확인했습니다.`,
        "",
        `\`${r.testFileRel}\``,
        "",
        "```ts",
        r.testSource ?? "",
        "```",
        "",
        "</details>",
        "",
      );
    }
  }

  const summary = result.summary;
  if (summary) {
    const rejected = Object.entries(summary.rejectedBy);
    lines.push(
      "",
      `<sub>뮤턴트 ${summary.total}개에 대해 LLM 호출 ${summary.totalAttempts}회, ` +
        `${summary.accepted}건 채택` +
        (rejected.length
          ? `, 폐기 ${rejected.map(([k, n]) => `${k} ${n}`).join(" / ")}`
          : "") +
        ".</sub>",
    );
  }

  return lines.join("\n");
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}
