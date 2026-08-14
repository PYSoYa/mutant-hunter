import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeExports } from "../src/exports.js";
import { checkSyntax } from "../src/syntax.js";
import { createProject } from "../src/targets.js";

describe("checkSyntax", () => {
  it("올바른 테스트를 통과시킨다", () => {
    const src = `import { it, expect } from "vitest";
it("x", () => { expect(1).toBe(1); });`;
    expect(checkSyntax(src).ok).toBe(true);
  });

  it("TypeScript 문법을 이해한다", () => {
    const src = `const f = (x: number): string => String(x);
export type T = { a: number };`;
    expect(checkSyntax(src).ok).toBe(true);
  });

  it("괄호가 안 닫히면 잡는다", () => {
    const r = checkSyntax(`it("x", () => { expect(1).toBe(1);`);
    expect(r.ok).toBe(false);
  });

  it("빈 응답을 잡는다", () => {
    expect(checkSyntax("   ").ok).toBe(false);
  });

  it("오류에 줄 번호를 붙인다", () => {
    // 재시도 프롬프트에 넣을 것이므로 위치가 있어야 고칠 수 있다.
    const r = checkSyntax("const a = 1;\nfunction ( {");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/L\d+:\d+/);
  });

  it("타입 오류는 문법 오류로 보지 않는다", () => {
    // import가 대상 repo에서 해석되는지는 여기서 알 수 없다.
    // 타입 오류를 문법 오류로 보고하면 멀쩡한 테스트를 버리게 된다.
    const src = `import { 없는함수 } from "./어딘가.js";
const x: number = "문자열";
없는함수();`;
    expect(checkSyntax(src).ok).toBe(true);
  });

  it("남은 마크다운 펜스는 여기서 잡히지 않는다", () => {
    // 백틱 세 개는 템플릿 리터럴로 정상 파싱된다. 문법 검사로는 못 막는다.
    // 펜스 제거는 extractTestSource의 몫이고, 놓치면 다음 게이트가 잡는다.
    expect(checkSyntax("```ts\nconst a = 1;\n```").ok).toBe(true);
  });
});

describe("describeExports", () => {
  function moduleWith(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mh-exp-"));
    const path = join(dir, "m.ts");
    writeFileSync(path, source);
    return path;
  }

  it("함수의 이름과 시그니처를 낸다", () => {
    const out = describeExports(
      createProject(),
      moduleWith(`export function add(a: number, b: number): number { return a + b; }`),
    );
    expect(out).toContain("add:");
    expect(out).toContain("number");
  });

  it("선택 매개변수를 표시한다", () => {
    const out = describeExports(
      createProject(),
      moduleWith(`export function f(a: string, b?: number): void {}`),
    );
    expect(out).toContain("b?:");
  });

  it("내보내지 않은 것은 넣지 않는다", () => {
    // 없는 API를 알려주는 것만큼이나 숨은 API를 알려주는 것도 해롭다.
    const out = describeExports(
      createProject(),
      moduleWith(`function 내부용() {}\nexport function 공개() {}`),
    );
    expect(out).toContain("공개");
    expect(out).not.toContain("내부용");
  });

  it("클래스의 공개 메서드를 나열한다", () => {
    const out = describeExports(
      createProject(),
      moduleWith(`export class C { run(): void {} private 숨김(): void {} }`),
    );
    expect(out).toContain("run");
    expect(out).not.toContain("숨김");
  });

  it("타입 별칭도 목록에 넣는다", () => {
    const out = describeExports(
      createProject(),
      moduleWith(`export type T = { a: number };`),
    );
    expect(out).toContain("T:");
  });

  it("읽을 수 없는 경로에서 죽지 않는다", () => {
    expect(describeExports(createProject(), "/없는/경로.ts")).toBe("");
  });

  it("목록이 길면 자른다", () => {
    const many = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const out = describeExports(createProject(), moduleWith(many), 5);
    expect(out.split("\n")).toHaveLength(5);
  });
});
