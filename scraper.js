#!/usr/bin/env node
/* 춘천마라톤 기록 수집.
   공개 API(/api/event/..)가 2026-10-25 기준 401 "API key required" 로 막혀서,
   SSR 페이지에 박힌 window.__NUXT__ 페이로드를 읽는다. */
const fs = require('fs');
const vm = require('vm');

const EVENT_ID = 176;
const CONCURRENCY = 6;
const TIMEOUT_MS = 12000;

const runners = JSON.parse(fs.readFileSync('data.json', 'utf8'))
  .map(r => ({ name: r.name, bib: String(r.bib) }));

const prev = Object.fromEntries(
  JSON.parse(fs.readFileSync('data.json', 'utf8')).map(r => [String(r.bib), r]));

async function fetchPlayer(bib) {
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`https://myresult.co.kr/${EVENT_ID}/${bib}`, {
    signal: ctl,
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
      'Accept': 'text/html,*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const m = html.match(/window\.__NUXT__=([\s\S]*?);\s*<\/script>/);
  if (!m) throw new Error('__NUXT__ 없음');

  // 남의 사이트 코드를 돌리는 셈이라 빈 샌드박스에 가둔다. require/process/fs 접근 차단
  const data = vm.runInNewContext(`(${m[1]})`, Object.create(null), { timeout: 3000 });
  return data?.data?.[0]?.player ?? null;
}

// 통과한 지점 중 가장 먼 곳. created_at 이 그 지점을 지난 시각(UTC)이다
function readProgress(player) {
  const pts = (player?.records ?? [])
    .map(r => ({ km: parseFloat(r.point?.distance), at: r.created_at }))
    .filter(p => Number.isFinite(p.km) && p.at);
  if (!pts.length) return null;

  const start = pts.reduce((a, b) => (b.km < a.km ? b : a));
  const last = pts.reduce((a, b) => (b.km > a.km ? b : a));
  if (last.km <= 0) return { km: 0, at: null, pace: null };

  // 출발부터 마지막 지점까지의 평균 페이스 (초/km). 구간 사이를 메우는 데 쓴다
  const elapsed = (new Date(last.at) - new Date(start.at)) / 1000;
  const pace = elapsed > 0 ? +(elapsed / last.km).toFixed(1) : null;
  return { km: last.km, at: last.at, pace };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch { out[k] = null; }
    }
  }));
  return out;
}

(async () => {
  const got = await pool(runners, CONCURRENCY, async r => readProgress(await fetchPlayer(r.bib)));

  let ok = 0;
  const next = runners.map((r, i) => {
    const old = prev[r.bib] ?? {};
    const cur = got[i];
    if (!cur) return { name: r.name, bib: r.bib, km: old.km ?? 0, at: old.at ?? null, pace: old.pace ?? null };
    ok++;
    // 뒤로 가지 않는다. 한 번 지난 지점은 통신이 끊겨도 유지한다
    if ((old.km ?? 0) > cur.km) return { name: r.name, bib: r.bib, km: old.km, at: old.at ?? null, pace: old.pace ?? null };
    return { name: r.name, bib: r.bib, km: cur.km, at: cur.at, pace: cur.pace };
  });

  fs.writeFileSync('data.json', JSON.stringify(next, null, 2) + '\n');
  console.error(`수집 ${ok}/${runners.length}  선두 ${Math.max(...next.map(r => r.km))}km`);
})();
