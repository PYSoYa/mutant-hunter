import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileCache, openCache } from "./cache.js";
import { isMutableSource, parseUnifiedDiff } from "./diff.js";
import {
  equivalentsPath,
  loadRecord,
  recordNotKilled,
  saveRecord,
  suspectedKeys,
} from "./equivalents.js";
import { generateKillingTest, summarize, type GenerationResult } from "./generate.js";
import type { LLMProvider } from "./llm/provider.js";
import { scanReport } from "./mutants.js";
import { detectTestRunner, ensureStryker, runStryker, WORK_DIR } from "./stryker.js";
import { createProject, resolveMutateRanges, toStrykerMutateArgs } from "./targets.js";
import type { MutantScanResult, MutateRange } from "./types.js";

export type PipelineOptions = {
  repoRoot: string;
  /** unified=0 형식의 diff */
  diff: string;
  provider?: LLMProvider;
  runnerConfig?: string;
  concurrency?: number;
  /** 한 번에 다룰 뮤턴트 수. 코멘트가 5개를 넘으면 사람은 전부 무시한다. */
  maxMutants?: number;
  maxAttempts?: number;
  /**
   * 생성 결과 캐시 사용 여부 (기본 true).
   *
   * 잡음 폭 측정처럼 독립 표본이 필요할 때는 꺼야 한다.
   * 캐시가 켜져 있으면 같은 조건이 항상 같은 결과를 내므로 흔들림이 0이 된다.
   */
  cache?: boolean;
  log?: (message: string) => void;
};

export type PipelineResult = {
  status: "no-changes" | "no-ranges" | "stryker-failed" | "scanned" | "generated";
  ranges: MutateRange[];
  scan?: MutantScanResult;
  results?: GenerationResult[];
  summary?: ReturnType<typeof summarize>;
  error?: string;
};

/**
 * diff → 뮤테이션 범위 → 생존 뮤턴트 → (선택) 테스트 생성·검증.
 *
 * CLI와 GitHub Action이 공유하는 단일 경로다. 둘 중 하나에만 있는 동작이
 * 생기면 "로컬에서는 되는데 CI에서는 안 되는" 차이가 자란다.
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { repoRoot, diff, provider } = opts;
  const log = opts.log ?? (() => {});

  const changed = parseUnifiedDiff(diff).filter((f) => isMutableSource(f.path));
  if (changed.length === 0) {
    return { status: "no-changes", ranges: [] };
  }

  const project = createProject(tsconfigOf(repoRoot));
  const ranges: MutateRange[] = [];
  for (const file of changed) {
    const abs = join(repoRoot, file.path);
    if (!existsSync(abs)) continue;
    ranges.push(...resolveMutateRanges(project, abs, file.path, file.changedLines));
  }

  if (ranges.length === 0) {
    return { status: "no-ranges", ranges: [] };
  }

  log(`대상 범위 ${ranges.length}개:`);
  for (const r of ranges) log(`  ${r.path}:${r.start}-${r.end}  (${r.symbol})`);

  const testRunner = detectTestRunner(repoRoot);
  const ensured = await ensureStryker(repoRoot, testRunner);
  if (ensured.installed) {
    log(`Stryker 런타임 설치 (--no-save): ${ensured.packages.join(", ")}`);
  }

  const strykerResult = await runStryker({
    repoRoot,
    mutate: toStrykerMutateArgs(ranges),
    testRunner,
    runnerConfigFile: opts.runnerConfig,
    concurrency: opts.concurrency,
  });

  if (!strykerResult.ok) {
    return {
      status: "stryker-failed",
      ranges,
      error: `Stryker 실행 실패 (exit ${strykerResult.exitCode})\n${strykerResult.stderr.slice(-2000)}`,
    };
  }

  const eqPath = equivalentsPath(repoRoot, WORK_DIR);
  const eqRecord = loadRecord(eqPath);
  const scan = scanReport(strykerResult.report, {
    suspectedEquivalents: suspectedKeys(eqRecord),
  });

  const { stats } = scan;
  log(
    `뮤테이션 스코어 ${stats.mutationScore.toFixed(2)}%  ` +
      `(전체 ${stats.total} / 킬 ${stats.killed} / 생존 ${stats.survived} / ` +
      `커버리지없음 ${stats.noCoverage} / 타임아웃 ${stats.timeout})`,
  );
  log(`후보 뮤턴트 ${scan.candidates.length}개`);

  // 무엇을 왜 버렸는지 침묵하지 않는다. "다 훑었다"는 착시를 막는다.
  for (const [reason, n] of countBy(scan.filtered.map((f) => f.reason))) {
    log(`  제외 ${reason}: ${n}개`);
  }

  writeWorkFile(repoRoot, "candidates.json", scan);

  if (!provider) {
    return { status: "scanned", ranges, scan };
  }

  const targets = scan.candidates.slice(0, opts.maxMutants ?? 5);
  if (targets.length < scan.candidates.length) {
    log(`후보 ${scan.candidates.length}개 중 상위 ${targets.length}개만 처리합니다.`);
  }

  const cache = openCache(repoRoot, WORK_DIR, opts.cache !== false);
  log(
    `테스트 생성 시작 (provider=${provider.name}` +
      `${opts.cache === false ? ", 캐시 없음" : ""})`,
  );
  const results: GenerationResult[] = [];

  for (const mutant of targets) {
    const r = await generateKillingTest(mutant, {
      repoRoot,
      runner: testRunner,
      provider,
      configFile: opts.runnerConfig,
      maxAttempts: opts.maxAttempts ?? 2,
      cache,
    });
    results.push(r);

    const label = `[${mutant.mutatorName}] ${mutant.path}:${mutant.line}`;
    if (r.accepted) {
      log(`  ✅ ${label} — ${r.attempts.length}회 시도만에 채택`);
    } else {
      const why = r.error ?? r.attempts[r.attempts.length - 1]?.rejectedAt ?? "unknown";
      log(`  ❌ ${label} — 폐기 (${why})`);
    }
  }

  if (cache instanceof FileCache) cache.flush();

  // 끝내 못 죽인 뮤턴트를 기록해 다음 실행에서 건너뛴다.
  // 이 파일은 원래 읽히기만 하고 아무도 쓰지 않았다.
  saveRecord(eqPath, recordNotKilled(eqRecord, results));

  const summary = { ...summarize(results), cacheHits: cache.hits };
  const apiCalls = summary.totalAttempts - summary.cacheHits;
  log(
    `채택 ${summary.accepted}/${summary.total} ` +
      `(생성 시도 ${summary.totalAttempts}회, API 호출 ${apiCalls}회` +
      `${summary.cacheHits > 0 ? `, 캐시 적중 ${summary.cacheHits}회` : ""})`,
  );
  for (const [reason, n] of Object.entries(summary.rejectedBy)) {
    log(`  폐기 ${reason}: ${n}개`);
  }

  writeWorkFile(repoRoot, "generated.json", { results, summary });

  return { status: "generated", ranges, scan, results, summary };
}

export function countBy(items: string[]): [string, number][] {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return [...map.entries()];
}

function writeWorkFile(repoRoot: string, name: string, data: unknown): void {
  const dir = join(repoRoot, WORK_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
}

function tsconfigOf(repoRoot: string): string | undefined {
  const p = join(repoRoot, "tsconfig.json");
  return existsSync(p) ? p : undefined;
}
