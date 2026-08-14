import { spawn } from "node:child_process";
import type { TestRunner } from "./stryker.js";

export type TestRunOptions = {
  /** 대상 repo 기준 상대 경로. 생략하면 전체 스위트를 돌린다. */
  testFile?: string;
  /** 대상 repo 기준 상대 경로의 러너 설정 파일 */
  configFile?: string;
};

export type RunOutcome = {
  passed: boolean;
  exitCode: number;
  output: string;
};

/**
 * 러너 실행 명령을 만든다. spawn과 분리해 두어 인자 조립을 테스트할 수 있다.
 *
 * --no-install: 레지스트리에서 조용히 받아오는 폴백을 막는다. 러너는 대상
 * repo에 이미 설치돼 있어야 하며, 없으면 시끄럽게 실패하는 편이 낫다.
 */
export function buildTestCommand(
  runner: TestRunner,
  opts: TestRunOptions = {},
): { cmd: string; args: string[] } {
  const args = ["--no-install", runner];

  // vitest는 watch가 기본이라 run을 명시해야 한다. jest는 단발 실행이 기본.
  if (runner === "vitest") args.push("run");
  if (opts.configFile) args.push("--config", opts.configFile);
  if (opts.testFile) args.push(opts.testFile);

  return { cmd: "npx", args };
}

export async function runTests(
  repoRoot: string,
  runner: TestRunner,
  opts: TestRunOptions = {},
): Promise<RunOutcome> {
  const { cmd, args } = buildTestCommand(runner, opts);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });

    let output = "";
    const collect = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({ passed: exitCode === 0, exitCode, output });
    });
  });
}
