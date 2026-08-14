import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { providerFromEnv } from "./llm/index.js";
import { runPipeline } from "./pipeline.js";
import { WORK_DIR } from "./stryker.js";

type Args = {
  repo: string;
  base?: string;
  head?: string;
  diffFile?: string;
  runnerConfig?: string;
  concurrency?: number;
  generate: boolean;
  cache: boolean;
  maxMutants?: number;
  maxAttempts?: number;
};

const USAGE =
  "사용법: scan --repo <경로> [--base <ref> --head <ref> | --diff-file <경로>] " +
  "[--runner-config <경로>] [--concurrency <n>] " +
  "[--generate] [--max-mutants <n>] [--max-attempts <n>] [--no-cache]";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(args.repo);

  const diff = args.diffFile
    ? readFileSync(resolvePath(args.diffFile), "utf8")
    : gitDiff(repoRoot, args.base ?? "HEAD~1", args.head ?? "HEAD");

  let provider;
  if (args.generate) {
    // Action과 같은 팩토리를 쓴다. 진입점마다 provider 선택이 다르면
    // "로컬은 되는데 CI는 안 되는" 차이가 자란다.
    provider = providerFromEnv();
    if (!provider) {
      console.error(
        "API 키가 없어 생성 단계를 건너뜁니다 (MH_API_KEY 또는 GEMINI_API_KEY).",
      );
      process.exitCode = 1;
      return;
    }
  }

  const result = await runPipeline({
    repoRoot,
    diff,
    provider,
    runnerConfig: args.runnerConfig,
    concurrency: args.concurrency,
    maxMutants: args.maxMutants,
    maxAttempts: args.maxAttempts,
    cache: args.cache,
    log: (m) => console.log(m),
  });

  switch (result.status) {
    case "no-changes":
      console.log("뮤테이션 대상 소스 변경이 없습니다.");
      return;
    case "no-ranges":
      console.log("변경된 줄을 감싸는 뮤테이션 범위를 찾지 못했습니다.");
      return;
    case "stryker-failed":
      console.error(result.error);
      process.exitCode = 1;
      return;
    default:
      break;
  }

  console.log(`\n결과: ${join(repoRoot, WORK_DIR)}`);
  if (result.status === "scanned") {
    console.log("테스트 생성을 하려면 --generate 를 붙이세요.");
  }
}

function gitDiff(repoRoot: string, base: string, head: string): string {
  return execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", `${base}...${head}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  const flags = new Set<string>();
  const BOOLEAN_FLAGS = new Set(["generate", "no-cache"]);

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined) continue;
    out[name] = val;
    i++;
  }

  if (!out["repo"]) throw new Error(USAGE);

  return {
    repo: out["repo"],
    base: out["base"],
    head: out["head"],
    diffFile: out["diff-file"],
    runnerConfig: out["runner-config"],
    concurrency: out["concurrency"] ? Number(out["concurrency"]) : undefined,
    generate: flags.has("generate"),
    cache: !flags.has("no-cache"),
    maxMutants: out["max-mutants"] ? Number(out["max-mutants"]) : undefined,
    maxAttempts: out["max-attempts"] ? Number(out["max-attempts"]) : undefined,
  };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
