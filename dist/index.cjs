"use strict";

// src/action.ts
var import_node_child_process3 = require("node:child_process");

// src/github.ts
var import_node_fs = require("node:fs");
function getInput(name, env = process.env) {
  const upper = name.replace(/ /g, "_").toUpperCase();
  const underscored = `INPUT_${upper.replace(/-/g, "_")}`;
  const hyphenated = `INPUT_${upper}`;
  return (env[underscored] ?? env[hyphenated] ?? "").trim();
}
function getBooleanInput(name, env = process.env) {
  const raw = getInput(name, env).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}
function getNumberInput(name, env = process.env) {
  const raw = getInput(name, env);
  if (!raw) return void 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : void 0;
}
function readPullRequestContext(env = process.env) {
  const path = env["GITHUB_EVENT_PATH"];
  if (!path) return {};
  try {
    const payload = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
    const pr = payload.pull_request;
    if (!pr) return {};
    return {
      number: pr.number,
      baseSha: pr.base?.sha,
      headSha: pr.head?.sha
    };
  } catch {
    return {};
  }
}
function setOutput(name, value, env = process.env) {
  const file = env["GITHUB_OUTPUT"];
  if (!file) return;
  const delimiter = `ghadelimiter_${name}`;
  (0, import_node_fs.appendFileSync)(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}
function writeStepSummary(markdown, env = process.env) {
  const file = env["GITHUB_SUMMARY_OVERRIDE"] ?? env["GITHUB_STEP_SUMMARY"];
  if (!file) return;
  (0, import_node_fs.appendFileSync)(file, `${markdown}
`);
}
function splitRepo(full) {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) return void 0;
  return { owner, repo };
}
async function postPullRequestComment(opts) {
  const res = await fetch(
    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ body: opts.body })
    }
  );
  if (res.ok) return { ok: true, status: res.status };
  return {
    ok: false,
    status: res.status,
    detail: (await res.text().catch(() => "")).slice(0, 500)
  };
}

// src/llm/provider.ts
var LLMError = class extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "LLMError";
    this.status = status;
  }
};

// src/llm/gemini.ts
var ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
var DEFAULT_MODEL = "gemini-flash-latest";
var DEFAULT_TIMEOUT_MS = 9e4;
var GeminiProvider = class {
  constructor(opts) {
    this.opts = opts;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  opts;
  name = "gemini";
  model;
  maxRetries;
  timeoutMs;
  async generate(req) {
    const url = `${ENDPOINT}/${this.model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: { temperature: req.temperature ?? 0.2 }
    };
    let lastError = "";
    let hintedDelayMs;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(waitMs(attempt, hintedDelayMs));
      await this.opts.rateLimiter?.acquire();
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.opts.apiKey
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (res.ok) {
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
        if (!text) {
          throw new LLMError(
            `\uBE48 \uC751\uB2F5 (finishReason=${json.candidates?.[0]?.finishReason ?? "unknown"})`
          );
        }
        return { text, model: this.model };
      }
      const bodyText = await res.text().catch(() => "");
      lastError = `${res.status} ${bodyText}`.slice(0, 500);
      hintedDelayMs = parseRetryDelayMs(bodyText, res.headers);
      if (res.status !== 429 && res.status < 500) {
        throw new LLMError(`Gemini \uD638\uCD9C \uC2E4\uD328: ${lastError}`, res.status);
      }
    }
    throw new LLMError(`\uC7AC\uC2DC\uB3C4 ${this.maxRetries}\uD68C \uD6C4\uC5D0\uB3C4 \uC2E4\uD328: ${lastError}`);
  }
};
function geminiFromEnv(env = process.env, rateLimiter) {
  const apiKey = env["GEMINI_API_KEY"];
  if (!apiKey) return void 0;
  return new GeminiProvider({ apiKey, model: env["GEMINI_MODEL"], rateLimiter });
}
function backoffMs(attempt) {
  return Math.min(1e3 * 2 ** (attempt - 1), 8e3);
}
var MAX_RETRY_WAIT_MS = 65e3;
function parseRetryDelayMs(bodyText, headers) {
  const header = headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1e3, MAX_RETRY_WAIT_MS);
    }
  }
  const structured = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(bodyText);
  if (structured?.[1]) {
    return Math.min(Number(structured[1]) * 1e3, MAX_RETRY_WAIT_MS);
  }
  const prose = /retry in ([\d.]+)\s*s/i.exec(bodyText);
  if (prose?.[1]) {
    return Math.min(Number(prose[1]) * 1e3, MAX_RETRY_WAIT_MS);
  }
  return void 0;
}
function waitMs(attempt, hintedMs) {
  const base = backoffMs(attempt);
  if (hintedMs === void 0) return base;
  return Math.min(Math.max(base, hintedMs + 500), MAX_RETRY_WAIT_MS);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/llm/openai-compat.ts
var PRESETS = {
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile"
  },
  mistral: {
    baseURL: "https://api.mistral.ai/v1",
    // 코드 전용 모델(codestral-latest)도 같은 엔드포인트에서 쓸 수 있다.
    // 어느 쪽이 뮤턴트를 잘 죽이는지는 평가 하네스로 재서 정한다.
    model: "mistral-small-latest"
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat"
  }
};
var OpenAICompatProvider = class {
  constructor(opts) {
    this.opts = opts;
    this.name = opts.label ?? "openai-compat";
    this.maxRetries = opts.maxRetries ?? 3;
  }
  opts;
  name;
  maxRetries;
  async generate(req) {
    const body = {
      model: this.opts.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user }
      ],
      temperature: req.temperature ?? 0.2
    };
    let lastError = "";
    let hintedDelayMs;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep2(waitMs(attempt, hintedDelayMs));
      await this.opts.rateLimiter?.acquire();
      let res;
      try {
        res = await fetch(`${this.opts.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.apiKey}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (res.ok) {
        const json = await res.json();
        const text = json.choices?.[0]?.message?.content;
        if (!text) {
          throw new LLMError(
            `\uBE48 \uC751\uB2F5 (finish_reason=${json.choices?.[0]?.finish_reason ?? "unknown"})`
          );
        }
        return { text, model: json.model ?? this.opts.model };
      }
      const bodyText = await res.text().catch(() => "");
      lastError = `${res.status} ${bodyText}`.slice(0, 500);
      hintedDelayMs = parseRetryDelayMs(bodyText, res.headers);
      if (res.status !== 429 && res.status < 500) {
        throw new LLMError(`${this.name} \uD638\uCD9C \uC2E4\uD328: ${lastError}`, res.status);
      }
    }
    throw new LLMError(`\uC7AC\uC2DC\uB3C4 ${this.maxRetries}\uD68C \uD6C4\uC5D0\uB3C4 \uC2E4\uD328: ${lastError}`);
  }
};
function openAICompatFromEnv(env = process.env, rateLimiter) {
  const apiKey = env["MH_API_KEY"];
  if (!apiKey) return void 0;
  const presetName = env["MH_PROVIDER"];
  const preset = presetName ? PRESETS[presetName] : void 0;
  const baseURL = env["MH_BASE_URL"] ?? preset?.baseURL;
  const model = env["MH_MODEL"] ?? preset?.model;
  if (!baseURL || !model) return void 0;
  return new OpenAICompatProvider({
    apiKey,
    baseURL,
    model,
    rateLimiter,
    label: presetName ?? "openai-compat"
  });
}
function sleep2(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/llm/rate-limit.ts
var RateLimiter = class {
  constructor(minIntervalMs, now = () => Date.now(), sleep3 = defaultSleep) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.sleep = sleep3;
  }
  minIntervalMs;
  now;
  sleep;
  nextAllowedAt = 0;
  /** 다음 호출이 허용될 때까지 기다린다. */
  async acquire() {
    const current = this.now();
    const waitMs2 = Math.max(0, this.nextAllowedAt - current);
    if (waitMs2 > 0) await this.sleep(waitMs2);
    this.nextAllowedAt = Math.max(current, this.nextAllowedAt) + this.minIntervalMs;
    return waitMs2;
  }
};
function intervalForRpm(requestsPerMinute) {
  if (requestsPerMinute <= 0) return 0;
  return Math.ceil(6e4 * 11 / (requestsPerMinute * 10));
}
function limiterFromEnv(env = process.env) {
  const explicit = Number(env["MH_MIN_INTERVAL_MS"]);
  if (Number.isFinite(explicit) && explicit >= 0) return new RateLimiter(explicit);
  const rpm = Number(env["MH_RPM"]);
  const effective = Number.isFinite(rpm) && rpm > 0 ? rpm : 20;
  return new RateLimiter(intervalForRpm(effective));
}
function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/llm/index.ts
function providerFromEnv(env = process.env) {
  const rateLimiter = limiterFromEnv(env);
  return openAICompatFromEnv(env, rateLimiter) ?? geminiFromEnv(env, rateLimiter);
}

// src/pipeline.ts
var import_node_fs6 = require("node:fs");
var import_node_path5 = require("node:path");

// src/diff.ts
var HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
function parseUnifiedDiff(diff) {
  const byPath = /* @__PURE__ */ new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = target === "/dev/null" ? null : stripPrefix(target);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (current === null) continue;
    const m = HUNK.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === void 0 ? 1 : Number(m[2]);
    const lines = byPath.get(current) ?? /* @__PURE__ */ new Set();
    if (count === 0) {
      lines.add(Math.max(1, start));
    } else {
      for (let i = 0; i < count; i++) lines.add(start + i);
    }
    byPath.set(current, lines);
  }
  return [...byPath.entries()].map(([path, set]) => ({
    path,
    changedLines: [...set].sort((a, b) => a - b)
  })).filter((f) => f.changedLines.length > 0).sort((a, b) => a.path.localeCompare(b.path));
}
function stripPrefix(target) {
  const unquoted = target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target;
  return unquoted.replace(/^[ab]\//, "");
}
function isMutableSource(path) {
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return false;
  if (/(^|\/)(node_modules|dist|build|coverage|\.next)\//.test(path)) {
    return false;
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/(^|\/)(tests?|__tests__)\//.test(path)) return false;
  if (/\.d\.[cm]?ts$/.test(path)) return false;
  return true;
}

// src/generate.ts
var import_node_fs4 = require("node:fs");
var import_node_path3 = require("node:path");

// src/prompt.ts
var SYSTEM_PROMPT = `\uB2F9\uC2E0\uC740 TypeScript/JavaScript \uD14C\uC2A4\uD2B8\uB97C \uC791\uC131\uD558\uB294 \uB3C4\uAD6C\uB2E4.

\uB2F9\uC2E0\uC5D0\uAC8C\uB294 "\uC0B4\uC544\uB0A8\uC740 \uBBA4\uD134\uD2B8"\uAC00 \uC8FC\uC5B4\uC9C4\uB2E4. \uBBA4\uD134\uD2B8\uB780 \uC18C\uC2A4 \uCF54\uB4DC\uC758 \uD55C \uC870\uAC01\uC744 \uC77C\uBD80\uB7EC
\uBC14\uAFD4\uCE58\uAE30\uD55C \uAC83\uC774\uACE0, \uC0B4\uC544\uB0A8\uC558\uB2E4\uB294 \uAC83\uC740 \uADF8\uB807\uAC8C \uBC14\uAFD4\uB3C4 \uAE30\uC874 \uD14C\uC2A4\uD2B8\uAC00 \uC804\uBD80 \uD1B5\uACFC\uD588\uB2E4\uB294
\uB73B\uC774\uB2E4. \uC989 \uADF8 \uCF54\uB4DC\uB294 \uD2C0\uB824\uB3C4 \uC544\uBB34\uB3C4 \uC54C\uC544\uCC44\uC9C0 \uBABB\uD55C\uB2E4.

\uB2F9\uC2E0\uC758 \uC784\uBB34\uB294 \uADF8 \uBBA4\uD134\uD2B8\uB97C \uC8FD\uC774\uB294 \uD14C\uC2A4\uD2B8\uB97C \uC4F0\uB294 \uAC83\uC774\uB2E4. \uC791\uC131\uD55C \uD14C\uC2A4\uD2B8\uB294

1. \uC6D0\uBCF8 \uCF54\uB4DC\uC5D0\uC11C \uBC18\uB4DC\uC2DC \uD1B5\uACFC\uD574\uC57C \uD558\uACE0
2. \uBBA4\uD134\uD2B8\uAC00 \uC801\uC6A9\uB41C \uCF54\uB4DC\uC5D0\uC11C \uBC18\uB4DC\uC2DC \uC2E4\uD328\uD574\uC57C \uD55C\uB2E4

\uB450 \uC870\uAC74 \uC911 \uD558\uB098\uB77C\uB3C4 \uC5B4\uAE30\uBA74 \uADF8 \uD14C\uC2A4\uD2B8\uB294 \uBC84\uB824\uC9C4\uB2E4. \uD2B9\uD788 2\uBC88\uC744 \uB193\uCE58\uAE30 \uC27D\uB2E4.
\uB2E8\uC5B8\uC774 \uB290\uC2A8\uD558\uBA74 \uC6D0\uBCF8\uC5D0\uC11C\uB3C4 \uBBA4\uD134\uD2B8\uC5D0\uC11C\uB3C4 \uD1B5\uACFC\uD574 \uBC84\uB9B0\uB2E4. \uBBA4\uD134\uD2B8\uAC00 \uB9CC\uB4E4\uC5B4\uB0B4\uB294
\uAD6C\uCCB4\uC801\uC778 \uAC12\xB7\uBA54\uC2DC\uC9C0\xB7\uD638\uCD9C \uC778\uC790\uB97C \uC815\uD655\uD788 \uACA8\uB0E5\uD558\uB77C.

\uC4F0\uAE30 \uC804\uC5D0 \uB450 \uAC00\uC9C0\uB97C \uBA3C\uC800 \uACC4\uC0B0\uD558\uB77C.

1. \uC5B4\uB5A4 \uC785\uB825\uC744 \uB123\uC73C\uBA74 \uC6D0\uBCF8\uACFC \uBBA4\uD134\uD2B8\uAC00 **\uB2E4\uB978 \uACB0\uACFC**\uB97C \uB0B4\uB294\uAC00
2. \uADF8 \uC785\uB825\uC5D0\uC11C \uC6D0\uBCF8 \uCF54\uB4DC\uAC00 \uB0B4\uB193\uB294 \uAC12\uC774 **\uC815\uD655\uD788** \uBB34\uC5C7\uC778\uAC00

2\uBC88\uC744 \uC9D0\uC791\uD558\uC9C0 \uB9C8\uB77C. \uC8FC\uC5B4\uC9C4 \uCF54\uB4DC\uB97C \uC190\uC73C\uB85C \uB530\uB77C\uAC00\uBA70 \uACC4\uC0B0\uD558\uB77C. \uC2E4\uCE21\uC5D0\uC11C
\uAC00\uC7A5 \uD754\uD55C \uC2E4\uD328\uAC00 \uAE30\uB300\uAC12\uC744 \uC798\uBABB \uCC0D\uB294 \uAC83\uC774\uC5C8\uB2E4 \u2014 \uC608\uB97C \uB4E4\uC5B4 \uACB0\uACFC\uAC00
\uBB38\uC790\uC5F4 "false"\uC778\uB370 \uBE48 \uBB38\uC790\uC5F4\uC744 \uAE30\uB300\uD574 \uC6D0\uBCF8\uC5D0\uC11C\uBD80\uD130 \uC2E4\uD328\uD588\uB2E4.

\uC815\uD655\uD55C \uAC12\uC744 \uD655\uC2E0\uD560 \uC218 \uC5C6\uC73C\uBA74, \uAC12\uC744 \uB2E8\uC5B8\uD558\uB294 \uB300\uC2E0 **\uC6D0\uBCF8\uACFC \uBBA4\uD134\uD2B8\uAC00
\uAC08\uB9AC\uB294 \uC131\uC9C8**\uC744 \uB2E8\uC5B8\uD558\uB77C. \uC608\uB97C \uB4E4\uC5B4 \uB358\uC9C0\uB294\uAC00/\uB358\uC9C0\uC9C0 \uC54A\uB294\uAC00, \uAE38\uC774\uAC00
0\uC778\uAC00 \uC544\uB2CC\uAC00, \uD2B9\uC815 \uBD80\uBD84 \uBB38\uC790\uC5F4\uC744 \uD3EC\uD568\uD558\uB294\uAC00.

\uADDC\uCE59:
- \uC644\uC804\uD55C \uD14C\uC2A4\uD2B8 \uD30C\uC77C \uD558\uB098\uB97C \uCD9C\uB825\uD55C\uB2E4. \uC124\uBA85\uC774\uB098 \uB9C8\uD06C\uB2E4\uC6B4 \uC5C6\uC774 \uCF54\uB4DC\uB9CC.
- \uC8FC\uC5B4\uC9C4 \uAE30\uC874 \uD14C\uC2A4\uD2B8 \uD30C\uC77C\uC758 import \uC2A4\uD0C0\uC77C, \uB7EC\uB108 API, \uBAA8\uD0B9 \uBC29\uC2DD\uC744 \uADF8\uB300\uB85C \uB530\uB978\uB2E4.
- \uC2DC\uAC04\xB7\uB09C\uC218\xB7\uC2E4\uD589 \uC21C\uC11C\uC5D0 \uC758\uC874\uD558\uC9C0 \uC54A\uB294\uB2E4. \uBC18\uBCF5 \uC2E4\uD589\uD574\uB3C4 \uACB0\uACFC\uAC00 \uAC19\uC544\uC57C \uD55C\uB2E4.
- \uC18C\uC2A4 \uCF54\uB4DC\uB97C \uC218\uC815\uD558\uB294 \uD14C\uC2A4\uD2B8\uB294 \uC4F0\uC9C0 \uC54A\uB294\uB2E4.
- \uAC70\uB300\uD55C \uD53D\uC2A4\uCC98\uAC00 \uC788\uC5B4\uC57C\uB9CC \uB3C4\uB2EC\uD558\uB294 \uBD84\uAE30\uB77C\uBA74(\uC608: \uC218\uCC9C \uAC1C \uD30C\uC77C\uC774 \uD544\uC694\uD55C
  \uC0C1\uD55C \uAC80\uC0AC) \uBB34\uB9AC\uD574\uC11C \uB9CC\uB4E4\uC9C0 \uB9D0\uACE0, \uADF8 \uBBA4\uD134\uD2B8\uB294 \uC8FD\uC774\uAE30 \uC5B4\uB835\uB2E4\uACE0 \uD310\uB2E8\uD558\uB77C.
- \uAC01 \uD14C\uC2A4\uD2B8\uC5D0 \uBB34\uC5C7\uC744 \uACA8\uB0E5\uD558\uB294\uC9C0 \uD55C \uC904 \uC8FC\uC11D\uC744 \uB0A8\uAE34\uB2E4.`;
var MAX_SIBLING_CHARS = 6e3;
var MAX_FAILURE_CHARS = 1500;
function buildUserPrompt(ctx) {
  const { mutant, sourceSnippet: sourceSnippet2, siblingTest, previousFailure } = ctx;
  const parts = [
    `## \uB300\uC0C1 \uD30C\uC77C
${mutant.path}`,
    `## \uC0B4\uC544\uB0A8\uC740 \uBBA4\uD134\uD2B8
\uC704\uCE58: ${mutant.path}:${mutant.line}:${mutant.column}
\uC885\uB958: ${mutant.mutatorName}

\uC6D0\uBCF8 \uCF54\uB4DC:
\`\`\`ts
` + mutant.original + "\n```\n\n\uBBA4\uD134\uD2B8\uAC00 \uC774\uB807\uAC8C \uBC14\uAFD4\uCE58\uAE30\uD55C\uB2E4:\n```ts\n" + mutant.replacement + "\n```",
    `## \uBBA4\uD134\uD2B8\uB97C \uAC10\uC2F8\uB294 \uCF54\uB4DC
\`\`\`ts
${sourceSnippet2}
\`\`\``
  ];
  if (siblingTest) {
    parts.push(
      `## \uAE30\uC874 \uD14C\uC2A4\uD2B8 \uD30C\uC77C (${siblingTest.path})
\uC774 \uD30C\uC77C\uC758 import \uACBD\uB85C, \uB7EC\uB108 API, \uBAA8\uD0B9 \uBC29\uC2DD\uC744 \uADF8\uB300\uB85C \uB530\uB974\uB77C.
\`\`\`ts
` + truncate(siblingTest.content, MAX_SIBLING_CHARS) + "\n```"
    );
  }
  if (previousFailure) {
    parts.push(
      `## \uC9C1\uC804 \uC2DC\uB3C4\uAC00 \uC2E4\uD328\uD588\uB2E4
\uAC8C\uC774\uD2B8: ${previousFailure.gate}
\uC0AC\uC720: ${truncate(previousFailure.detail, MAX_FAILURE_CHARS)}

` + (previousFailure.gate === "kills-mutant" ? "\uB2E8\uC5B8\uC774 \uB290\uC2A8\uD574\uC11C \uBBA4\uD134\uD2B8 \uCF54\uB4DC\uC5D0\uC11C\uB3C4 \uD1B5\uACFC\uD588\uB2E4. \uBBA4\uD134\uD2B8\uAC00 \uB9CC\uB4E4\uC5B4\uB0B4\uB294 \uAC12\uACFC \uC6D0\uBCF8\uC774 \uB9CC\uB4E4\uC5B4\uB0B4\uB294 \uAC12\uC774 \uC5B4\uB5BB\uAC8C \uB2E4\uB978\uC9C0 \uBA3C\uC800 \uC9DA\uACE0, \uADF8 \uCC28\uC774\uB97C \uC815\uD655\uD788 \uACA8\uB0E5\uD558\uB294 \uB2E8\uC5B8\uC744 \uC368\uB77C." : "\uC704 \uC0AC\uC720\uB97C \uD574\uACB0\uD55C \uD14C\uC2A4\uD2B8\uB97C \uB2E4\uC2DC \uC791\uC131\uD558\uB77C.")
    );
  }
  parts.push(
    "## \uCD9C\uB825\n\uC644\uC804\uD55C \uD14C\uC2A4\uD2B8 \uD30C\uC77C \uD558\uB098\uB97C \uCF54\uB4DC\uB9CC \uCD9C\uB825\uD558\uB77C. \uC124\uBA85\uC744 \uB367\uBD99\uC774\uC9C0 \uB9C8\uB77C."
  );
  return parts.join("\n\n");
}
function extractTestSource(text) {
  const fenced = /```(?:ts|tsx|typescript|js|jsx|javascript)?\s*\n([\s\S]*?)```/.exec(
    text
  );
  return (fenced?.[1] ?? text).trim();
}
function sourceSnippet(source, startLine, endLine) {
  const lines = source.split("\n");
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine);
  const width = String(to).length;
  return lines.slice(from - 1, to).map((text, i) => `${String(from + i).padStart(width)} | ${text}`).join("\n");
}
function truncate(s, limit) {
  return s.length > limit ? `${s.slice(0, limit)}
\u2026 (\uC0DD\uB7B5)` : s;
}

// src/testfile.ts
var import_node_fs2 = require("node:fs");
var import_node_path = require("node:path");
var TEST_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;
var MAX_SCAN_FILES = 2e3;
function findSiblingTest(repoRoot, sourceRelPath) {
  const stem = (0, import_node_path.basename)(sourceRelPath, (0, import_node_path.extname)(sourceRelPath));
  let best;
  let scanned = 0;
  for (const rel of walkFiles(repoRoot)) {
    if (++scanned > MAX_SCAN_FILES) break;
    if (!TEST_PATTERN.test(rel)) continue;
    let content;
    try {
      content = (0, import_node_fs2.readFileSync)((0, import_node_path.join)(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const score = occurrences(content, stem);
    if (score === 0) continue;
    if (!best || score > best.score) best = { path: rel, score };
  }
  return best?.path;
}
function generatedTestPath(repoRoot, sourceRelPath, mutantId, sibling) {
  const safeId = mutantId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const stem = (0, import_node_path.basename)(sourceRelPath, (0, import_node_path.extname)(sourceRelPath));
  const name = `${stem}.mh-${safeId}.test.ts`;
  if (sibling) return (0, import_node_path.join)((0, import_node_path.dirname)(sibling), name);
  for (const dir of ["tests", "test", "__tests__"]) {
    if ((0, import_node_fs2.existsSync)((0, import_node_path.join)(repoRoot, dir))) return (0, import_node_path.join)(dir, name);
  }
  return (0, import_node_path.join)((0, import_node_path.dirname)(sourceRelPath), name);
}
function writeGeneratedTest(repoRoot, relPath, content) {
  (0, import_node_fs2.writeFileSync)((0, import_node_path.join)(repoRoot, relPath), content);
}
function removeGeneratedTest(repoRoot, relPath) {
  (0, import_node_fs2.rmSync)((0, import_node_path.join)(repoRoot, relPath), { force: true });
}
function* walkFiles(root) {
  let entries;
  try {
    entries = (0, import_node_fs2.readdirSync)(root, { recursive: true });
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
function occurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// src/verify.ts
var import_node_path2 = require("node:path");

// src/apply.ts
var import_node_fs3 = require("node:fs");
function offsetOf(source, line, column) {
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return source.length;
    offset = next + 1;
    currentLine++;
  }
  const lineEnd = source.indexOf("\n", offset);
  const limit = lineEnd === -1 ? source.length : lineEnd;
  return Math.min(offset + column - 1, limit);
}
function applyMutant(source, mutant) {
  const start = offsetOf(source, mutant.line, mutant.column);
  const end = offsetOf(source, mutant.endLine, mutant.endColumn);
  if (end < start) {
    throw new Error(
      `\uBBA4\uD134\uD2B8 \uBC94\uC704\uAC00 \uB4A4\uC9D1\uD614\uC2B5\uB2C8\uB2E4: ${mutant.path}:${mutant.line}:${mutant.column}`
    );
  }
  return source.slice(0, start) + mutant.replacement + source.slice(end);
}
async function withMutantApplied(absPath, mutant, fn) {
  const original = (0, import_node_fs3.readFileSync)(absPath, "utf8");
  try {
    (0, import_node_fs3.writeFileSync)(absPath, applyMutant(original, mutant));
    return await fn();
  } finally {
    (0, import_node_fs3.writeFileSync)(absPath, original);
  }
}

// src/runner.ts
var import_node_child_process = require("node:child_process");
function buildTestCommand(runner, opts = {}) {
  const args = ["--no-install", runner];
  if (runner === "vitest") args.push("run");
  if (opts.configFile) args.push("--config", opts.configFile);
  if (opts.testFile) args.push(opts.testFile);
  return { cmd: "npx", args };
}
async function runTests(repoRoot, runner, opts = {}) {
  const { cmd, args } = buildTestCommand(runner, opts);
  return new Promise((resolve) => {
    const child = (0, import_node_child_process.spawn)(cmd, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" }
    });
    let output = "";
    const collect = (d) => {
      output += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({ passed: exitCode === 0, exitCode, output });
    });
  });
}

// src/verify.ts
async function verifyGeneratedTest(opts) {
  const {
    repoRoot,
    runner,
    mutant,
    testSource,
    testFileRel,
    configFile,
    stabilityRuns = 3,
    runFullSuite = true
  } = opts;
  const gates = [];
  const reject = (gate) => ({
    accepted: false,
    gates,
    rejectedAt: gate
  });
  writeGeneratedTest(repoRoot, testFileRel, testSource);
  try {
    const original = await runTests(repoRoot, runner, {
      testFile: testFileRel,
      configFile
    });
    gates.push({
      gate: "passes-on-original",
      ok: original.passed,
      detail: original.passed ? "\uD1B5\uACFC" : tail(original.output)
    });
    if (!original.passed) return reject("passes-on-original");
    const mutated = await withMutantApplied(
      (0, import_node_path2.join)(repoRoot, mutant.path),
      mutant,
      () => runTests(repoRoot, runner, { testFile: testFileRel, configFile })
    );
    const killed = !mutated.passed;
    gates.push({
      gate: "kills-mutant",
      ok: killed,
      detail: killed ? "\uBBA4\uD134\uD2B8\uB97C \uC8FD\uC600\uB2E4" : "\uBBA4\uD134\uD2B8\uAC00 \uC0B4\uC544\uB0A8\uC558\uB2E4 \u2014 \uACB0\uD568\uC744 \uC7A1\uC9C0 \uBABB\uD558\uB294 \uD14C\uC2A4\uD2B8"
    });
    if (!killed) return reject("kills-mutant");
    const repeats = Math.max(0, stabilityRuns - 1);
    for (let i = 0; i < repeats; i++) {
      const again = await runTests(repoRoot, runner, {
        testFile: testFileRel,
        configFile
      });
      if (!again.passed) {
        gates.push({
          gate: "stable",
          ok: false,
          detail: `${i + 2}\uD68C\uCC28 \uC2E4\uD589\uC5D0\uC11C \uC2E4\uD328 \u2014 flaky`
        });
        return reject("stable");
      }
    }
    gates.push({
      gate: "stable",
      ok: true,
      detail: `${stabilityRuns}\uD68C \uBC18\uBCF5 \uD1B5\uACFC`
    });
    if (runFullSuite) {
      const suite = await runTests(repoRoot, runner, {});
      gates.push({
        gate: "suite-intact",
        ok: suite.passed,
        detail: suite.passed ? "\uAE30\uC874 \uC2A4\uC704\uD2B8 \uD1B5\uACFC" : tail(suite.output)
      });
      if (!suite.passed) return reject("suite-intact");
    }
    return { accepted: true, gates };
  } finally {
    removeGeneratedTest(repoRoot, testFileRel);
  }
}
function tail(output, limit = 800) {
  const trimmed = output.trim();
  return trimmed.length > limit ? `\u2026${trimmed.slice(-limit)}` : trimmed;
}

// src/generate.ts
async function generateKillingTest(mutant, opts) {
  const { repoRoot, runner, provider, maxAttempts = 2 } = opts;
  const absSource = (0, import_node_path3.join)(repoRoot, mutant.path);
  let source;
  try {
    source = (0, import_node_fs4.readFileSync)(absSource, "utf8");
  } catch {
    return { mutant, accepted: false, attempts: [], error: `\uC18C\uC2A4\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4: ${mutant.path}` };
  }
  const sibling = findSiblingTest(repoRoot, mutant.path);
  const siblingTest = sibling ? { path: sibling, content: (0, import_node_fs4.readFileSync)((0, import_node_path3.join)(repoRoot, sibling), "utf8") } : void 0;
  const snippet = sourceSnippet(
    source,
    Math.max(1, mutant.line - 15),
    mutant.endLine + 15
  );
  const attempts = [];
  let previousFailure;
  for (let i = 0; i < maxAttempts; i++) {
    let testSource;
    try {
      const res = await provider.generate({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt({ mutant, sourceSnippet: snippet, siblingTest, previousFailure }),
        // 첫 시도는 결정론적으로, 재시도는 다른 접근을 유도한다.
        temperature: i === 0 ? 0.1 : 0.6
      });
      testSource = extractTestSource(res.text);
    } catch (err) {
      return {
        mutant,
        accepted: false,
        attempts,
        error: err instanceof Error ? err.message : String(err)
      };
    }
    if (!testSource) {
      previousFailure = { gate: "empty-response", detail: "\uBE48 \uC751\uB2F5" };
      attempts.push({ index: i, gates: [], rejectedAt: void 0 });
      continue;
    }
    const testFileRel = generatedTestPath(repoRoot, mutant.path, `${mutant.id}-${i}`, sibling);
    const outcome = await verifyGeneratedTest({
      repoRoot,
      runner,
      mutant,
      testSource,
      testFileRel,
      configFile: opts.configFile,
      stabilityRuns: opts.stabilityRuns,
      runFullSuite: opts.runFullSuite
    });
    attempts.push({ index: i, gates: outcome.gates, rejectedAt: outcome.rejectedAt });
    if (outcome.accepted) {
      return { mutant, accepted: true, testSource, testFileRel, attempts };
    }
    const failed = outcome.gates.find((g) => !g.ok);
    previousFailure = failed ? { gate: failed.gate, detail: failed.detail } : void 0;
  }
  return { mutant, accepted: false, attempts };
}
function summarize(results) {
  const rejectedBy = {};
  const gateRejections = {};
  let totalAttempts = 0;
  let rescuedByRetry = 0;
  for (const r of results) {
    totalAttempts += r.attempts.length;
    let hitGate = false;
    for (const attempt of r.attempts) {
      if (!attempt.rejectedAt) continue;
      hitGate = true;
      gateRejections[attempt.rejectedAt] = (gateRejections[attempt.rejectedAt] ?? 0) + 1;
    }
    if (hitGate && r.accepted) rescuedByRetry++;
    if (r.accepted) continue;
    const last = r.attempts[r.attempts.length - 1];
    const key = r.error ? "llm-error" : last?.rejectedAt ?? "unknown";
    rejectedBy[key] = (rejectedBy[key] ?? 0) + 1;
  }
  return {
    total: results.length,
    accepted: results.filter((r) => r.accepted).length,
    rejectedBy,
    totalAttempts,
    gateRejections,
    rescuedByRetry
  };
}

// src/mutants.ts
var NOISE_MUTATORS = /* @__PURE__ */ new Set(["StringLiteral"]);
function mutantKey(m) {
  return `${m.path}:${m.mutatorName}:${m.line}:${m.column}`;
}
function scanReport(report, opts = {}) {
  const parsed = report;
  const equivalents = opts.suspectedEquivalents ?? /* @__PURE__ */ new Set();
  const candidates = [];
  const filtered = [];
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let timeout = 0;
  let total = 0;
  for (const [path, file] of Object.entries(parsed.files ?? {})) {
    const lines = file.source.split("\n");
    for (const raw of file.mutants) {
      total++;
      switch (raw.status) {
        case "Killed":
          killed++;
          continue;
        case "Timeout":
          timeout++;
          continue;
        case "NoCoverage":
          noCoverage++;
          break;
        case "Survived":
          survived++;
          break;
        default:
          continue;
      }
      const mutant = {
        id: raw.id,
        path,
        mutatorName: raw.mutatorName,
        status: raw.status,
        line: raw.location.start.line,
        column: raw.location.start.column,
        endLine: raw.location.end.line,
        endColumn: raw.location.end.column,
        replacement: raw.replacement ?? "",
        original: sliceSource(lines, raw.location)
      };
      const reason = classify(mutant, equivalents);
      if (reason) filtered.push({ mutant, reason });
      else candidates.push(mutant);
    }
  }
  const scored = killed + timeout + survived + noCoverage;
  return {
    candidates,
    filtered,
    stats: {
      total,
      killed,
      survived,
      noCoverage,
      timeout,
      mutationScore: scored === 0 ? 100 : (killed + timeout) / scored * 100
    }
  };
}
function classify(m, equivalents) {
  if (NOISE_MUTATORS.has(m.mutatorName)) return "noise-string-literal";
  if (equivalents.has(mutantKey(m))) return "suspected-equivalent";
  if (m.status === "NoCoverage") return "no-coverage";
  return null;
}
function sliceSource(lines, loc) {
  const { start, end } = loc;
  if (start.line === end.line) {
    return (lines[start.line - 1] ?? "").slice(start.column - 1, end.column - 1);
  }
  const first = (lines[start.line - 1] ?? "").slice(start.column - 1);
  const middle = lines.slice(start.line, end.line - 1);
  const last = (lines[end.line - 1] ?? "").slice(0, end.column - 1);
  return [first, ...middle, last].join("\n");
}

// src/stryker.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs5 = require("node:fs");
var import_node_module = require("node:module");
var import_node_path4 = require("node:path");
var STRYKER_RANGE = "^9.6.1";
var WORK_DIR = ".mutant-hunter";
function detectTestRunner(repoRoot) {
  const pkgPath = (0, import_node_path4.join)(repoRoot, "package.json");
  const pkg = JSON.parse((0, import_node_fs5.readFileSync)(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["vitest"]) return "vitest";
  if (deps["jest"]) return "jest";
  throw new Error(
    "\uC9C0\uC6D0\uD558\uB294 \uD14C\uC2A4\uD2B8 \uB7EC\uB108\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (vitest \uB610\uB294 jest \uD544\uC694)"
  );
}
function buildStrykerConfig(opts) {
  const config = {
    testRunner: opts.testRunner,
    mutate: opts.mutate,
    // perTest여야 뮤턴트를 커버하는 테스트만 돌아간다. 이게 없으면
    // 뮤턴트마다 전체 스위트가 돌아 실행 시간이 수십 배가 된다.
    coverageAnalysis: "perTest",
    reporters: ["json"],
    jsonReporter: { fileName: `${WORK_DIR}/mutation.json` },
    concurrency: opts.concurrency ?? 4,
    timeoutMS: opts.timeoutMS ?? 15e3,
    tempDirName: `${WORK_DIR}/tmp`,
    // 대상 repo에 커밋되지 않도록 증분 캐시도 작업 디렉터리 안에 둔다.
    incremental: false,
    /**
     * Stryker는 기본적으로 샌드박스의 파일 맨 위에 `// @ts-nocheck`를 붙인다.
     * 그러면 **모든 줄 번호가 1씩 밀린다.**
     *
     * 이 도구는 뮤턴트를 줄/칸 오프셋으로 적용하고, 대상 repo의 테스트도
     * 줄 번호를 단언할 수 있다. 실제로 우리 자신을 대상으로 돌렸을 때
     * 이 한 줄 때문에 초기 테스트 실행이 실패해 스캔이 통째로 죽었다.
     * 샌드박스는 원본과 같은 줄 번호를 가져야 한다.
     */
    disableTypeChecks: false
  };
  if (opts.excludeStringLiterals) {
    config["mutator"] = { excludedMutations: ["StringLiteral"] };
  }
  if (opts.runnerConfigFile) {
    config[opts.testRunner] = { configFile: opts.runnerConfigFile };
  }
  return config;
}
function resolvesFrom(repoRoot, pkg) {
  try {
    (0, import_node_module.createRequire)((0, import_node_path4.join)(repoRoot, "package.json")).resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return false;
  }
}
async function ensureStryker(repoRoot, testRunner) {
  const needed = [
    `@stryker-mutator/core`,
    `@stryker-mutator/${testRunner}-runner`
  ].filter((pkg) => !resolvesFrom(repoRoot, pkg));
  if (needed.length === 0) return { installed: false, packages: [] };
  const spec = needed.map((pkg) => `${pkg}@${STRYKER_RANGE}`);
  const { code, stderr } = await exec(
    "npm",
    ["install", "--no-save", "--no-audit", "--no-fund", ...spec],
    repoRoot
  );
  if (code !== 0) {
    throw new Error(`Stryker \uB7F0\uD0C0\uC784 \uC124\uCE58 \uC2E4\uD328:
${stderr.slice(-1e3)}`);
  }
  return { installed: true, packages: needed };
}
async function runStryker(opts) {
  const workDir = (0, import_node_path4.join)(opts.repoRoot, WORK_DIR);
  (0, import_node_fs5.mkdirSync)(workDir, { recursive: true });
  const configPath = (0, import_node_path4.join)(workDir, "stryker.conf.json");
  (0, import_node_fs5.writeFileSync)(configPath, JSON.stringify(buildStrykerConfig(opts), null, 2));
  const { code, stderr } = await exec(
    "npx",
    ["--no-install", "stryker", "run", configPath],
    opts.repoRoot
  );
  try {
    const report = JSON.parse(
      (0, import_node_fs5.readFileSync)((0, import_node_path4.join)(workDir, "mutation.json"), "utf8")
    );
    return { ok: true, report };
  } catch {
    return { ok: false, exitCode: code, stderr };
  }
}
function exec(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process2.spawn)(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

// src/targets.ts
var import_ts_morph = require("ts-morph");
var DECLARATION_KINDS = /* @__PURE__ */ new Set([
  import_ts_morph.SyntaxKind.FunctionDeclaration,
  import_ts_morph.SyntaxKind.MethodDeclaration,
  import_ts_morph.SyntaxKind.Constructor,
  import_ts_morph.SyntaxKind.GetAccessor,
  import_ts_morph.SyntaxKind.SetAccessor,
  import_ts_morph.SyntaxKind.FunctionExpression,
  import_ts_morph.SyntaxKind.ArrowFunction,
  import_ts_morph.SyntaxKind.ClassDeclaration
]);
function createProject(tsConfigFilePath) {
  if (tsConfigFilePath) {
    return new import_ts_morph.Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true });
  }
  return new import_ts_morph.Project({
    compilerOptions: { allowJs: true, target: 99 },
    skipFileDependencyResolution: true
  });
}
function resolveMutateRanges(project, absPath, repoRelPath, changedLines) {
  const sourceFile = project.getSourceFile(absPath) ?? project.addSourceFileAtPath(absPath);
  const compilerNode = sourceFile.compilerNode;
  const totalLines = sourceFile.getEndLineNumber();
  const raw = [];
  for (const line of changedLines) {
    if (line > totalLines) continue;
    const pos = safePosOfLine(compilerNode, line);
    if (pos === null) continue;
    const node = sourceFile.getDescendantAtPos(pos);
    const decl = node ? findEnclosingDeclaration(node) : void 0;
    if (decl) {
      raw.push({
        path: repoRelPath,
        start: decl.getStartLineNumber(),
        end: decl.getEndLineNumber(),
        symbol: describe(decl)
      });
    } else {
      raw.push({ path: repoRelPath, start: line, end: line, symbol: "(top-level)" });
    }
  }
  return mergeRanges(raw);
}
function findEnclosingDeclaration(node) {
  let found;
  let cursor = node;
  while (cursor) {
    if (DECLARATION_KINDS.has(cursor.getKind())) found = cursor;
    cursor = cursor.getParent();
  }
  return found;
}
function describe(decl) {
  if (import_ts_morph.Node.isNameable(decl) || import_ts_morph.Node.isNamed(decl)) {
    const name = decl.getName?.();
    if (name) return name;
  }
  const varDecl = decl.getFirstAncestorByKind(import_ts_morph.SyntaxKind.VariableDeclaration);
  if (varDecl) return varDecl.getName();
  return `${decl.getKindName()}@${decl.getStartLineNumber()}`;
}
function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort(
    (a, b) => a.path.localeCompare(b.path) || a.start - b.start || a.end - b.end
  );
  const out = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.path === r.path && r.start <= prev.end + 1) {
      if (r.end > prev.end) prev.end = r.end;
      if (!prev.symbol.split(", ").includes(r.symbol)) {
        prev.symbol = `${prev.symbol}, ${r.symbol}`;
      }
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
function toStrykerMutateArgs(ranges) {
  return ranges.map((r) => `${r.path}:${r.start}-${r.end}`);
}
function safePosOfLine(compilerNode, line) {
  try {
    return compilerNode.getPositionOfLineAndCharacter(line - 1, 0);
  } catch {
    return null;
  }
}

// src/pipeline.ts
async function runPipeline(opts) {
  const { repoRoot, diff, provider } = opts;
  const log = opts.log ?? (() => {
  });
  const changed = parseUnifiedDiff(diff).filter((f) => isMutableSource(f.path));
  if (changed.length === 0) {
    return { status: "no-changes", ranges: [] };
  }
  const project = createProject(tsconfigOf(repoRoot));
  const ranges = [];
  for (const file of changed) {
    const abs = (0, import_node_path5.join)(repoRoot, file.path);
    if (!(0, import_node_fs6.existsSync)(abs)) continue;
    ranges.push(...resolveMutateRanges(project, abs, file.path, file.changedLines));
  }
  if (ranges.length === 0) {
    return { status: "no-ranges", ranges: [] };
  }
  log(`\uB300\uC0C1 \uBC94\uC704 ${ranges.length}\uAC1C:`);
  for (const r of ranges) log(`  ${r.path}:${r.start}-${r.end}  (${r.symbol})`);
  const testRunner = detectTestRunner(repoRoot);
  const ensured = await ensureStryker(repoRoot, testRunner);
  if (ensured.installed) {
    log(`Stryker \uB7F0\uD0C0\uC784 \uC124\uCE58 (--no-save): ${ensured.packages.join(", ")}`);
  }
  const strykerResult = await runStryker({
    repoRoot,
    mutate: toStrykerMutateArgs(ranges),
    testRunner,
    runnerConfigFile: opts.runnerConfig,
    concurrency: opts.concurrency
  });
  if (!strykerResult.ok) {
    return {
      status: "stryker-failed",
      ranges,
      error: `Stryker \uC2E4\uD589 \uC2E4\uD328 (exit ${strykerResult.exitCode})
${strykerResult.stderr.slice(-2e3)}`
    };
  }
  const scan = scanReport(strykerResult.report, {
    suspectedEquivalents: loadEquivalents(repoRoot)
  });
  const { stats } = scan;
  log(
    `\uBBA4\uD14C\uC774\uC158 \uC2A4\uCF54\uC5B4 ${stats.mutationScore.toFixed(2)}%  (\uC804\uCCB4 ${stats.total} / \uD0AC ${stats.killed} / \uC0DD\uC874 ${stats.survived} / \uCEE4\uBC84\uB9AC\uC9C0\uC5C6\uC74C ${stats.noCoverage} / \uD0C0\uC784\uC544\uC6C3 ${stats.timeout})`
  );
  log(`\uD6C4\uBCF4 \uBBA4\uD134\uD2B8 ${scan.candidates.length}\uAC1C`);
  for (const [reason, n] of countBy(scan.filtered.map((f) => f.reason))) {
    log(`  \uC81C\uC678 ${reason}: ${n}\uAC1C`);
  }
  writeWorkFile(repoRoot, "candidates.json", scan);
  if (!provider) {
    return { status: "scanned", ranges, scan };
  }
  const targets = scan.candidates.slice(0, opts.maxMutants ?? 5);
  if (targets.length < scan.candidates.length) {
    log(`\uD6C4\uBCF4 ${scan.candidates.length}\uAC1C \uC911 \uC0C1\uC704 ${targets.length}\uAC1C\uB9CC \uCC98\uB9AC\uD569\uB2C8\uB2E4.`);
  }
  log(`\uD14C\uC2A4\uD2B8 \uC0DD\uC131 \uC2DC\uC791 (provider=${provider.name})`);
  const results = [];
  for (const mutant of targets) {
    const r = await generateKillingTest(mutant, {
      repoRoot,
      runner: testRunner,
      provider,
      configFile: opts.runnerConfig,
      maxAttempts: opts.maxAttempts ?? 2
    });
    results.push(r);
    const label = `[${mutant.mutatorName}] ${mutant.path}:${mutant.line}`;
    if (r.accepted) {
      log(`  \u2705 ${label} \u2014 ${r.attempts.length}\uD68C \uC2DC\uB3C4\uB9CC\uC5D0 \uCC44\uD0DD`);
    } else {
      const why = r.error ?? r.attempts[r.attempts.length - 1]?.rejectedAt ?? "unknown";
      log(`  \u274C ${label} \u2014 \uD3D0\uAE30 (${why})`);
    }
  }
  const summary = summarize(results);
  log(`\uCC44\uD0DD ${summary.accepted}/${summary.total} (LLM \uD638\uCD9C ${summary.totalAttempts}\uD68C)`);
  for (const [reason, n] of Object.entries(summary.rejectedBy)) {
    log(`  \uD3D0\uAE30 ${reason}: ${n}\uAC1C`);
  }
  writeWorkFile(repoRoot, "generated.json", { results, summary });
  return { status: "generated", ranges, scan, results, summary };
}
function countBy(items) {
  const map = /* @__PURE__ */ new Map();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return [...map.entries()];
}
function writeWorkFile(repoRoot, name, data) {
  const dir = (0, import_node_path5.join)(repoRoot, WORK_DIR);
  (0, import_node_fs6.mkdirSync)(dir, { recursive: true });
  (0, import_node_fs6.writeFileSync)((0, import_node_path5.join)(dir, name), JSON.stringify(data, null, 2));
}
function loadEquivalents(repoRoot) {
  const path = (0, import_node_path5.join)(repoRoot, WORK_DIR, "equivalents.json");
  if (!(0, import_node_fs6.existsSync)(path)) return /* @__PURE__ */ new Set();
  try {
    const raw = JSON.parse((0, import_node_fs6.readFileSync)(path, "utf8"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function tsconfigOf(repoRoot) {
  const p = (0, import_node_path5.join)(repoRoot, "tsconfig.json");
  return (0, import_node_fs6.existsSync)(p) ? p : void 0;
}

// src/report.ts
function renderReport(result) {
  const lines = ["## \u{1F9EC} MutantHunter"];
  switch (result.status) {
    case "no-changes":
      return [...lines, "", "\uBBA4\uD14C\uC774\uC158 \uB300\uC0C1 \uC18C\uC2A4 \uBCC0\uACBD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."].join("\n");
    case "no-ranges":
      return [...lines, "", "\uBCC0\uACBD\uB41C \uC904\uC744 \uAC10\uC2F8\uB294 \uBBA4\uD14C\uC774\uC158 \uBC94\uC704\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."].join("\n");
    case "stryker-failed":
      return [
        ...lines,
        "",
        "\u26A0\uFE0F \uBBA4\uD14C\uC774\uC158 \uC2E4\uD589\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.",
        "",
        "```",
        (result.error ?? "").slice(-1500),
        "```"
      ].join("\n");
    default:
      break;
  }
  const scan = result.scan;
  if (!scan) return [...lines, "", "\uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."].join("\n");
  const s = scan.stats;
  lines.push(
    "",
    `**\uBBA4\uD14C\uC774\uC158 \uC2A4\uCF54\uC5B4 ${s.mutationScore.toFixed(1)}%** \u2014 \uBBA4\uD134\uD2B8 ${s.total}\uAC1C \uC911 ${s.killed}\uAC1C\uB97C \uAE30\uC874 \uD14C\uC2A4\uD2B8\uAC00 \uC7A1\uC558\uC2B5\uB2C8\uB2E4.`,
    "",
    `| | |`,
    `|---|---|`,
    `| \uAC80\uC0AC\uD55C \uBC94\uC704 | ${result.ranges.length}\uAC1C |`,
    `| \uC0B4\uC544\uB0A8\uC740 \uBBA4\uD134\uD2B8 | ${s.survived}\uAC1C |`,
    `| \uCEE4\uBC84\uB9AC\uC9C0 \uC5C6\uC74C | ${s.noCoverage}\uAC1C |`,
    `| \uC81C\uC548 \uD6C4\uBCF4 | ${scan.candidates.length}\uAC1C |`
  );
  const filtered = countBy(scan.filtered.map((f) => f.reason));
  if (filtered.length > 0) {
    lines.push(
      "",
      "<details><summary>\uD544\uD130\uB85C \uC81C\uC678\uD55C \uBBA4\uD134\uD2B8</summary>",
      "",
      ...filtered.map(([reason, n]) => `- \`${reason}\`: ${n}\uAC1C`),
      "",
      "</details>"
    );
  }
  const accepted = (result.results ?? []).filter((r) => r.accepted);
  if (result.status === "scanned") {
    lines.push("", "\uD14C\uC2A4\uD2B8 \uC0DD\uC131\uC740 \uC2E4\uD589\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    return lines.join("\n");
  }
  if (accepted.length === 0) {
    lines.push(
      "",
      "### \uC81C\uC548\uD560 \uD14C\uC2A4\uD2B8\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4",
      "",
      "\uC0DD\uC131\uD55C \uD14C\uC2A4\uD2B8\uAC00 \uBAA8\uB450 \uAC80\uC99D \uAC8C\uC774\uD2B8\uB97C \uD1B5\uACFC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC99D\uBA85\uD558\uC9C0 \uBABB\uD55C \uAC83\uC740 \uC81C\uC548\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
    );
  } else {
    lines.push("", `### \uC81C\uC548 ${accepted.length}\uAC74`, "");
    for (const r of accepted) {
      const m = r.mutant;
      lines.push(
        `<details><summary><code>${m.path}:${m.line}</code> \u2014 ${m.mutatorName}</summary>`,
        "",
        `\uC774 \uCF54\uB4DC\uB97C \uC544\uB798\uCC98\uB7FC \uBC14\uAFD4\uB3C4 **\uC5B4\uB5A4 \uD14C\uC2A4\uD2B8\uB3C4 \uC2E4\uD328\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.**`,
        "",
        "```diff",
        `- ${oneLine(m.original)}`,
        `+ ${oneLine(m.replacement)}`,
        "```",
        "",
        `\uC544\uB798 \uD14C\uC2A4\uD2B8\uB294 \uC6D0\uBCF8\uC5D0\uC11C \uD1B5\uACFC\uD558\uACE0 \uC704 \uBCC0\uD615\uC5D0\uC11C \uC2E4\uD328\uD558\uB294 \uAC83\uC744 \uD655\uC778\uD588\uC2B5\uB2C8\uB2E4.`,
        "",
        `\`${r.testFileRel}\``,
        "",
        "```ts",
        r.testSource ?? "",
        "```",
        "",
        "</details>",
        ""
      );
    }
  }
  const summary = result.summary;
  if (summary) {
    const rejected = Object.entries(summary.rejectedBy);
    lines.push(
      "",
      `<sub>\uBBA4\uD134\uD2B8 ${summary.total}\uAC1C\uC5D0 \uB300\uD574 LLM \uD638\uCD9C ${summary.totalAttempts}\uD68C, ${summary.accepted}\uAC74 \uCC44\uD0DD` + (rejected.length ? `, \uD3D0\uAE30 ${rejected.map(([k, n]) => `${k} ${n}`).join(" / ")}` : "") + ".</sub>"
    );
  }
  return lines.join("\n");
}
function oneLine(s) {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}\u2026` : flat;
}

// src/action.ts
async function run() {
  const env = process.env;
  const repoRoot = env["GITHUB_WORKSPACE"] ?? process.cwd();
  const pr = readPullRequestContext(env);
  const base = getInput("base") || pr.baseSha;
  const head = getInput("head") || pr.headSha || "HEAD";
  if (!base) {
    console.log("base\uB97C \uC54C \uC218 \uC5C6\uC2B5\uB2C8\uB2E4 (pull_request \uC774\uBCA4\uD2B8\uAC00 \uC544\uB2CC \uB4EF). \uAC74\uB108\uB701\uB2C8\uB2E4.");
    return;
  }
  const diff = gitDiff(repoRoot, base, head);
  const wantGenerate = getBooleanInput("generate");
  const provider = wantGenerate ? providerFromEnv() : void 0;
  if (wantGenerate && !provider) {
    console.log(
      "API \uD0A4\uAC00 \uC5C6\uC5B4 \uC2A4\uCE94\uB9CC \uC218\uD589\uD569\uB2C8\uB2E4 (MH_API_KEY \uB610\uB294 GEMINI_API_KEY \uB97C \uC124\uC815\uD558\uC138\uC694)."
    );
  }
  const result = await runPipeline({
    repoRoot,
    diff,
    provider,
    runnerConfig: getInput("runner-config") || void 0,
    concurrency: getNumberInput("concurrency"),
    maxMutants: getNumberInput("max-mutants"),
    maxAttempts: getNumberInput("max-attempts"),
    log: (m) => console.log(m)
  });
  const report = renderReport(result);
  writeStepSummary(report, env);
  setOutput("status", result.status, env);
  setOutput("candidates", String(result.scan?.candidates.length ?? 0), env);
  setOutput("accepted", String(result.summary?.accepted ?? 0), env);
  setOutput(
    "mutation-score",
    (result.scan?.stats.mutationScore ?? 0).toFixed(2),
    env
  );
  await maybeComment(report, result.status, env, pr.number);
  if (result.status === "stryker-failed") {
    console.error(result.error);
    process.exitCode = 1;
  }
}
async function maybeComment(body, status, env, prNumber) {
  const token = getInput("github-token", env);
  if (!token || !prNumber) return;
  if (status === "no-changes" || status === "no-ranges") return;
  const repo = splitRepo(env["GITHUB_REPOSITORY"] ?? "");
  if (!repo) return;
  const res = await postPullRequestComment({
    token,
    owner: repo.owner,
    repo: repo.repo,
    prNumber,
    body
  });
  if (!res.ok) {
    console.log(`PR \uCF54\uBA58\uD2B8 \uC2E4\uD328 (${res.status}): ${res.detail ?? ""}`);
  }
}
function gitDiff(repoRoot, base, head) {
  return (0, import_node_child_process3.execFileSync)(
    "git",
    ["diff", "--unified=0", "--no-color", `${base}...${head}`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
}
run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
