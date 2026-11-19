// gta6-trophy-rarity-forecast-01 — @roni-rockabilly entry.
// Forecast, for every GTA VI PS5 trophy, its Exophase earn rate at the case
// target, as five quantiles (0.05/0.25/0.5/0.75/0.95) scored by mean pinball
// loss on the logit scale. Node 22, standard library only, no network,
// deterministic (two runs byte-identical).
//
// Model (two regimes, picked from the case data itself):
//  1. FLAT history (every read identical) + short horizon: the page has not
//     refreshed yet, so the target sits just after Exophase's first refresh.
//     RULES.txt discloses that refresh: 638 -> 3,868 players tracked, every
//     rate but the 100% one lower. Earners barely move across one refresh
//     (the new profiles are fresh players), so the median is the frozen
//     earner count over the refreshed player count; the 100% trophy stays
//     100% (every new profile earns it too). Spread covers +-1 earner and a
//     possible second refresh before the target.
//  2. RICH history (reads move): decompose rate = earners / players and
//     extrapolate both, then average with a direct trend fit in logit space.
//       - Players: grid-fit P(t) = P_inf * (t/(t+tau))^gamma on log players.
//         This is the launch-surge shape (explosive early syncing, then
//         saturating); a log-linear fit overshoots the target player count
//         by ~35% on simulated finals and drags every median down with it.
//       - Earners: per trophy, log(earners) linear in ln(1 + hours since
//         release) over the last 36h, slope shrunk 25% toward the median
//         slope of its description class (story / early-activity / grind /
//         other). Earners never shrink.
//       - Direct trend: logit(rate) linear in ln(1 + hours) over the same
//         window (the house curve baseline's shape).
//       - Median = geometric mean of the two forecasts (55% decomposition,
//         45% direct trend): each errs in different directions when the
//         denominator jumps, so the average is stabler than either.
//     Spread grows with horizon and with the worse of the two fits'
//     residuals, slightly wider down (a late sync wave can still dilute
//     rates; earners stalling is the same direction).
//  The near-universal trophy (last rate >= 99.5%): forecast from its
//  lacker share, which grows like sqrt(players growth), tight band.
//
// Nothing here is tuned on the practice answers: the practice history is
// perfectly flat, so it carries no slope signal at all (RULES says the same).
// The trend regime was validated on simulated final-like cases calibrated on
// the two real snapshots (launch night + the live Exophase page 19 Nov
// 13:17 UTC): it beats both house baselines there (sim loss ~0.15 vs ~0.31
// for the house trend and ~0.83 for persistence), and still wins under a
// 1.8x post-cutoff player surge or 0.6x progression.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Release instant: GTA VI launched 2026-11-19 (game.release_date). */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** First Exophase refresh disclosed in RULES.txt: players 638 -> 3868. */
const FIRST_REFRESH_PLAYERS = 3868;
const FIRST_REFRESH_BASE = 638;
/** Spread (logit) of the flat-history refresh forecast. */
const FLAT_SPREAD = 0.22;
/** Random-walk spread per sqrt(day) in the trend regime. */
const TREND_SIGMA = 0.2;
/** Floor on the trend-regime spread (logit). */
const SPREAD_FLOOR = 0.2;
/** Weight of the earners/players decomposition in the median ensemble. */
const W_DECOMP = 0.55;
/** Shrinkage of each trophy's earner slope toward its class median. */
const SHRINK = 0.25;
/** Fit window for the earner/rate trends, in hours before the checkpoint. */
const WINDOW_H = 36;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}
interface Case {
  levels: number[];
  horizon_minutes: number;
  at: string;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const hoursSinceRelease = (iso: string): number =>
  Math.max(0, (Date.parse(iso) - RELEASE_MS) / 3600000);

/** Description class: story / early-activity / grind / other. Drives slope shrinkage. */
function klass(t: Trophy): string {
  const d = t.description;
  if (/Complete Chapter|Complete the final mission|Complete (Breakfast Run|The Cartel Heist|Child's Play|Headliners|VCIA Takedown|Operation Savage Glory)/.test(d)) return 'story';
  if (/Complete Gone Fishing|Beat Cal|Complete an arcade game/.test(d)) return 'early';
  if (/250 Stunts|100% Completion|100 locations|100 vehicles|50 Challenges|20 different races|8 mission strands|3 Collectible Card sets|every spot|every location|Explore all/.test(d)) return 'grind';
  return 'other';
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Least squares y ~ a + b*x. Returns [a, b, residStd]. */
function ols(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - (a + b * xs[i])) ** 2;
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return [a, b, resid];
}

/**
 * Grid-fit the saturating player curve P(t) = P_inf * (t/(t+tau))^gamma on
 * log players, with a free log-intercept shift. Returns a function giving
 * the fitted players at any hour since release. Deterministic grid order.
 */
function fitPlayers(rows: Read[]): (tHours: number) => number {
  const xs = rows.map((r) => hoursSinceRelease(r.at));
  const ys = rows.map((r) => Math.log(Math.max(1, r.players_tracked)));
  const pLast = rows[rows.length - 1].players_tracked;
  let best: { sse: number; tau: number; g: number; pinf: number; c: number } | null = null;
  for (const tau of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    for (const g of [0.5, 1, 2, 3, 4, 6, 8, 12]) {
      for (const mult of [1.05, 1.2, 1.5, 2, 3, 5, 10, 20]) {
        const pinf = pLast * mult;
        let cSum = 0;
        const pred: number[] = [];
        for (let j = 0; j < xs.length; j++) {
          const t = Math.max(xs[j], 0.01);
          const p = Math.log(pinf) + g * (Math.log(t) - Math.log(t + tau));
          pred.push(p);
          cSum += ys[j] - p;
        }
        const c = cSum / xs.length;
        let sse = 0;
        for (let j = 0; j < xs.length; j++) sse += (ys[j] - (pred[j] + c)) ** 2;
        if (best === null || sse < best.sse) best = { sse, tau, g, pinf, c };
      }
    }
  }
  const b = best as NonNullable<typeof best>;
  return (tHours: number): number => {
    const t = Math.max(tHours, 0.01);
    return Math.exp(Math.log(b.pinf) + b.g * (Math.log(t) - Math.log(t + b.tau)) + b.c);
  };
}

/** Quantile row from a median (percent) and a logit spread (symmetric). */
function rowFromMedianSpread(medPct: number, spread: number, id: number): { id: number; q: number[] } {
  const l = logit(medPct);
  const q = Z.map((z) => round4(Math.min(100, Math.max(0, invLogit(l + z * spread)))));
  for (let i = 1; i < q.length; i++) if (q[i] < q[i - 1]) q[i] = q[i - 1];
  return { id, q };
}

function forecast(c: Case): Array<{ id: number; q: number[] }> {
  const last = c.history[c.history.length - 1];
  const lastRates = last.rates;
  const horizonDays = c.horizon_minutes / 1440;

  // --- Regime detection: is the history perfectly flat? ---
  let flat = true;
  for (const r of c.history) {
    if (r.players_tracked !== last.players_tracked) { flat = false; break; }
    for (let i = 0; i < r.rates.length; i++) {
      if (r.rates[i] !== lastRates[i]) { flat = false; break; }
    }
    if (!flat) break;
  }

  if (flat) {
    // --- Flat regime: first-refresh dilution (see header comment). ---
    const p0 = last.players_tracked;
    const pT = p0 > 0 ? (FIRST_REFRESH_PLAYERS / FIRST_REFRESH_BASE) * p0 : FIRST_REFRESH_PLAYERS;
    return c.trophies.map((t, i) => {
      const r = lastRates[i] ?? 0;
      if (r >= 99.99) {
        // The universal trophy: every new profile earns it too.
        return { id: t.id, q: [99.99, 99.995, 100, 100, 100].map(round4) };
      }
      const earners = Math.max(0, Math.round((r * p0) / 100));
      const med = Math.max(0.01, (100 * earners) / pT);
      return rowFromMedianSpread(med, FLAT_SPREAD, t.id);
    });
  }

  // --- Trend regime: earners/players decomposition + direct trend ensemble. ---
  const targetHours = hoursSinceRelease(c.target);
  const targetX = Math.log1p(targetHours);
  const cutMs = Date.parse(c.at) - WINDOW_H * 3600000;
  const recent = c.history.filter((r) => Date.parse(r.at) >= cutMs);
  const rows = recent.length >= 3 ? recent : c.history;
  const xs = rows.map((r) => Math.log1p(hoursSinceRelease(r.at)));

  // Players: saturating grid fit over the history after the first refresh.
  // (The flat launch-night head, players stuck at the first count before
  // Exophase's first refresh, would drag the curve's early end down, so the
  // fit starts at the first read whose player count moved.)
  let pStart = 0;
  while (pStart < c.history.length - 1 && c.history[pStart + 1].players_tracked === c.history[0].players_tracked) pStart++;
  const pRows = c.history.slice(pStart);
  const pFit = fitPlayers(pRows.length >= 3 ? pRows : c.history);
  const pHat = Math.max(pFit(targetHours), last.players_tracked);
  const pGrowth = pHat / Math.max(1, last.players_tracked);

  // Per-trophy earner + direct-rate fits, then class-median slope shrinkage.
  const slopes: Record<string, number[]> = {};
  const fits: Array<{ aE: number; bE: number; resE: number; aR: number; bR: number; resR: number }> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const es: number[] = [];
    const xx: number[] = [];
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j].rates[i];
      if (r === null || r === undefined) continue;
      es.push(Math.log(Math.max(0.5, (r * rows[j].players_tracked) / 100)));
      xx.push(xs[j]);
    }
    const ys = rows.map((r) => logit(r.rates[i] ?? 0));
    const [aR, bR, resR] = ols(xs, ys);
    let aE: number;
    let bE: number;
    let resE: number;
    if (xx.length >= 3) {
      [aE, bE, resE] = ols(xx, es);
    } else {
      const r = lastRates[i] ?? 0;
      aE = Math.log(Math.max(0.5, (r * last.players_tracked) / 100));
      bE = 0;
      resE = 0.5;
    }
    fits.push({ aE, bE, resE, aR, bR, resR });
    const k = klass(c.trophies[i]);
    (slopes[k] ??= []).push(bE);
  }
  const classSlope: Record<string, number> = {};
  for (const k of Object.keys(slopes)) classSlope[k] = median(slopes[k]);

  return c.trophies.map((t, i) => {
    const f = fits[i];
    const rLast = lastRates[i] ?? 0;
    // The near-universal trophy: forecast from its lacker share.
    if (rLast >= 99.5) {
      const lackers = Math.max(0.01, 100 - rLast) * Math.sqrt(Math.max(1, pGrowth));
      const med = Math.min(99.99, Math.max(99.0, 100 - lackers));
      return rowFromMedianSpread(med, 0.5, t.id);
    }
    const k = klass(t);
    const bE = Math.max(0, (1 - SHRINK) * f.bE + SHRINK * (classSlope[k] ?? f.bE));
    const eHat = Math.exp(f.aE + bE * targetX);
    const medDecomp = (100 * eHat) / pHat;
    const medTrend = invLogit(f.aR + f.bR * targetX);
    const med = Math.min(
      99.99,
      Math.max(0.01, Math.exp(W_DECOMP * Math.log(Math.max(0.01, medDecomp)) + (1 - W_DECOMP) * Math.log(Math.max(0.01, medTrend)))),
    );
    const spread = Math.max(
      SPREAD_FLOOR,
      Math.sqrt(Math.max(f.resE, f.resR) ** 2 + (TREND_SIGMA * Math.sqrt(horizonDays)) ** 2),
    );
    const l = logit(med);
    const ss = [spread * 1.15, spread * 1.15, spread, spread * 0.95, spread * 0.95];
    const q = Z.map((z, j) => round4(Math.min(100, Math.max(0, invLogit(l + z * ss[j])))));
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecast(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
