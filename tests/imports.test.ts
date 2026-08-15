import { describe, expect, it } from "vitest";
import {
  buildImportRequirement,
  extractRunnerImport,
  relativeImportPath,
} from "../src/imports.js";

describe("relativeImportPath", () => {
  it("test/ 에서 src/ 로 올라가는 경로를 만든다", () => {
    // 외부 repo에서 7건 중 6건이 이 경로를 틀려 죽었다.
    expect(relativeImportPath("test/index.mh-1.test.ts", "src/index.ts")).toBe(
      "../src/index",
    );
  });

  it("같은 디렉터리면 ./ 를 붙인다", () => {
    expect(relativeImportPath("src/a.test.ts", "src/a.ts")).toBe("./a");
  });

  it("깊은 중첩도 처리한다", () => {
    expect(
      relativeImportPath("tests/unit/deep/x.test.ts", "src/lib/guard.ts"),
    ).toBe("../../../src/lib/guard");
  });

  it("확장자를 벗긴다", () => {
    // 확장자 요구는 러너 설정마다 다르다. 형제 테스트를 따르게 둔다.
    expect(relativeImportPath("t/a.test.ts", "src/b.tsx")).toBe("../src/b");
    expect(relativeImportPath("t/a.test.ts", "src/b.mts")).toBe("../src/b");
    expect(relativeImportPath("t/a.test.ts", "src/b.js")).toBe("../src/b");
  });

  it("테스트가 소스보다 안쪽에 있어도 된다", () => {
    expect(relativeImportPath("src/lib/a.test.ts", "src/index.ts")).toBe("../index");
  });
});

describe("extractRunnerImport", () => {
  it("vitest import 줄을 뽑는다", () => {
    const src = `import { describe, expect, it } from "vitest";
import { x } from "../src/x";`;
    expect(extractRunnerImport(src)).toBe('import { describe, expect, it } from "vitest";');
  });

  it("jest globals도 알아본다", () => {
    const src = `import { describe, it } from "@jest/globals";`;
    expect(extractRunnerImport(src)).toContain("@jest/globals");
  });

  it("작은따옴표도 처리한다", () => {
    expect(extractRunnerImport("import { it } from 'vitest';")).toBeTruthy();
  });

  it("러너 import가 없으면 undefined다", () => {
    // globals: true 인 프로젝트는 import하지 않는다. 강제하면 오히려 해롭다.
    expect(extractRunnerImport(`import { x } from "../src/x";`)).toBeUndefined();
  });

  it("다른 패키지의 import를 러너로 착각하지 않는다", () => {
    expect(extractRunnerImport(`import { z } from "zod";`)).toBeUndefined();
  });
});

describe("buildImportRequirement", () => {
  it("계산된 경로를 명시한다", () => {
    const out = buildImportRequirement({
      testFileRel: "test/index.mh-1.test.ts",
      sourceRel: "src/index.ts",
    });
    expect(out).toContain("../src/index");
  });

  it("형제가 러너를 import하면 그것도 요구한다", () => {
    // globals: false 인 프로젝트에서 describe is not defined 로 죽었다.
    const out = buildImportRequirement({
      testFileRel: "test/a.test.ts",
      sourceRel: "src/a.ts",
      siblingContent: `import { describe, it } from "vitest";`,
    });
    expect(out).toContain("vitest");
    expect(out).toContain("전역으로 제공하지 않는다");
  });

  it("형제가 없으면 경로만 알려준다", () => {
    const out = buildImportRequirement({
      testFileRel: "test/a.test.ts",
      sourceRel: "src/a.ts",
    });
    expect(out).toContain("../src/a");
    expect(out).not.toContain("러너 API");
  });
});
