import { appendFileSync, readFileSync } from "node:fs";

export type Env = Record<string, string | undefined>;

/**
 * Actions는 입력을 INPUT_<이름> 환경변수로 넘긴다.
 *
 * node 액션은 하이픈을 그대로 둔 이름(INPUT_MAX-MUTANTS)을 쓰지만,
 * composite 액션에서는 우리가 직접 env를 세팅해야 하고 하이픈이 든
 * 환경변수 이름은 셸에서 다루기 나쁘다. 그래서 언더스코어 형태를 먼저 보고,
 * 하이픈 형태로도 한 번 더 찾는다.
 */
export function getInput(name: string, env: Env = process.env): string {
  const upper = name.replace(/ /g, "_").toUpperCase();
  const underscored = `INPUT_${upper.replace(/-/g, "_")}`;
  const hyphenated = `INPUT_${upper}`;
  return (env[underscored] ?? env[hyphenated] ?? "").trim();
}

export function getBooleanInput(name: string, env: Env = process.env): boolean {
  const raw = getInput(name, env).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function getNumberInput(name: string, env: Env = process.env): number | undefined {
  const raw = getInput(name, env);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * PR 번호와 base SHA를 이벤트 페이로드에서 읽는다.
 * pull_request 이벤트가 아니면 둘 다 없다.
 */
export function readPullRequestContext(
  env: Env = process.env,
): { number?: number; baseSha?: string; headSha?: string } {
  const path = env["GITHUB_EVENT_PATH"];
  if (!path) return {};

  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      pull_request?: {
        number?: number;
        base?: { sha?: string };
        head?: { sha?: string };
      };
    };
    const pr = payload.pull_request;
    if (!pr) return {};
    return {
      number: pr.number,
      baseSha: pr.base?.sha,
      headSha: pr.head?.sha,
    };
  } catch {
    return {};
  }
}

export function setOutput(name: string, value: string, env: Env = process.env): void {
  const file = env["GITHUB_OUTPUT"];
  if (!file) return;
  // 여러 줄 값을 안전하게 넘기기 위한 heredoc 형식.
  const delimiter = `ghadelimiter_${name}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function writeStepSummary(markdown: string, env: Env = process.env): void {
  const file = env["GITHUB_SUMMARY_OVERRIDE"] ?? env["GITHUB_STEP_SUMMARY"];
  if (!file) return;
  appendFileSync(file, `${markdown}\n`);
}

/** owner/repo 문자열을 쪼갠다. */
export function splitRepo(full: string): { owner: string; repo: string } | undefined {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

export type CommentResult = {
  ok: boolean;
  status: number;
  /** 새로 달았는가, 기존 것을 고쳤는가 */
  action: "created" | "updated" | "failed";
  detail?: string;
};

type UpsertOptions = {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  /** 우리 코멘트를 식별하는 표식 */
  marker: string;
};

/**
 * 우리 코멘트가 이미 있으면 고치고, 없으면 새로 단다.
 *
 * 커밋이 추가될 때마다 새 코멘트를 쌓으면 알림 피로로 도구가 죽는다.
 * PR 하나당 코멘트 하나를 유지한다.
 */
export async function upsertPullRequestComment(
  opts: UpsertOptions,
): Promise<CommentResult> {
  const existing = await findOwnComment(opts);

  const url = existing
    ? `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/comments/${existing}`
    : `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments`;

  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: ghHeaders(opts.token),
    body: JSON.stringify({ body: opts.body }),
  });

  if (res.ok) {
    return { ok: true, status: res.status, action: existing ? "updated" : "created" };
  }
  return {
    ok: false,
    status: res.status,
    action: "failed",
    detail: (await res.text().catch(() => "")).slice(0, 500),
  };
}

/** 표식이 든 우리 코멘트의 id. 없으면 undefined. */
async function findOwnComment(opts: UpsertOptions): Promise<number | undefined> {
  // 코멘트가 많은 PR에서도 우리 것은 대개 앞쪽에 있다. 한 페이지면 충분하다.
  const res = await fetch(
    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments?per_page=100`,
    { headers: ghHeaders(opts.token) },
  );
  if (!res.ok) return undefined;

  try {
    const comments = (await res.json()) as { id: number; body?: string }[];
    return comments.find((c) => c.body?.includes(opts.marker))?.id;
  } catch {
    // 목록을 못 읽었다고 코멘트를 포기할 이유는 없다. 새로 단다.
    return undefined;
  }
}

function ghHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}
