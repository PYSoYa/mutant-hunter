import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Stryker와 러너 플러그인은 **대상 repo의 node_modules에서 해석돼야 한다.**
 * 뮤테이션을 실행하는 vitest/jest가 대상 repo의 것이어야 하기 때문이다.
 * MutantHunter의 node_modules에 있는 Stryker로 대상을 돌리면 우리 vitest가
 * 대상의 vite 설정을 읽으려다 실패한다 (실측 확인).
 *
 * 그렇다고 대상 repo가 Stryker를 커밋할 필요는 없다. CI에서 `--no-save`로
 * 런타임 설치하면 package.json은 그대로다.
 */
const STRYKER_RANGE = "^9.6.1";

export type TestRunner = "vitest" | "jest";

export type StrykerRunOptions = {
  repoRoot: string;
  /** `path:start-end` 형식의 뮤테이션 범위들 */
  mutate: string[];
  testRunner: TestRunner;
  /** 뮤테이션 전용 테스트 설정 (전체 스위트보다 훨씬 빠르다) */
  runnerConfigFile?: string;
  concurrency?: number;
  timeoutMS?: number;
  /**
   * StringLiteral 변이를 Stryker 단계에서 제외한다.
   * 실행 시간은 줄지만 필터 통계에서 사라지므로 기본값은 false.
   */
  excludeStringLiterals?: boolean;
  /** 러너별 기본값을 덮어쓴다. 대부분 건드릴 필요 없다. */
  disableTypeChecks?: boolean;
};

/** 작업 산출물을 모아두는 디렉터리. 대상 repo의 기존 설정을 건드리지 않는다. */
export const WORK_DIR = ".mutant-hunter";

export function detectTestRunner(repoRoot: string): TestRunner {
  const pkgPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["vitest"]) return "vitest";
  if (deps["jest"]) return "jest";
  throw new Error(
    "지원하는 테스트 러너를 찾지 못했습니다 (vitest 또는 jest 필요)",
  );
}

export function buildStrykerConfig(opts: StrykerRunOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {
    testRunner: opts.testRunner,
    mutate: opts.mutate,
    // perTest여야 뮤턴트를 커버하는 테스트만 돌아간다. 이게 없으면
    // 뮤턴트마다 전체 스위트가 돌아 실행 시간이 수십 배가 된다.
    coverageAnalysis: "perTest",
    reporters: ["json"],
    jsonReporter: { fileName: `${WORK_DIR}/mutation.json` },
    concurrency: opts.concurrency ?? 4,
    timeoutMS: opts.timeoutMS ?? 15_000,
    tempDirName: `${WORK_DIR}/tmp`,
    // 대상 repo에 커밋되지 않도록 증분 캐시도 작업 디렉터리 안에 둔다.
    incremental: false,
    /**
     * 러너에 따라 갈린다. 둘 다 실측으로 확인했다.
     *
     * **vitest → false.** Stryker가 파일 맨 위에 `// @ts-nocheck`를 붙이면
     * 모든 줄 번호가 1씩 밀린다. 줄 번호를 단언하는 테스트가 있으면 초기
     * 실행이 실패해 스캔이 통째로 죽는다 (우리 자신을 대상으로 돌렸을 때
     * 실제로 겪었다). vitest는 esbuild로 변환하며 타입 검사를 하지 않으므로
     * 끄는 편이 안전하다.
     *
     * **jest → true.** ts-jest는 **계측된 코드까지 타입 검사한다.** Stryker의
     * 헬퍼(`stryMutAct_9fa48("12")`)가 `TS2554: Expected 0 arguments`로
     * 터져서 초기 실행이 실패한다. 여기서는 켜야 한다.
     *
     * "vitest 또는 jest 지원"이라고 문서에 써놓고 jest를 한 번도 돌려보지
     * 않아서 이 차이를 몰랐다.
     */
    disableTypeChecks: opts.disableTypeChecks ?? opts.testRunner === "jest",
  };

  if (opts.excludeStringLiterals) {
    config["mutator"] = { excludedMutations: ["StringLiteral"] };
  }

  if (opts.runnerConfigFile) {
    config[opts.testRunner] = { configFile: opts.runnerConfigFile };
  }

  return config;
}

/** 대상 repo의 node_modules에서 패키지가 해석되는지 확인한다. */
export function resolvesFrom(repoRoot: string, pkg: string): boolean {
  try {
    createRequire(join(repoRoot, "package.json")).resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}

export type EnsureResult = { installed: boolean; packages: string[] };

/**
 * Stryker와 러너 플러그인이 대상 repo에 없으면 `--no-save`로 설치한다.
 * package.json / lock 파일은 건드리지 않는다 — CI에서는 체크아웃이 어차피
 * 일회용이고, 로컬에서는 대상 repo를 오염시키지 않아야 한다.
 */
export async function ensureStryker(
  repoRoot: string,
  testRunner: TestRunner,
): Promise<EnsureResult> {
  const needed = [
    `@stryker-mutator/core`,
    `@stryker-mutator/${testRunner}-runner`,
  ].filter((pkg) => !resolvesFrom(repoRoot, pkg));

  if (needed.length === 0) return { installed: false, packages: [] };

  const spec = needed.map((pkg) => `${pkg}@${STRYKER_RANGE}`);
  const { code, stderr } = await exec(
    "npm",
    ["install", "--no-save", "--no-audit", "--no-fund", ...spec],
    repoRoot,
  );

  if (code !== 0) {
    throw new Error(`Stryker 런타임 설치 실패:\n${stderr.slice(-1000)}`);
  }

  return { installed: true, packages: needed };
}

export type StrykerResult =
  | { ok: true; report: unknown }
  | { ok: false; exitCode: number; stderr: string };

export async function runStryker(opts: StrykerRunOptions): Promise<StrykerResult> {
  const workDir = join(opts.repoRoot, WORK_DIR);
  mkdirSync(workDir, { recursive: true });

  const configPath = join(workDir, "stryker.conf.json");
  writeFileSync(configPath, JSON.stringify(buildStrykerConfig(opts), null, 2));

  // configFile은 플래그가 아니라 positional 인자다.
  // --no-install: npx가 레지스트리에서 조용히 받아오는 것을 막는다.
  // 설치는 ensureStryker가 명시적으로 책임진다.
  const { code, stderr } = await exec(
    "npx",
    ["--no-install", "stryker", "run", configPath],
    opts.repoRoot,
  );

  // Stryker는 뮤테이션 스코어가 임계치 미만이면 0이 아닌 코드로 끝난다.
  // 리포트가 생성됐다면 성공으로 취급한다 — 점수 판정은 우리 몫이다.
  try {
    const report = JSON.parse(
      readFileSync(join(workDir, "mutation.json"), "utf8"),
    ) as unknown;
    return { ok: true, report };
  } catch {
    return { ok: false, exitCode: code, stderr };
  }
}

function exec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}
