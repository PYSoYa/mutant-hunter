import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getBooleanInput,
  getInput,
  getNumberInput,
  readPullRequestContext,
  setOutput,
  splitRepo,
  writeStepSummary,
} from "../src/github.js";

const tmpFile = (name: string, content = "") => {
  const dir = mkdtempSync(join(tmpdir(), "mh-gh-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("getInput", () => {
  it("언더스코어 형태를 읽는다", () => {
    expect(getInput("max-mutants", { INPUT_MAX_MUTANTS: "7" })).toBe("7");
  });

  it("하이픈 형태도 읽는다 (node 액션 호환)", () => {
    expect(getInput("max-mutants", { "INPUT_MAX-MUTANTS": "7" })).toBe("7");
  });

  it("언더스코어 형태를 우선한다", () => {
    expect(
      getInput("max-mutants", { INPUT_MAX_MUTANTS: "7", "INPUT_MAX-MUTANTS": "9" }),
    ).toBe("7");
  });

  it("공백을 언더스코어로 바꾼다", () => {
    expect(getInput("my input", { INPUT_MY_INPUT: "x" })).toBe("x");
  });

  it("앞뒤 공백을 제거한다", () => {
    expect(getInput("base", { INPUT_BASE: "  main  " })).toBe("main");
  });

  it("없는 입력은 빈 문자열이다", () => {
    expect(getInput("nope", {})).toBe("");
  });
});

describe("getBooleanInput", () => {
  it("true/1/yes를 참으로 본다", () => {
    expect(getBooleanInput("g", { INPUT_G: "true" })).toBe(true);
    expect(getBooleanInput("g", { INPUT_G: "1" })).toBe(true);
    expect(getBooleanInput("g", { INPUT_G: "YES" })).toBe(true);
  });

  it("나머지는 거짓이다", () => {
    expect(getBooleanInput("g", { INPUT_G: "false" })).toBe(false);
    expect(getBooleanInput("g", {})).toBe(false);
  });
});

describe("getNumberInput", () => {
  it("숫자를 파싱한다", () => {
    expect(getNumberInput("n", { INPUT_N: "5" })).toBe(5);
  });

  it("비어 있으면 undefined다", () => {
    expect(getNumberInput("n", {})).toBeUndefined();
  });

  it("숫자가 아니면 undefined다", () => {
    // 잘못된 입력으로 NaN을 하류에 흘려보내면 조용히 이상하게 동작한다.
    expect(getNumberInput("n", { INPUT_N: "abc" })).toBeUndefined();
  });
});

describe("readPullRequestContext", () => {
  it("PR 번호와 base/head SHA를 읽는다", () => {
    const path = tmpFile(
      "event.json",
      JSON.stringify({
        pull_request: { number: 42, base: { sha: "aaa" }, head: { sha: "bbb" } },
      }),
    );
    expect(readPullRequestContext({ GITHUB_EVENT_PATH: path })).toEqual({
      number: 42,
      baseSha: "aaa",
      headSha: "bbb",
    });
  });

  it("pull_request가 없으면 빈 객체다", () => {
    const path = tmpFile("event.json", JSON.stringify({ push: {} }));
    expect(readPullRequestContext({ GITHUB_EVENT_PATH: path })).toEqual({});
  });

  it("페이로드가 깨져도 던지지 않는다", () => {
    const path = tmpFile("event.json", "{ not json");
    expect(readPullRequestContext({ GITHUB_EVENT_PATH: path })).toEqual({});
  });

  it("경로가 없으면 빈 객체다", () => {
    expect(readPullRequestContext({})).toEqual({});
  });
});

describe("setOutput / writeStepSummary", () => {
  it("heredoc 형식으로 출력을 쓴다", () => {
    const path = tmpFile("out.txt");
    setOutput("status", "generated", { GITHUB_OUTPUT: path });
    const written = readFileSync(path, "utf8");
    expect(written).toContain("status<<ghadelimiter_status");
    expect(written).toContain("generated");
  });

  it("여러 줄 값도 안전하게 쓴다", () => {
    const path = tmpFile("out.txt");
    setOutput("body", "첫줄\n둘째줄", { GITHUB_OUTPUT: path });
    expect(readFileSync(path, "utf8")).toContain("첫줄\n둘째줄");
  });

  it("GITHUB_OUTPUT이 없으면 아무것도 하지 않는다", () => {
    expect(() => setOutput("a", "b", {})).not.toThrow();
  });

  it("job summary를 덧붙인다", () => {
    const path = tmpFile("summary.md");
    writeStepSummary("## 제목", { GITHUB_STEP_SUMMARY: path });
    expect(readFileSync(path, "utf8")).toBe("## 제목\n");
  });
});

describe("splitRepo", () => {
  it("owner/repo를 쪼갠다", () => {
    expect(splitRepo("PYSoYa/mutant-hunter")).toEqual({
      owner: "PYSoYa",
      repo: "mutant-hunter",
    });
  });

  it("형식이 아니면 undefined다", () => {
    expect(splitRepo("nope")).toBeUndefined();
    expect(splitRepo("")).toBeUndefined();
  });
});
