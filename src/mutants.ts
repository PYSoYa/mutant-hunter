import type { FilterReason, Mutant, MutantScanResult } from "./types.js";

/** mutation-testing-report-schema v1 중 우리가 쓰는 부분만. */
type RawReport = {
  files: Record<
    string,
    {
      source: string;
      mutants: {
        id: string;
        mutatorName: string;
        replacement?: string;
        status: string;
        location: {
          start: { line: number; column: number };
          end: { line: number; column: number };
        };
      }[];
    }
  >;
};

/**
 * 1주차 스파이크 결과: 생존 뮤턴트 36개 중 12개(33%)가 StringLiteral이었고
 * 대부분 LLM 프롬프트 텍스트였다. 프롬프트 문구를 테스트로 고정하는 것은
 * 유해하므로 LLM에 넘기기 전에 잘라내 무료 티어 쿼터를 아낀다.
 */
const NOISE_MUTATORS = new Set(["StringLiteral"]);

export function mutantKey(m: Pick<Mutant, "path" | "mutatorName" | "line" | "column">): string {
  return `${m.path}:${m.mutatorName}:${m.line}:${m.column}`;
}

export function scanReport(
  report: unknown,
  opts: { suspectedEquivalents?: Set<string> } = {},
): MutantScanResult {
  const parsed = report as RawReport;
  const equivalents = opts.suspectedEquivalents ?? new Set<string>();

  const candidates: Mutant[] = [];
  const filtered: { mutant: Mutant; reason: FilterReason }[] = [];
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let timeout = 0;
  let total = 0;

  for (const [path, file] of Object.entries(parsed.files ?? {})) {
    const lines = file.source.split("\n");

    for (const raw of file.mutants) {
      total++;
      switch (raw.status) {
        case "Killed":
          killed++;
          continue;
        case "Timeout":
          timeout++;
          continue;
        case "NoCoverage":
          noCoverage++;
          break;
        case "Survived":
          survived++;
          break;
        default:
          // CompileError, Ignored 등은 갭 신호가 아니다.
          continue;
      }

      const mutant: Mutant = {
        id: raw.id,
        path,
        mutatorName: raw.mutatorName,
        status: raw.status,
        line: raw.location.start.line,
        column: raw.location.start.column,
        endLine: raw.location.end.line,
        endColumn: raw.location.end.column,
        replacement: raw.replacement ?? "",
        original: sliceSource(lines, raw.location),
      };

      const reason = classify(mutant, equivalents);
      if (reason) filtered.push({ mutant, reason });
      else candidates.push(mutant);
    }
  }

  const scored = killed + timeout + survived + noCoverage;

  return {
    candidates,
    filtered,
    stats: {
      total,
      killed,
      survived,
      noCoverage,
      timeout,
      mutationScore: scored === 0 ? 100 : ((killed + timeout) / scored) * 100,
    },
  };
}

function classify(m: Mutant, equivalents: Set<string>): FilterReason | null {
  if (NOISE_MUTATORS.has(m.mutatorName)) return "noise-string-literal";
  if (equivalents.has(mutantKey(m))) return "suspected-equivalent";
  // 커버리지 0은 "테스트가 약하다"가 아니라 "테스트가 없다"는 다른 문제다.
  // 뮤턴트를 죽이는 테스트보다 먼저 기본 테스트가 필요하므로 분리해 보고한다.
  if (m.status === "NoCoverage") return "no-coverage";
  return null;
}

function sliceSource(
  lines: string[],
  loc: { start: { line: number; column: number }; end: { line: number; column: number } },
): string {
  const { start, end } = loc;
  if (start.line === end.line) {
    return (lines[start.line - 1] ?? "").slice(start.column - 1, end.column - 1);
  }
  const first = (lines[start.line - 1] ?? "").slice(start.column - 1);
  const middle = lines.slice(start.line, end.line - 1);
  const last = (lines[end.line - 1] ?? "").slice(0, end.column - 1);
  return [first, ...middle, last].join("\n");
}
