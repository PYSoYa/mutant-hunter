import { dedupeKey, explainMutant, oneLine } from "./explain.js";
import type { GenerationResult } from "./generate.js";
import { countBy } from "./pipeline.js";
import type { PipelineResult } from "./pipeline.js";

/**
 * 우리가 단 코멘트를 다시 찾기 위한 표식.
 * 커밋이 추가될 때마다 새 코멘트를 달면 알림 피로로 도구가 죽는다.
 */
export const COMMENT_MARKER = "<!-- mutant-hunter -->";

/** GitHub 코멘트 본문 상한(65536자)보다 넉넉히 아래에서 자른다. */
const MAX_BODY = 60_000;

export function renderReport(result: PipelineResult): string {
  const head = [COMMENT_MARKER, "## 🧬 MutantHunter", ""];

  switch (result.status) {
    case "no-changes":
      return [...head, "뮤테이션 대상 소스 변경이 없습니다."].join("\n");
    case "no-ranges":
      return [...head, "변경된 줄을 감싸는 뮤테이션 범위를 찾지 못했습니다."].join("\n");
    case "stryker-failed":
      return [
        ...head,
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
  if (!scan) return [...head, "결과가 없습니다."].join("\n");

  const accepted = dedupe(result.results ?? []);
  const lines = [...head, summaryLine(result, accepted.length), ""];

  if (result.status === "scanned") {
    lines.push("테스트 생성은 실행하지 않았습니다.", "");
  } else if (accepted.length === 0) {
    lines.push(
      "### 제안할 테스트가 없습니다",
      "",
      "생성한 테스트가 모두 검증을 통과하지 못했습니다.",
      "**증명하지 못한 것은 제안하지 않습니다.**",
      "",
    );
  } else {
    lines.push(...renderSuggestions(accepted));
  }

  lines.push(...renderAppendix(result, scan));

  return cap(lines.join("\n"));
}

function summaryLine(result: PipelineResult, acceptedCount: number): string {
  const scan = result.scan;
  const gaps = scan?.candidates.length ?? 0;
  const files = new Set(result.ranges.map((r) => r.path)).size;

  const found =
    `변경된 코드 ${files}개 파일에서 **테스트가 지키지 않는 지점 ${gaps}곳**을 찾았습니다.`;

  if (result.status === "scanned") return found;
  if (acceptedCount === 0) return found;

  return `${found}\n\n그중 **${acceptedCount}곳**은 구멍을 막는 테스트를 만들어 ` +
    `실제로 결함을 잡는지 확인했습니다.`;
}

/**
 * 같은 줄의 같은 종류 뮤턴트는 사람 눈에 같은 지적이다.
 * (한 줄에 옵셔널 체이닝이 셋이면 뮤턴트도 셋이 나온다)
 */
function dedupe(results: GenerationResult[]): GenerationResult[] {
  const seen = new Set<string>();
  const out: GenerationResult[] = [];
  for (const r of results) {
    if (!r.accepted) continue;
    const key = dedupeKey(r.mutant);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function renderSuggestions(accepted: GenerationResult[]): string[] {
  const lines = ["### 제안", ""];

  // 파일별로 묶어야 리뷰어가 한 파일씩 훑을 수 있다.
  const byFile = new Map<string, GenerationResult[]>();
  for (const r of accepted) {
    const list = byFile.get(r.mutant.path) ?? [];
    list.push(r);
    byFile.set(r.mutant.path, list);
  }

  for (const [path, items] of byFile) {
    lines.push(`#### \`${path}\``, "");
    for (const r of items) {
      const m = r.mutant;
      lines.push(
        `**L${m.line}** — ${explainMutant(m)}`,
        "",
        "```ts",
        oneLine(m.original, 200),
        "```",
        "",
        `<details><summary>이 구멍을 막는 테스트 — ${lineCount(r.testSource)}줄 (검증 완료)</summary>`,
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

  return lines;
}

function renderAppendix(
  result: PipelineResult,
  scan: NonNullable<PipelineResult["scan"]>,
): string[] {
  const s = scan.stats;
  const lines = [
    "---",
    "",
    "<details><summary>검증 요약</summary>",
    "",
    `변경 범위의 뮤테이션 스코어 **${s.mutationScore.toFixed(1)}%** ` +
      `— 뮤턴트 ${s.total}개 중 ${s.killed}개를 기존 테스트가 잡았습니다.`,
    "",
  ];

  const summary = result.summary;
  if (summary) {
    const gate = Object.entries(summary.gateRejections ?? {});
    const total = gate.reduce((a, [, n]) => a + n, 0);
    lines.push(
      `생성한 테스트 중 **${total}건**을 검증에서 걸러냈습니다.`,
      "증명하지 못한 것은 제안하지 않습니다.",
      "",
    );
    if (gate.length > 0) {
      lines.push(
        "| 검증 항목 | 폐기 |",
        "|---|---|",
        ...gate
          .sort((x, y) => y[1] - x[1])
          .map(([g, n]) => `| ${gateLabel(g)} | ${n} |`),
        "",
      );
    }
  }

  // 무엇을 왜 뺐는지 항상 밝힌다. 조용한 절삭은 "다 훑었다"는 착시를 만든다.
  const filtered = countBy(scan.filtered.map((f) => f.reason));
  if (filtered.length > 0) {
    lines.push(
      "검사 대상에서 제외한 뮤턴트:",
      "",
      ...filtered.map(([reason, n]) => `- ${filterLabel(reason)}: ${n}개`),
      "",
    );
  }

  lines.push("</details>");
  return lines;
}

function gateLabel(gate: string): string {
  switch (gate) {
    case "parses":
      return "문법이 올바른가";
    case "passes-on-original":
      return "현재 코드에서 통과하는가";
    case "kills-mutant":
      return "결함을 실제로 잡는가";
    case "stable":
      return "반복 실행해도 같은가";
    case "suite-intact":
      return "기존 테스트를 깨지 않는가";
    default:
      return gate;
  }
}

function filterLabel(reason: string): string {
  switch (reason) {
    case "noise-string-literal":
      return "문자열 상수 변형 (테스트로 고정하면 유해)";
    case "suspected-equivalent":
      return "동작이 같아 죽일 수 없는 변형";
    case "no-coverage":
      return "테스트가 아예 없는 지점 (별도 문제)";
    default:
      return reason;
  }
}

function lineCount(source: string | undefined): number {
  return source ? source.split("\n").length : 0;
}

/** 상한을 넘으면 자르되, 잘랐다는 사실을 반드시 남긴다. */
function cap(body: string): string {
  if (body.length <= MAX_BODY) return body;
  const notice =
    "\n\n---\n\n⚠️ 내용이 길어 일부를 생략했습니다. " +
    "전체 결과는 워크플로우 실행의 job summary에 있습니다.";
  return body.slice(0, MAX_BODY - notice.length) + notice;
}
