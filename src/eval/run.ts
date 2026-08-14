import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { LLMProvider } from "../llm/provider.js";
import { runPipeline } from "../pipeline.js";
import type { CorpusEntry } from "./corpus.js";
import { aggregate, computeMetrics, type EntryMetrics, type EvalRun } from "./metrics.js";

export type RunEvalOptions = {
  /** 코퍼스 파일이 있는 디렉터리. 상대 경로의 기준점. */
  baseDir: string;
  /** git 표본을 체크아웃할 작업 디렉터리 */
  workDir: string;
  provider?: LLMProvider;
  maxMutants?: number;
  maxAttempts?: number;
  /** 실행 라벨. 하네스는 시계를 직접 읽지 않는다. */
  label: string;
  log?: (message: string) => void;
  /** 경과 시간 측정. 테스트에서 주입 가능하게 열어둔다. */
  now?: () => number;
};

export async function runEval(
  entries: CorpusEntry[],
  opts: RunEvalOptions,
): Promise<EvalRun> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const results: EntryMetrics[] = [];

  for (const entry of entries) {
    log(`\n▶ ${entry.name}`);
    const started = now();

    let repoRoot: string;
    try {
      repoRoot = materialize(entry, opts.baseDir, opts.workDir, log);
    } catch (err) {
      log(`  준비 실패: ${err instanceof Error ? err.message : String(err)}`);
      results.push(
        computeMetrics(entry.name, { status: "no-changes", ranges: [] }, now() - started),
      );
      continue;
    }

    const diff = readDiff(entry, repoRoot, opts.baseDir);

    const result = await runPipeline({
      repoRoot,
      diff,
      provider: opts.provider,
      runnerConfig: entry.runnerConfig,
      maxMutants: opts.maxMutants,
      maxAttempts: opts.maxAttempts,
      log: (m) => log(`  ${m}`),
    });

    results.push(computeMetrics(entry.name, result, now() - started));
  }

  return {
    label: opts.label,
    provider: opts.provider?.name,
    entries: results,
    aggregate: aggregate(results),
  };
}

/** 표본을 디스크에 준비하고 repo 루트 경로를 돌려준다. */
function materialize(
  entry: CorpusEntry,
  baseDir: string,
  workDir: string,
  log: (m: string) => void,
): string {
  if (entry.source.type === "local") {
    const path = resolveFrom(baseDir, entry.source.path);
    if (!existsSync(path)) throw new Error(`경로가 없습니다: ${path}`);
    return path;
  }

  const dest = join(workDir, entry.name);
  mkdirSync(workDir, { recursive: true });

  if (existsSync(join(dest, ".git"))) {
    // 이미 받아둔 표본은 SHA만 맞춰준다.
    git(dest, ["checkout", "--quiet", entry.source.sha]);
    return dest;
  }

  rmSync(dest, { recursive: true, force: true });
  log(`  클론: ${entry.source.url}`);
  git(workDir, ["clone", "--quiet", entry.source.url, entry.name]);
  git(dest, ["checkout", "--quiet", entry.source.sha]);

  log(`  npm ci`);
  execFileSync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: dest,
    stdio: "ignore",
  });

  return dest;
}

function readDiff(entry: CorpusEntry, repoRoot: string, baseDir: string): string {
  if (entry.diff.type === "file") {
    return readFileSync(resolveFrom(baseDir, entry.diff.path), "utf8");
  }
  return execFileSync(
    "git",
    [
      "diff",
      "--unified=0",
      "--no-color",
      `${entry.diff.base}...${entry.diff.head}`,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function resolveFrom(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}
