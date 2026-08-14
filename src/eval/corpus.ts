/**
 * 골든 코퍼스 — 프롬프트나 필터를 바꿀 때마다 같은 대상에 돌려
 * 좋아졌는지 나빠졌는지를 숫자로 판정하기 위한 고정 표본.
 *
 * 표본이 움직이면 비교가 의미를 잃으므로, git 소스는 반드시 커밋 SHA로
 * 고정한다. 브랜치 이름은 허용하지 않는다.
 */
export type CorpusSource =
  | { type: "local"; path: string }
  | { type: "git"; url: string; sha: string };

export type CorpusDiff =
  | { type: "file"; path: string }
  | { type: "refs"; base: string; head: string };

export type CorpusEntry = {
  name: string;
  source: CorpusSource;
  diff: CorpusDiff;
  /** 뮤테이션 전용 테스트 설정 (선택, 순수 최적화) */
  runnerConfig?: string;
  /** 이 표본을 왜 골랐는지 */
  notes?: string;
};

export type Corpus = { entries: CorpusEntry[] };

export class CorpusError extends Error {}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export function parseCorpus(raw: unknown): Corpus {
  if (!isRecord(raw)) throw new CorpusError("코퍼스는 객체여야 합니다");

  const entries = raw["entries"];
  if (!Array.isArray(entries)) {
    throw new CorpusError("entries 배열이 필요합니다");
  }

  const seen = new Set<string>();
  const parsed = entries.map((entry, i) => parseEntry(entry, i, seen));

  return { entries: parsed };
}

function parseEntry(raw: unknown, index: number, seen: Set<string>): CorpusEntry {
  const at = `entries[${index}]`;
  if (!isRecord(raw)) throw new CorpusError(`${at}: 객체여야 합니다`);

  const name = raw["name"];
  if (typeof name !== "string" || !name) {
    throw new CorpusError(`${at}: name이 필요합니다`);
  }
  // 이름이 겹치면 결과 비교에서 조용히 한쪽을 덮어쓴다.
  if (seen.has(name)) throw new CorpusError(`${at}: name이 중복입니다 (${name})`);
  seen.add(name);

  return {
    name,
    source: parseSource(raw["source"], at),
    diff: parseDiff(raw["diff"], at),
    runnerConfig: optionalString(raw["runnerConfig"], `${at}.runnerConfig`),
    notes: optionalString(raw["notes"], `${at}.notes`),
  };
}

function parseSource(raw: unknown, at: string): CorpusSource {
  if (!isRecord(raw)) throw new CorpusError(`${at}.source: 객체여야 합니다`);

  if (raw["type"] === "local") {
    const path = raw["path"];
    if (typeof path !== "string" || !path) {
      throw new CorpusError(`${at}.source.path가 필요합니다`);
    }
    return { type: "local", path };
  }

  if (raw["type"] === "git") {
    const url = raw["url"];
    const sha = raw["sha"];
    if (typeof url !== "string" || !url) {
      throw new CorpusError(`${at}.source.url이 필요합니다`);
    }
    if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
      // 브랜치 이름을 허용하면 표본이 움직여 회귀 비교가 무의미해진다.
      throw new CorpusError(
        `${at}.source.sha는 커밋 SHA여야 합니다 (브랜치 이름 불가)`,
      );
    }
    return { type: "git", url, sha };
  }

  throw new CorpusError(`${at}.source.type은 local 또는 git이어야 합니다`);
}

function parseDiff(raw: unknown, at: string): CorpusDiff {
  if (!isRecord(raw)) throw new CorpusError(`${at}.diff: 객체여야 합니다`);

  if (raw["type"] === "file") {
    const path = raw["path"];
    if (typeof path !== "string" || !path) {
      throw new CorpusError(`${at}.diff.path가 필요합니다`);
    }
    return { type: "file", path };
  }

  if (raw["type"] === "refs") {
    const base = raw["base"];
    const head = raw["head"];
    if (typeof base !== "string" || !base || typeof head !== "string" || !head) {
      throw new CorpusError(`${at}.diff에 base와 head가 필요합니다`);
    }
    return { type: "refs", base, head };
  }

  throw new CorpusError(`${at}.diff.type은 file 또는 refs여야 합니다`);
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CorpusError(`${at}: 문자열이어야 합니다`);
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
