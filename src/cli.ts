import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMutableSource, parseUnifiedDiff } from "./diff.js";
import { mutantKey, scanReport } from "./mutants.js";
import { detectTestRunner, ensureStryker, runStryker, WORK_DIR } from "./stryker.js";
import { createProject, resolveMutateRanges, toStrykerMutateArgs } from "./targets.js";
import type { MutateRange } from "./types.js";

type Args = {
  repo: string;
  base?: string;
  head?: string;
  diffFile?: string;
  runnerConfig?: string;
  concurrency?: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(args.repo);

  const diff = args.diffFile
    ? readFileSync(resolvePath(args.diffFile), "utf8")
    : gitDiff(repoRoot, args.base ?? "HEAD~1", args.head ?? "HEAD");

  const changed = parseUnifiedDiff(diff).filter((f) => isMutableSource(f.path));
  if (changed.length === 0) {
    console.log("뮤테이션 대상 소스 변경이 없습니다.");
    return;
  }

  const project = createProject(tsconfigOf(repoRoot));
  const ranges: MutateRange[] = [];
  for (const file of changed) {
    const abs = join(repoRoot, file.path);
    if (!existsSync(abs)) continue;
    ranges.push(...resolveMutateRanges(project, abs, file.path, file.changedLines));
  }

  if (ranges.length === 0) {
    console.log("변경된 줄을 감싸는 뮤테이션 범위를 찾지 못했습니다.");
    return;
  }

  const mutate = toStrykerMutateArgs(ranges);
  console.log(`대상 범위 ${ranges.length}개:`);
  for (const r of ranges) console.log(`  ${r.path}:${r.start}-${r.end}  (${r.symbol})`);

  const testRunner = detectTestRunner(repoRoot);
  const ensured = await ensureStryker(repoRoot, testRunner);
  if (ensured.installed) {
    console.log(`\nStryker 런타임 설치 (--no-save): ${ensured.packages.join(", ")}`);
  }

  const result = await runStryker({
    repoRoot,
    mutate,
    testRunner,
    runnerConfigFile: args.runnerConfig,
    concurrency: args.concurrency,
  });

  if (!result.ok) {
    console.error(`Stryker 실행 실패 (exit ${result.exitCode})`);
    console.error(result.stderr.slice(-2000));
    process.exitCode = 1;
    return;
  }

  const scan = scanReport(result.report, {
    suspectedEquivalents: loadEquivalents(repoRoot),
  });

  const { stats } = scan;
  console.log(
    `\n뮤테이션 스코어 ${stats.mutationScore.toFixed(2)}%  ` +
      `(전체 ${stats.total} / 킬 ${stats.killed} / 생존 ${stats.survived} / ` +
      `커버리지없음 ${stats.noCoverage} / 타임아웃 ${stats.timeout})`,
  );
  console.log(`후보 뮤턴트 ${scan.candidates.length}개`);

  // 무엇을 왜 버렸는지 침묵하지 않는다. "다 훑었다"는 착시를 막는다.
  const byReason = new Map<string, number>();
  for (const f of scan.filtered) {
    byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  }
  for (const [reason, n] of byReason) console.log(`  제외 ${reason}: ${n}개`);

  for (const m of scan.candidates) {
    console.log(`\n  [${m.mutatorName}] ${m.path}:${m.line}`);
    console.log(`    원본: ${oneLine(m.original)}`);
    console.log(`    변이: ${oneLine(m.replacement)}`);
  }

  const outPath = join(repoRoot, WORK_DIR, "candidates.json");
  writeFileSync(outPath, JSON.stringify(scan, null, 2));
  console.log(`\n결과: ${outPath}`);
}

function gitDiff(repoRoot: string, base: string, head: string): string {
  return execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", `${base}...${head}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

/** 등가 뮤턴트 의심 목록. 없으면 빈 집합. */
function loadEquivalents(repoRoot: string): Set<string> {
  const path = join(repoRoot, WORK_DIR, "equivalents.json");
  if (!existsSync(path)) return new Set();
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return new Set(Array.isArray(raw) ? (raw as string[]) : []);
}

function tsconfigOf(repoRoot: string): string | undefined {
  const p = join(repoRoot, "tsconfig.json");
  return existsSync(p) ? p : undefined;
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key?.startsWith("--") || val === undefined) continue;
    out[key.slice(2)] = val;
  }
  if (!out["repo"]) {
    throw new Error(
      "사용법: scan --repo <경로> [--base <ref> --head <ref> | --diff-file <경로>] " +
        "[--runner-config <경로>] [--concurrency <n>]",
    );
  }
  return {
    repo: out["repo"],
    base: out["base"],
    head: out["head"],
    diffFile: out["diff-file"],
    runnerConfig: out["runner-config"],
    concurrency: out["concurrency"] ? Number(out["concurrency"]) : undefined,
  };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

export { mutantKey };
