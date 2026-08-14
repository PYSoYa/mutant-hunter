import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const TEST_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** 스캔 비용 상한. 거대한 monorepo에서 전체 순회로 시간을 태우지 않는다. */
const MAX_SCAN_FILES = 2000;

/**
 * 대상 소스를 검증하는 기존 테스트 파일을 찾는다.
 *
 * 생성 테스트를 그 옆에 두면 두 가지가 공짜로 해결된다.
 * 1. 러너의 include 패턴 안에 들어간다 (`tests/**\/*.test.ts` 같은 설정)
 * 2. import 별칭·상대 경로 스타일을 그대로 흉내 낼 수 있다
 */
export function findSiblingTest(
  repoRoot: string,
  sourceRelPath: string,
): string | undefined {
  const stem = basename(sourceRelPath, extname(sourceRelPath));
  let best: { path: string; score: number } | undefined;
  let scanned = 0;

  for (const rel of walkFiles(repoRoot)) {
    if (++scanned > MAX_SCAN_FILES) break;
    if (!TEST_PATTERN.test(rel)) continue;

    let content: string;
    try {
      content = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }

    // 파일명이 같으면 강한 신호다. destr의 test/index.test.ts는 소스를
    // `from "../src"`로 import해서 "index"라는 문자열이 하나도 없었고,
    // 내용 일치만 보다가 형제를 못 찾았다.
    const sameName = basename(rel).replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "") === stem;
    const score = occurrences(content, stem) + (sameName ? 1000 : 0);
    if (score === 0) continue;
    if (!best || score > best.score) best = { path: rel, score };
  }

  return best?.path;
}

/**
 * 생성 테스트를 놓을 경로를 정한다.
 * 형제 테스트를 찾았으면 그 옆에, 못 찾았으면 관례적인 테스트 디렉터리에 둔다.
 */
export function generatedTestPath(
  repoRoot: string,
  sourceRelPath: string,
  mutantId: string,
  sibling?: string,
): string {
  const safeId = mutantId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const stem = basename(sourceRelPath, extname(sourceRelPath));
  const name = `${stem}.mh-${safeId}.test.ts`;

  if (sibling) return join(dirname(sibling), name);

  for (const dir of ["tests", "test", "__tests__"]) {
    if (existsSync(join(repoRoot, dir))) return join(dir, name);
  }
  return join(dirname(sourceRelPath), name);
}

export function writeGeneratedTest(
  repoRoot: string,
  relPath: string,
  content: string,
): void {
  writeFileSync(join(repoRoot, relPath), content);
}

/** 생성 테스트를 지운다. 검증이 어떻게 끝나든 대상 repo에 남기지 않는다. */
export function removeGeneratedTest(repoRoot: string, relPath: string): void {
  rmSync(join(repoRoot, relPath), { force: true });
}

export function* walkFiles(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = String(entry);
    if (/(^|[/\\])(node_modules|\.git|dist|build|coverage|\.next)([/\\]|$)/.test(rel)) {
      continue;
    }
    yield rel;
  }
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
