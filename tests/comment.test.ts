import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertPullRequestComment } from "../src/github.js";

type Call = { url: string; method: string; body?: unknown };

/** fetch를 대체해 호출을 기록한다. 네트워크를 타지 않는다. */
function stubFetch(responses: { status: number; json?: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses[i++] ?? { status: 200, json: [] };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json ?? [],
      text: async () => JSON.stringify(r.json ?? ""),
    } as unknown as Response;
  });

  return calls;
}

const OPTS = {
  token: "t",
  owner: "o",
  repo: "r",
  prNumber: 7,
  body: "<!-- mutant-hunter -->\n새 내용",
  marker: "<!-- mutant-hunter -->",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upsertPullRequestComment", () => {
  it("기존 코멘트가 없으면 새로 단다", async () => {
    const calls = stubFetch([
      { status: 200, json: [] },
      { status: 201, json: {} },
    ]);

    const res = await upsertPullRequestComment(OPTS);

    expect(res.ok).toBe(true);
    expect(res.action).toBe("created");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toContain("/issues/7/comments");
  });

  it("표식이 있는 우리 코멘트를 찾으면 고친다", async () => {
    // 커밋마다 새 코멘트를 쌓으면 알림 피로로 도구가 죽는다.
    const calls = stubFetch([
      { status: 200, json: [{ id: 42, body: "<!-- mutant-hunter -->\n예전 내용" }] },
      { status: 200, json: {} },
    ]);

    const res = await upsertPullRequestComment(OPTS);

    expect(res.action).toBe("updated");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.url).toContain("/issues/comments/42");
  });

  it("남의 코멘트는 건드리지 않는다", async () => {
    const calls = stubFetch([
      { status: 200, json: [{ id: 1, body: "LGTM" }, { id: 2, body: "고쳐주세요" }] },
      { status: 201, json: {} },
    ]);

    const res = await upsertPullRequestComment(OPTS);

    expect(res.action).toBe("created");
    expect(calls[1]?.method).toBe("POST");
  });

  it("표식이 있는 첫 코멘트를 고른다", async () => {
    const calls = stubFetch([
      {
        status: 200,
        json: [
          { id: 1, body: "무관" },
          { id: 5, body: "<!-- mutant-hunter --> 하나" },
          { id: 9, body: "<!-- mutant-hunter --> 둘" },
        ],
      },
      { status: 200, json: {} },
    ]);

    await upsertPullRequestComment(OPTS);
    expect(calls[1]?.url).toContain("/issues/comments/5");
  });

  it("목록 조회에 실패해도 코멘트를 포기하지 않는다", async () => {
    // 목록을 못 읽었다고 결과를 통째로 버릴 이유는 없다.
    const calls = stubFetch([
      { status: 403 },
      { status: 201, json: {} },
    ]);

    const res = await upsertPullRequestComment(OPTS);
    expect(res.action).toBe("created");
    expect(calls[1]?.method).toBe("POST");
  });

  it("작성 실패를 상태와 함께 알린다", async () => {
    stubFetch([
      { status: 200, json: [] },
      { status: 422, json: { message: "너무 김" } },
    ]);

    const res = await upsertPullRequestComment(OPTS);
    expect(res.ok).toBe(false);
    expect(res.action).toBe("failed");
    expect(res.status).toBe(422);
  });

  it("본문을 그대로 보낸다", async () => {
    const calls = stubFetch([
      { status: 200, json: [] },
      { status: 201, json: {} },
    ]);
    await upsertPullRequestComment(OPTS);
    expect(calls[1]?.body).toEqual({ body: OPTS.body });
  });
});
