import { spawn } from "node:child_process";
import type { TestRunner } from "./stryker.js";

export type TestRunOptions = {
  /** 대상 repo 기준 상대 경로. 생략하면 전체 스위트를 돌린다. */
  testFile?: string;
  /** 대상 repo 기준 상대 경로의 러너 설정 파일 */
  configFile?: string;
  /** 실행 상한. 생략하면 기본값. */
  timeoutMs?: number;
};

/**
 * 테스트 실행 상한.
 *
 * LLM 요청에는 타임아웃을 걸어두고 여기는 비워뒀다가, 평가 실행이
 * 한 표본에서 4시간 45분간 멈췄다. 다른 표본은 3~12분이었다.
 * 생성된 테스트가 열린 핸들을 남기거나 무한 대기하면 그대로 매달린다.
 * 남의 CI에서 이러면 잡 시간 예산을 통째로 태운다.
 */
export const DEFAULT_TEST_TIMEOUT_MS = 300_000;

export type RunOutcome = {
  passed: boolean;
  exitCode: number;
  output: string;
  /** 상한을 넘겨 강제 종료됐는가 */
  timedOut: boolean;
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

  const limitMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });

    let output = "";
    let timedOut = false;
    const collect = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM을 무시하는 러너가 있어 잠시 뒤 확실히 죽인다.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, limitMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({
        // 멈춘 실행은 통과가 아니다. 판정 불가는 실패로 다룬다.
        passed: !timedOut && exitCode === 0,
        exitCode,
        output: timedOut
          ? `${output}\n[mutant-hunter] ${limitMs}ms 초과로 강제 종료`
          : output,
        timedOut,
      });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ passed: false, exitCode: 1, output: `${output}\n[mutant-hunter] 실행 실패`, timedOut });
    });
  });
}
