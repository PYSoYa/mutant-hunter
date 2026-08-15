import type { Cohort, Dashboard, Point } from "./data.js";

/**
 * 자기완결 HTML 하나를 만든다.
 *
 * 외부 라이브러리를 쓰지 않는다. GitHub Pages에서도, 파일을 그냥 열어도,
 * 네트워크가 없어도 똑같이 보여야 한다. 차트는 인라인 SVG로 그린다.
 */
export function renderDashboard(data: Dashboard, generatedAt: string): string {
  return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<title>MutantHunter — 측정 대시보드</title>
<style>${STYLE}</style>
<body>
<header>
  <h1>🧬 MutantHunter 측정 대시보드</h1>
  <p class="sub">평가 실행 ${data.totalRuns}건 · ${escape(generatedAt)}</p>
</header>

<section class="note">
  <strong>이 대시보드는 잡음 폭을 함께 그린다.</strong>
  채택률만 그리면 흔들림을 효과로 읽게 된다. 실제로 그 실수를 했고,
  같은 조건 4회 반복에서 채택 수가 5~7로 움직인다는 것을 확인한 뒤에야
  앞선 A/B 판정 두 개를 철회할 수 있었다.
  <br><br>
  회색 띠 안의 변화는 <strong>효과라고 주장할 수 없다.</strong>
</section>

${data.cohorts.map(renderCohort).join("\n")}

${
  data.scanOnly.length > 0
    ? `<section class="skipped">
  <h3>비교 대상이 아닌 실행 ${data.scanOnly.length}건</h3>
  <p>생성 단계를 돌리지 않아 채택률이 없다. 0으로 그리면 평균이 오염된다.</p>
  <p class="mono">${data.scanOnly.map(escape).join(", ")}</p>
</section>`
    : ""
}
</body>
</html>`;
}

function renderCohort(cohort: Cohort): string {
  const floor = cohort.measuredNoisePp ?? cohort.resolutionPp;
  const floorLabel = cohort.measuredNoisePp
    ? `반복 측정으로 관측된 흔들림 ±${floor.toFixed(2)}%p`
    : `최소 눈금 ±${floor.toFixed(2)}%p (뮤턴트 1건). 반복 측정이 없어 실제 잡음은 더 클 수 있다`;

  return `<section class="cohort">
  <h2>뮤턴트 ${cohort.attempted}개 · ${escape(cohort.provider ?? "provider 미기록")}</h2>
  <p class="floor">${floorLabel}</p>
  ${chart(cohort)}
  <table>
    <thead><tr><th>실행</th><th>채택</th><th>채택률</th><th>API 호출</th><th>게이트 폐기</th></tr></thead>
    <tbody>
      ${cohort.points.map((p) => row(p)).join("\n      ")}
    </tbody>
  </table>
</section>`;
}

function row(p: Point): string {
  const gates = Object.entries(p.gateRejections)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${escape(k)} ${n}`)
    .join(" / ");
  return `<tr>
        <td class="mono">${escape(p.label)}</td>
        <td>${p.accepted}/${p.attempted}</td>
        <td><strong>${p.acceptRate.toFixed(1)}%</strong></td>
        <td>${p.apiCalls}</td>
        <td class="dim">${gates || "—"}</td>
      </tr>`;
}

const W = 720;
const H = 220;
const PAD = { l: 48, r: 16, t: 16, b: 44 };

function chart(cohort: Cohort): string {
  const pts = cohort.points;
  if (pts.length === 0) return "";

  const rates = pts.map((p) => p.acceptRate);
  const floor = cohort.measuredNoisePp ?? cohort.resolutionPp;
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;

  const lo = Math.max(0, Math.min(...rates, mean - floor) - 4);
  const hi = Math.min(100, Math.max(...rates, mean + floor) + 4);
  const span = hi - lo || 1;

  const x = (i: number) =>
    PAD.l + (pts.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (pts.length - 1));
  const y = (v: number) => PAD.t + ((hi - v) / span) * (H - PAD.t - PAD.b);

  // 잡음 띠 — 평균을 중심으로 ±floor. 이 안의 변화는 판정할 수 없다.
  const bandTop = y(Math.min(hi, mean + floor));
  const bandBottom = y(Math.max(lo, mean - floor));

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.acceptRate).toFixed(1)}`).join(" ");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="채택률 추이와 잡음 폭">
    <rect x="${PAD.l}" y="${bandTop.toFixed(1)}" width="${W - PAD.l - PAD.r}"
          height="${Math.max(1, bandBottom - bandTop).toFixed(1)}" class="band"/>
    <line x1="${PAD.l}" y1="${y(mean).toFixed(1)}" x2="${W - PAD.r}" y2="${y(mean).toFixed(1)}" class="mean"/>
    <text x="6" y="${(y(hi) + 4).toFixed(1)}" class="axis">${hi.toFixed(0)}%</text>
    <text x="6" y="${(y(lo) + 4).toFixed(1)}" class="axis">${lo.toFixed(0)}%</text>
    <path d="${line}" class="line"/>
    ${pts
      .map(
        (p, i) =>
          `<circle cx="${x(i).toFixed(1)}" cy="${y(p.acceptRate).toFixed(1)}" r="4" class="dot"><title>${escape(p.label)}: ${p.acceptRate.toFixed(1)}%</title></circle>`,
      )
      .join("")}
    ${pts
      .map(
        (p, i) =>
          `<text x="${x(i).toFixed(1)}" y="${H - 14}" class="tick" text-anchor="middle">${escape(shorten(p.label))}</text>`,
      )
      .join("")}
  </svg>`;
}

function shorten(label: string): string {
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

function escape(s: string): string {
  return s
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;");
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 15px/1.6 -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
       max-width: 820px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 0 0 2px; }
.sub, .floor { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
.note { border-left: 3px solid #a78bfa; padding: 12px 16px; margin: 24px 0 32px;
        background: color-mix(in srgb, #a78bfa 8%, transparent); border-radius: 0 6px 6px 0; }
.cohort { margin: 0 0 44px; }
svg { width: 100%; height: auto; margin: 8px 0 12px; }
.band { fill: #9ca3af; opacity: .22; }
.mean { stroke: #9ca3af; stroke-dasharray: 4 4; stroke-width: 1; }
.line { fill: none; stroke: #7c3aed; stroke-width: 2; }
.dot { fill: #7c3aed; }
.axis, .tick { fill: #6b7280; font-size: 11px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb44; }
th { color: #6b7280; font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dim { color: #6b7280; }
.skipped { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e7eb44; color: #6b7280; font-size: 13px; }
.skipped h3 { font-size: 14px; margin: 0 0 6px; color: inherit; }
`;
