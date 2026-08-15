import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GenerationResult } from "./generate.js";
import { mutantKey } from "./mutants.js";

/**
 * 등가 뮤턴트 의심 목록.
 *
 * 원래 이 파일은 **읽기만 하고 쓰는 코드가 없었다.** README에는 "의심 목록
 * 캐시로 대응한다"고 써 있었는데 실제로는 아무것도 채워지지 않았다.
 * 동작하는 척하는 코드는 없는 것보다 나쁘다.
 *
 * 등가 뮤턴트는 원리적으로 죽일 수 없다. 1주차에 실제로 두 개를 만났다
 * (`raw.trim()` -> `raw`, `i < len` -> `i <= len`). 매번 다시 시도하면
 * 쿼터만 태우므로, 반복해서 못 죽인 뮤턴트를 기록해 다음부터 건너뛴다.
 */
export type EquivalentRecord = Record<string, number>;

/** 몇 번 실패해야 의심할 것인가. 한 번 실패는 모델이 못 쓴 것일 수 있다. */
export const SUSPECT_THRESHOLD = 2;

export function equivalentsPath(repoRoot: string, workDir: string): string {
  return join(repoRoot, workDir, "equivalents.json");
}

export function loadRecord(path: string): EquivalentRecord {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;

    // 예전 형식(문자열 배열)도 읽는다. 한 번 실패한 것으로 센다.
    if (Array.isArray(raw)) {
      const out: EquivalentRecord = {};
      for (const k of raw) if (typeof k === "string") out[k] = SUSPECT_THRESHOLD;
      return out;
    }

    if (typeof raw === "object" && raw !== null) {
      const out: EquivalentRecord = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {
    // 캐시가 깨졌다고 실행이 죽을 이유는 없다.
  }
  return {};
}

/** 임계치를 넘긴 것만 의심 대상으로 넘긴다. */
export function suspectedKeys(record: EquivalentRecord): Set<string> {
  return new Set(
    Object.entries(record)
      .filter(([, n]) => n >= SUSPECT_THRESHOLD)
      .map(([k]) => k),
  );
}

/**
 * 이번 실행에서 "끝내 못 죽인" 뮤턴트를 세어 기록에 더한다.
 *
 * 다른 이유(문법 오류, 쿼터 소진)로 실패한 것은 세지 않는다.
 * 그건 등가라서가 아니라 우리가 못 해서 실패한 것이다.
 */
export function recordNotKilled(
  record: EquivalentRecord,
  results: GenerationResult[],
): EquivalentRecord {
  const next = { ...record };

  for (const r of results) {
    if (r.accepted || r.error) continue;
    if (r.attempts.length === 0) continue;

    // 모든 시도가 "못 죽였다"로 끝났을 때만 의심한다.
    const allNotKilled = r.attempts.every((a) => a.rejectedAt === "kills-mutant");
    if (!allNotKilled) continue;

    const key = mutantKey(r.mutant);
    next[key] = (next[key] ?? 0) + 1;
  }

  return next;
}

export function saveRecord(path: string, record: EquivalentRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 0));
}
