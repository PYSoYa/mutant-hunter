import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRecord,
  recordNotKilled,
  saveRecord,
  SUSPECT_THRESHOLD,
  suspectedKeys,
} from "../src/equivalents.js";
import type { GenerationResult } from "../src/generate.js";
import type { Mutant } from "../src/types.js";

const MUTANT: Mutant = {
  id: "1",
  path: "src/a.ts",
  mutatorName: "MethodExpression",
  status: "Survived",
  line: 16,
  column: 3,
  endLine: 16,
  endColumn: 9,
  replacement: "raw",
  original: "raw.trim()",
};

const KEY = "src/a.ts:MethodExpression:16:3";

function result(over: Partial<GenerationResult>): GenerationResult {
  return { mutant: MUTANT, accepted: false, attempts: [], ...over };
}

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "mh-eq-")), "equivalents.json");

describe("recordNotKilled", () => {
  it("모든 시도가 못 죽였으면 센다", () => {
    const r = recordNotKilled({}, [
      result({
        attempts: [
          { index: 0, gates: [], rejectedAt: "kills-mutant" },
          { index: 1, gates: [], rejectedAt: "kills-mutant" },
        ],
      }),
    ]);
    expect(r[KEY]).toBe(1);
  });

  it("반복 실행마다 누적한다", () => {
    const once = recordNotKilled({}, [
      result({ attempts: [{ index: 0, gates: [], rejectedAt: "kills-mutant" }] }),
    ]);
    const twice = recordNotKilled(once, [
      result({ attempts: [{ index: 0, gates: [], rejectedAt: "kills-mutant" }] }),
    ]);
    expect(twice[KEY]).toBe(2);
  });

  it("다른 이유로 실패한 것은 세지 않는다", () => {
    // 문법 오류는 등가라서가 아니라 우리가 못 해서 실패한 것이다.
    const r = recordNotKilled({}, [
      result({
        attempts: [
          { index: 0, gates: [], rejectedAt: "kills-mutant" },
          { index: 1, gates: [], rejectedAt: "passes-on-original" },
        ],
      }),
    ]);
    expect(r[KEY]).toBeUndefined();
  });

  it("채택된 것은 세지 않는다", () => {
    const r = recordNotKilled({}, [
      result({
        accepted: true,
        attempts: [{ index: 0, gates: [], rejectedAt: "kills-mutant" }],
      }),
    ]);
    expect(r[KEY]).toBeUndefined();
  });

  it("LLM 오류는 세지 않는다", () => {
    // 쿼터 소진을 등가 판정에 섞으면 멀쩡한 뮤턴트를 영영 건너뛴다.
    expect(recordNotKilled({}, [result({ error: "429" })])[KEY]).toBeUndefined();
  });

  it("시도가 없으면 세지 않는다", () => {
    expect(recordNotKilled({}, [result({ attempts: [] })])[KEY]).toBeUndefined();
  });

  it("원본 기록을 변형하지 않는다", () => {
    const before = { [KEY]: 1 };
    recordNotKilled(before, [
      result({ attempts: [{ index: 0, gates: [], rejectedAt: "kills-mutant" }] }),
    ]);
    expect(before[KEY]).toBe(1);
  });
});

describe("suspectedKeys", () => {
  it("임계치를 넘긴 것만 의심한다", () => {
    // 한 번 실패는 모델이 못 쓴 것일 수 있다.
    const s = suspectedKeys({ a: SUSPECT_THRESHOLD, b: SUSPECT_THRESHOLD - 1 });
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
  });

  it("빈 기록은 빈 집합이다", () => {
    expect(suspectedKeys({}).size).toBe(0);
  });
});

describe("loadRecord / saveRecord", () => {
  it("저장한 것을 다시 읽는다", () => {
    const p = tmpPath();
    saveRecord(p, { [KEY]: 3 });
    expect(loadRecord(p)[KEY]).toBe(3);
  });

  it("파일이 없으면 빈 기록이다", () => {
    expect(loadRecord(join(tmpdir(), "없는파일-mh.json"))).toEqual({});
  });

  it("깨진 파일 때문에 죽지 않는다", () => {
    const p = tmpPath();
    writeFileSync(p, "{ JSON 아님");
    expect(loadRecord(p)).toEqual({});
  });

  it("예전 배열 형식도 읽는다", () => {
    // 이전 버전이 남긴 파일로 실행이 깨지면 안 된다.
    const p = tmpPath();
    writeFileSync(p, JSON.stringify([KEY]));
    expect(suspectedKeys(loadRecord(p)).has(KEY)).toBe(true);
  });

  it("숫자가 아닌 값은 버린다", () => {
    const p = tmpPath();
    writeFileSync(p, JSON.stringify({ [KEY]: "많이" }));
    expect(loadRecord(p)).toEqual({});
  });

  it("없는 디렉터리에도 저장한다", () => {
    const p = join(mkdtempSync(join(tmpdir(), "mh-eq-")), "깊이", "e.json");
    saveRecord(p, { x: 1 });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ x: 1 });
  });
});
