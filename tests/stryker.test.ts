import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildStrykerConfig,
  detectTestRunner,
  resolvesFrom,
  WORK_DIR,
} from "../src/stryker.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("detectTestRunner", () => {
  it("vitest를 감지한다", () => {
    expect(detectTestRunner(fixture("repo-vitest"))).toBe("vitest");
  });

  it("jest를 감지한다", () => {
    expect(detectTestRunner(fixture("repo-jest"))).toBe("jest");
  });

  it("지원 러너가 없으면 실패한다", () => {
    expect(() => detectTestRunner(fixture("repo-none"))).toThrow(/vitest 또는 jest/);
  });
});

describe("resolvesFrom", () => {
  it("대상 repo에서 해석되는 패키지를 찾는다", () => {
    expect(resolvesFrom(REPO_ROOT, "ts-morph")).toBe(true);
  });

  it("없는 패키지는 false를 반환한다", () => {
    expect(resolvesFrom(REPO_ROOT, "@stryker-mutator/does-not-exist")).toBe(false);
  });
});

describe("buildStrykerConfig", () => {
  const base = {
    repoRoot: "/tmp/x",
    mutate: ["src/a.ts:3-8"],
    testRunner: "vitest" as const,
  };

  it("뮤테이션 범위와 러너를 설정에 담는다", () => {
    const c = buildStrykerConfig(base);
    expect(c["mutate"]).toEqual(["src/a.ts:3-8"]);
    expect(c["testRunner"]).toBe("vitest");
  });

  it("coverageAnalysis를 perTest로 강제한다", () => {
    // perTest가 아니면 뮤턴트마다 전체 스위트가 돌아 실행 시간이 폭발한다.
    expect(buildStrykerConfig(base)["coverageAnalysis"]).toBe("perTest");
  });

  it("산출물을 작업 디렉터리 안에만 쓴다", () => {
    const c = buildStrykerConfig(base);
    expect(c["jsonReporter"]).toEqual({ fileName: `${WORK_DIR}/mutation.json` });
    expect(c["tempDirName"]).toBe(`${WORK_DIR}/tmp`);
  });

  it("샌드박스에서 타입체크 비활성화를 끈다", () => {
    // Stryker 기본값은 파일 맨 위에 // @ts-nocheck 를 붙여 모든 줄 번호를
    // 1씩 민다. 우리는 뮤턴트를 줄/칸 오프셋으로 적용하므로 치명적이다.
    // 실제로 자기 자신을 대상으로 돌렸을 때 이것 때문에 스캔이 죽었다.
    expect(buildStrykerConfig(base)["disableTypeChecks"]).toBe(false);
  });

  it("러너 설정 파일을 러너 이름 아래에 넣는다", () => {
    const c = buildStrykerConfig({ ...base, runnerConfigFile: "vitest.mut.ts" });
    expect(c["vitest"]).toEqual({ configFile: "vitest.mut.ts" });
  });

  it("StringLiteral 제외는 기본으로 켜지 않는다", () => {
    // 기본값에서 제외해 버리면 필터 통계에서 사라져 무엇을 버렸는지 보고할 수 없다.
    expect(buildStrykerConfig(base)["mutator"]).toBeUndefined();
    expect(
      buildStrykerConfig({ ...base, excludeStringLiterals: true })["mutator"],
    ).toEqual({ excludedMutations: ["StringLiteral"] });
  });
});
