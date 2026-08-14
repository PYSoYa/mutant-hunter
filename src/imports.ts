import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { walkFiles } from "./testfile.js";

/**
 * 생성 테스트가 써야 할 import를 **계산해서** 알려준다.
 *
 * 원래는 "형제 테스트의 import 스타일을 따르라"고 부탁만 했다. 외부 repo에
 * 처음 돌렸더니 7건 중 6건이 여기서 죽었다 — `./index`로 써야 할 것을
 * `../src/index`로, 또는 그 반대로 썼고, `globals: false`인 프로젝트에서
 * `describe`를 import하지 않았다.
 *
 * 우리는 파일을 어디 놓을지도, 소스가 어디 있는지도 안다. 결정론적으로
 * 알 수 있는 것을 LLM에게 추측시키지 않는다.
 */
export function relativeImportPath(testFileRel: string, sourceRel: string): string {
  const fromDir = dirname(testFileRel);
  let rel = relative(fromDir, sourceRel);

  // 확장자는 러너 설정마다 다르게 요구된다. 형제 테스트를 따르도록 벗겨둔다.
  rel = rel.replace(/\.(m|c)?tsx?$/, "").replace(/\.(m|c)?jsx?$/, "");

  // Windows 경로 구분자가 섞이면 import가 깨진다.
  rel = rel.split("\\").join("/");

  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * 형제 테스트가 러너에서 무엇을 가져오는지 뽑는다.
 *
 * `globals: false`인 프로젝트에서는 `describe`/`it`/`expect`를 반드시
 * import해야 한다. 형제가 어떻게 하는지가 유일하게 믿을 수 있는 근거다.
 */
export function extractRunnerImport(siblingContent: string): string | undefined {
  const pattern = /^\s*import\s+\{[^}]*\}\s+from\s+["'](vitest|@jest\/globals|bun:test)["'];?\s*$/gm;
  const match = pattern.exec(siblingContent);
  return match?.[0]?.trim();
}

/**
 * repo 전체에서 러너 import 관례를 찾는다.
 *
 * 형제 테스트를 못 찾으면 러너 import를 알려줄 방법이 없어진다. 그런데
 * `globals: false`인 프로젝트에서 그걸 빠뜨리면 `describe is not defined`로
 * 죽는다. 관례는 repo 전체에 공통이므로 아무 테스트 파일에서나 알 수 있다.
 */
export function detectRunnerImport(repoRoot: string, maxFiles = 20): string | undefined {
  const counts = new Map<string, number>();
  let scanned = 0;

  for (const rel of walkFiles(repoRoot)) {
    if (scanned >= maxFiles) break;
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) continue;

    let content: string;
    try {
      content = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    scanned++;

    const line = extractRunnerImport(content);
    if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  // 가장 흔한 관례를 따른다. 전부 없으면 globals: true인 프로젝트다.
  let best: { line: string; n: number } | undefined;
  for (const [line, n] of counts) {
    if (!best || n > best.n) best = { line, n };
  }
  return best?.line;
}

/**
 * 프롬프트에 넣을 "반드시 이렇게 시작하라" 블록.
 * 형제 테스트가 없으면 경로만이라도 알려준다.
 */
export function buildImportRequirement(opts: {
  testFileRel: string;
  sourceRel: string;
  siblingContent?: string;
  /** 형제를 못 찾았을 때 쓸 repo 공통 관례 */
  fallbackRunnerImport?: string;
}): string {
  const path = relativeImportPath(opts.testFileRel, opts.sourceRel);
  const lines = [`대상 모듈은 정확히 이 경로로 import한다: \`${path}\``];

  const runner =
    (opts.siblingContent ? extractRunnerImport(opts.siblingContent) : undefined) ??
    opts.fallbackRunnerImport;

  if (runner) {
    lines.push(
      "",
      "러너 API도 반드시 import한다. 이 프로젝트는 전역으로 제공하지 않는다:",
      "```ts",
      runner,
      "```",
    );
  }

  return lines.join("\n");
}
