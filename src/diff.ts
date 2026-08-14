import type { ChangedFile } from "./types.js";

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * `git diff --unified=0` 출력에서 변경된 파일과 새 파일 기준 줄 번호를 뽑는다.
 *
 * unified=0을 전제로 한다 — 컨텍스트 줄이 섞이면 변경되지 않은 줄까지
 * 뮤테이션 대상에 들어가 실행 시간이 불필요하게 늘어난다.
 *
 * 순수 삭제 훅(+a,0)은 새 파일에 줄이 없지만, 삭제된 코드를 감싸던 선언은
 * 여전히 영향을 받으므로 인접 줄 하나를 접점으로 남긴다.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const byPath = new Map<string, Set<number>>();
  let current: string | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      // 삭제된 파일에는 뮤테이션을 걸 대상이 없다.
      current = target === "/dev/null" ? null : stripPrefix(target);
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (current === null) continue;

    const m = HUNK.exec(line);
    if (!m) continue;

    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const lines = byPath.get(current) ?? new Set<number>();

    if (count === 0) {
      // 순수 삭제: start는 삭제 지점 "직전" 줄을 가리킨다.
      lines.add(Math.max(1, start));
    } else {
      for (let i = 0; i < count; i++) lines.add(start + i);
    }

    byPath.set(current, lines);
  }

  return [...byPath.entries()]
    .map(([path, set]) => ({
      path,
      changedLines: [...set].sort((a, b) => a - b),
    }))
    .filter((f) => f.changedLines.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** `b/src/foo.ts` → `src/foo.ts`. git이 붙이는 a//b/ 접두사를 벗긴다. */
function stripPrefix(target: string): string {
  const unquoted =
    target.startsWith('"') && target.endsWith('"')
      ? target.slice(1, -1)
      : target;
  return unquoted.replace(/^[ab]\//, "");
}

/** 뮤테이션을 걸 수 있는 소스 파일만 남긴다. */
export function isMutableSource(path: string): boolean {
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return false;
  if (/(^|\/)(node_modules|dist|build|coverage|\.next)\//.test(path)) {
    return false;
  }
  // 테스트 파일 자체는 대상이 아니다.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/(^|\/)(tests?|__tests__)\//.test(path)) return false;
  // 타입 선언에는 실행 가능한 로직이 없다.
  if (/\.d\.[cm]?ts$/.test(path)) return false;
  return true;
}
