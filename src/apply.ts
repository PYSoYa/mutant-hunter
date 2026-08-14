import { readFileSync, writeFileSync } from "node:fs";
import type { Mutant } from "./types.js";

/**
 * 1-based (line, column)을 문자열 오프셋으로 바꾼다.
 * Stryker 리포트의 위치 표기가 1-based이므로 그대로 맞춘다.
 */
export function offsetOf(source: string, line: number, column: number): number {
  let offset = 0;
  let currentLine = 1;

  while (currentLine < line) {
    const next = source.indexOf("\n", offset);
    // 요청한 줄이 파일 끝을 넘으면 끝 오프셋으로 고정한다.
    if (next === -1) return source.length;
    offset = next + 1;
    currentLine++;
  }

  const lineEnd = source.indexOf("\n", offset);
  const limit = lineEnd === -1 ? source.length : lineEnd;
  return Math.min(offset + column - 1, limit);
}

/**
 * 뮤턴트가 지목한 범위를 replacement로 갈아끼운 소스를 만든다.
 * 원본 문자열은 건드리지 않는다.
 */
export function applyMutant(source: string, mutant: Mutant): string {
  const start = offsetOf(source, mutant.line, mutant.column);
  const end = offsetOf(source, mutant.endLine, mutant.endColumn);

  if (end < start) {
    throw new Error(
      `뮤턴트 범위가 뒤집혔습니다: ${mutant.path}:${mutant.line}:${mutant.column}`,
    );
  }

  return source.slice(0, start) + mutant.replacement + source.slice(end);
}

/**
 * 파일에 뮤턴트를 적용한 상태로 fn을 실행하고, 끝나면 반드시 원본으로 되돌린다.
 *
 * 대상 repo의 소스를 직접 건드리므로 복원 실패는 곧 사용자 코드 손상이다.
 * fn이 던지든 프로세스가 정상 종료하든 finally에서 원본을 다시 쓴다.
 */
export async function withMutantApplied<T>(
  absPath: string,
  mutant: Mutant,
  fn: () => Promise<T>,
): Promise<T> {
  const original = readFileSync(absPath, "utf8");
  try {
    writeFileSync(absPath, applyMutant(original, mutant));
    return await fn();
  } finally {
    writeFileSync(absPath, original);
  }
}
