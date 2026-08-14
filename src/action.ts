import { execFileSync } from "node:child_process";
import {
  getBooleanInput,
  getInput,
  getNumberInput,
  postPullRequestComment,
  readPullRequestContext,
  setOutput,
  splitRepo,
  writeStepSummary,
} from "./github.js";
import { providerFromEnv } from "./llm/index.js";
import { runPipeline } from "./pipeline.js";
import { renderReport } from "./report.js";

async function run(): Promise<void> {
  const env = process.env;
  const repoRoot = env["GITHUB_WORKSPACE"] ?? process.cwd();
  const pr = readPullRequestContext(env);

  const base = getInput("base") || pr.baseSha;
  const head = getInput("head") || pr.headSha || "HEAD";

  if (!base) {
    // PR 이벤트가 아니면 비교 기준이 없다. 실패가 아니라 할 일이 없는 것이다.
    console.log("base를 알 수 없습니다 (pull_request 이벤트가 아닌 듯). 건너뜁니다.");
    return;
  }

  const diff = gitDiff(repoRoot, base, head);
  const wantGenerate = getBooleanInput("generate");
  const provider = wantGenerate ? providerFromEnv() : undefined;

  if (wantGenerate && !provider) {
    console.log(
      "API 키가 없어 스캔만 수행합니다 " +
        "(MH_API_KEY 또는 GEMINI_API_KEY 를 설정하세요).",
    );
  }

  const result = await runPipeline({
    repoRoot,
    diff,
    provider,
    runnerConfig: getInput("runner-config") || undefined,
    concurrency: getNumberInput("concurrency"),
    maxMutants: getNumberInput("max-mutants"),
    maxAttempts: getNumberInput("max-attempts"),
    log: (m) => console.log(m),
  });

  const report = renderReport(result);
  writeStepSummary(report, env);

  setOutput("status", result.status, env);
  setOutput("candidates", String(result.scan?.candidates.length ?? 0), env);
  setOutput("accepted", String(result.summary?.accepted ?? 0), env);
  setOutput(
    "mutation-score",
    (result.scan?.stats.mutationScore ?? 0).toFixed(2),
    env,
  );

  await maybeComment(report, result.status, env, pr.number);

  // 뮤테이션 결과로 PR을 막지 않는다. 이 도구는 조언이지 게이트가 아니다.
  // 내부 오류만 실패로 올린다.
  if (result.status === "stryker-failed") {
    console.error(result.error);
    process.exitCode = 1;
  }
}

async function maybeComment(
  body: string,
  status: string,
  env: NodeJS.ProcessEnv,
  prNumber?: number,
): Promise<void> {
  const token = getInput("github-token", env);
  if (!token || !prNumber) return;

  // 할 말이 없을 때는 코멘트를 달지 않는다. 알림 피로가 도구를 죽인다.
  if (status === "no-changes" || status === "no-ranges") return;

  const repo = splitRepo(env["GITHUB_REPOSITORY"] ?? "");
  if (!repo) return;

  const res = await postPullRequestComment({
    token,
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
    body,
  });

  if (!res.ok) {
    // 코멘트 실패가 잡을 죽일 이유는 없다. 결과는 job summary에 이미 있다.
    console.log(`PR 코멘트 실패 (${res.status}): ${res.detail ?? ""}`);
  }
}

function gitDiff(repoRoot: string, base: string, head: string): string {
  return execFileSync(
    "git",
    ["diff", "--unified=0", "--no-color", `${base}...${head}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
