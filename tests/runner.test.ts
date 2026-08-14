import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTestCommand } from "../src/runner.js";
import {
  findSiblingTest,
  generatedTestPath,
  removeGeneratedTest,
  writeGeneratedTest,
} from "../src/testfile.js";

describe("buildTestCommand", () => {
  it("vitest는 watch를 피하려 run을 붙인다", () => {
    expect(buildTestCommand("vitest")).toEqual({
      cmd: "npx",
      args: ["--no-install", "vitest", "run"],
    });
  });

  it("jest는 run을 붙이지 않는다", () => {
    expect(buildTestCommand("jest").args).toEqual(["--no-install", "jest"]);
  });

  it("설정 파일과 테스트 파일을 함께 넘긴다", () => {
    expect(
      buildTestCommand("vitest", { configFile: "v.mut.ts", testFile: "tests/a.test.ts" })
        .args,
    ).toEqual([
      "--no-install",
      "vitest",
      "run",
      "--config",
      "v.mut.ts",
      "tests/a.test.ts",
    ]);
  });

  it("항상 --no-install로 조용한 다운로드를 막는다", () => {
    expect(buildTestCommand("jest").args[0]).toBe("--no-install");
  });
});

describe("findSiblingTest / generatedTestPath", () => {
  function repo() {
    const root = mkdtempSync(join(tmpdir(), "mh-repo-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "guard.ts"), "export const x = 1;");
    return root;
  }

  it("대상 소스를 가장 많이 참조하는 테스트를 고른다", () => {
    const root = repo();
    writeFileSync(join(root, "tests", "other.test.ts"), "guard");
    writeFileSync(
      join(root, "tests", "guard.test.ts"),
      "import { guard } from '@/lib/guard'; guard(); guard();",
    );
    expect(findSiblingTest(root, "lib/guard.ts")).toBe(join("tests", "guard.test.ts"));
  });

  it("참조하는 테스트가 없으면 찾지 못한다", () => {
    const root = repo();
    writeFileSync(join(root, "tests", "other.test.ts"), "관계없는 내용");
    expect(findSiblingTest(root, "lib/guard.ts")).toBeUndefined();
  });

  it("테스트가 아닌 파일은 후보로 보지 않는다", () => {
    const root = repo();
    writeFileSync(join(root, "tests", "helper.ts"), "guard guard guard");
    expect(findSiblingTest(root, "lib/guard.ts")).toBeUndefined();
  });

  it("형제 테스트를 찾으면 그 옆에 생성 경로를 잡는다", () => {
    const root = repo();
    expect(
      generatedTestPath(root, "lib/guard.ts", "m1", join("tests", "guard.test.ts")),
    ).toBe(join("tests", "guard.mh-m1.test.ts"));
  });

  it("형제가 없으면 관례적인 테스트 디렉터리를 쓴다", () => {
    const root = repo();
    expect(generatedTestPath(root, "lib/guard.ts", "m1")).toBe(
      join("tests", "guard.mh-m1.test.ts"),
    );
  });

  it("경로에 쓸 수 없는 뮤턴트 id를 안전하게 바꾼다", () => {
    const root = repo();
    expect(generatedTestPath(root, "lib/guard.ts", "a/b:c")).toContain("mh-a_b_c");
  });

  it("생성 테스트를 쓰고 지운다", () => {
    const root = repo();
    const rel = join("tests", "tmp.mh-x.test.ts");
    writeGeneratedTest(root, rel, "// x");
    removeGeneratedTest(root, rel);
    // 없는 파일을 다시 지워도 실패하지 않아야 한다 (finally에서 두 번 불릴 수 있다).
    expect(() => removeGeneratedTest(root, rel)).not.toThrow();
  });
});
