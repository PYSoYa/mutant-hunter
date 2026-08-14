import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheKey, FileCache, NullCache, openCache } from "../src/cache.js";
import type { Mutant } from "../src/types.js";

const MUTANT: Mutant = {
  id: "1",
  path: "src/a.ts",
  mutatorName: "ConditionalExpression",
  status: "Survived",
  line: 10,
  column: 1,
  endLine: 10,
  endColumn: 5,
  replacement: "false",
  original: "x > y",
};

const BASE = { mutant: MUTANT, prompt: "프롬프트", model: "mistral", attempt: 0 };

describe("cacheKey", () => {
  it("같은 입력은 같은 키다", () => {
    expect(cacheKey(BASE)).toBe(cacheKey({ ...BASE }));
  });

  it("프롬프트가 한 글자만 달라도 다른 키다", () => {
    // 프롬프트를 고치고 캐시가 적중하면 A/B가 통째로 거짓이 된다.
    expect(cacheKey(BASE)).not.toBe(cacheKey({ ...BASE, prompt: "프롬프트." }));
  });

  it("모델이 다르면 다른 키다", () => {
    expect(cacheKey(BASE)).not.toBe(cacheKey({ ...BASE, model: "gemini" }));
  });

  it("재시도 회차가 다르면 다른 키다", () => {
    // 재시도는 다른 온도로 도는 별개 생성이다.
    expect(cacheKey(BASE)).not.toBe(cacheKey({ ...BASE, attempt: 1 }));
  });

  it("같은 위치라도 원본 코드가 바뀌면 다른 키다", () => {
    expect(cacheKey(BASE)).not.toBe(
      cacheKey({ ...BASE, mutant: { ...MUTANT, original: "x >= y" } }),
    );
  });

  it("뮤테이터 종류가 다르면 다른 키다", () => {
    expect(cacheKey(BASE)).not.toBe(
      cacheKey({ ...BASE, mutant: { ...MUTANT, mutatorName: "EqualityOperator" } }),
    );
  });
});

describe("FileCache", () => {
  const cachePath = () => join(mkdtempSync(join(tmpdir(), "mh-cache-")), "c.json");

  it("저장한 값을 돌려준다", () => {
    const c = new FileCache(cachePath());
    c.set("k", "테스트 소스");
    expect(c.get("k")).toBe("테스트 소스");
  });

  it("적중과 실패를 센다", () => {
    const c = new FileCache(cachePath());
    c.set("k", "v");
    c.get("k");
    c.get("없음");
    expect(c.hits).toBe(1);
    expect(c.misses).toBe(1);
  });

  it("flush 후 다시 열면 값이 남아 있다", () => {
    const p = cachePath();
    const a = new FileCache(p);
    a.set("k", "v");
    a.flush();
    expect(new FileCache(p).get("k")).toBe("v");
  });

  it("flush 전에는 디스크에 쓰지 않는다", () => {
    const p = cachePath();
    const a = new FileCache(p);
    a.set("k", "v");
    expect(new FileCache(p).get("k")).toBeUndefined();
  });

  it("바뀐 게 없으면 flush가 아무 일도 하지 않는다", () => {
    const p = cachePath();
    new FileCache(p).flush();
    expect(() => new FileCache(p)).not.toThrow();
  });

  it("깨진 캐시 파일 때문에 죽지 않는다", () => {
    // 캐시는 최적화지 정확성의 근거가 아니다. 못 읽으면 비우고 계속한다.
    const p = cachePath();
    writeFileSync(p, "{ 이건 JSON이 아님");
    expect(new FileCache(p).get("k")).toBeUndefined();
  });

  it("문자열이 아닌 값이 든 캐시를 거부한다", () => {
    const p = cachePath();
    writeFileSync(p, JSON.stringify({ k: { 이상한: "구조" } }));
    expect(new FileCache(p).get("k")).toBeUndefined();
  });

  it("배열이 든 파일도 거부한다", () => {
    const p = cachePath();
    writeFileSync(p, JSON.stringify(["a"]));
    expect(new FileCache(p).get("0")).toBeUndefined();
  });

  it("없는 디렉터리에도 저장한다", () => {
    const p = join(mkdtempSync(join(tmpdir(), "mh-cache-")), "깊이", "c.json");
    const c = new FileCache(p);
    c.set("k", "v");
    c.flush();
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ k: "v" });
  });
});

describe("NullCache", () => {
  it("아무것도 저장하지 않는다", () => {
    // 잡음 폭 측정에서 캐시가 켜지면 흔들림이 0이 되어 측정이 무의미해진다.
    const c = new NullCache();
    c.set();
    expect(c.get()).toBeUndefined();
  });

  it("적중은 항상 0이다", () => {
    const c = new NullCache();
    c.get();
    expect(c.hits).toBe(0);
    expect(c.misses).toBe(1);
  });
});

describe("openCache", () => {
  it("끄면 아무것도 저장하지 않는 캐시를 준다", () => {
    const root = mkdtempSync(join(tmpdir(), "mh-repo-"));
    expect(openCache(root, ".mh", false)).toBeInstanceOf(NullCache);
  });

  it("켜면 파일 캐시를 준다", () => {
    const root = mkdtempSync(join(tmpdir(), "mh-repo-"));
    expect(openCache(root, ".mh", true)).toBeInstanceOf(FileCache);
  });
});
