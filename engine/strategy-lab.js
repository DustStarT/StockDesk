/**
 * StockDesk v1.6 · 策略实验室 + 自适应策略推荐
 *
 * 目标：把“当前看起来像买点”变成可重放、可比较、可解释的历史策略。
 * - 只使用当时已经收盘的数据生成信号，统一在下一交易日开盘执行，避免未来函数。
 * - 止损/止盈使用当日 OHLC 触发；若同一天上下边界都触及，按更保守的止损优先处理。
 * - 回测默认一只股票、单仓位、不加杠杆；成本包含双边手续费/滑点近似。
 *
 * 注意：这是研究型回测，不代表可成交价格，也不构成投资建议。
 */

import { analyzeDaily, analyzeSignals } from "./indicators.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d = 2) => finite(v) ? Number(v.toFixed(d)) : null;

export const STRATEGY_PRESETS = {
  trend_breakout: {
    id: "trend_breakout",
    name: "趋势突破",
    description: "趋势已经形成，接近/突破20日高点且量能确认时介入。",
    entryScore: 30,
    minTrend: 35,
    minMomentum: 12,
    minVolume: 8,
    maxRisk: 72,
    minVolRatio: 1.10,
    breakoutWithinPct: -1.5,
    requireAboveMa20: true,
    stopLossPct: 6,
    takeProfitPct: 16,
    trailingStopPct: 8,
    maxHoldDays: 20,
    exitScore: -12,
    feeBps: 3,
    slippageBps: 4,
  },
  trend_pullback: {
    id: "trend_pullback",
    name: "趋势回踩",
    description: "保持中期多头，只在价格回到MA20附近、风险不过热时介入。",
    entryScore: 18,
    minTrend: 30,
    minMomentum: 0,
    minVolume: -35,
    maxRisk: 58,
    minVolRatio: 0,
    requireAboveMa20: false,
    ma20MinPct: -2.5,
    ma20MaxPct: 5.0,
    rsiMin: 42,
    rsiMax: 68,
    stopLossPct: 5,
    takeProfitPct: 12,
    trailingStopPct: 6,
    maxHoldDays: 15,
    exitScore: -15,
    feeBps: 3,
    slippageBps: 4,
  },
  momentum: {
    id: "momentum",
    name: "动量强化",
    description: "偏重20/60日动量和量价共振，容忍更高波动，适合强势阶段。",
    entryScore: 26,
    minTrend: 20,
    minMomentum: 32,
    minVolume: 5,
    maxRisk: 78,
    minVolRatio: 1.15,
    minRet20: 2,
    requireAboveMa20: true,
    stopLossPct: 7,
    takeProfitPct: 20,
    trailingStopPct: 9,
    maxHoldDays: 18,
    exitScore: -8,
    feeBps: 3,
    slippageBps: 5,
  },
  defensive: {
    id: "defensive",
    name: "稳健趋势",
    description: "提高趋势门槛并压低允许风险，信号更少，偏向控制回撤。",
    entryScore: 34,
    minTrend: 45,
    minMomentum: 10,
    minVolume: -15,
    maxRisk: 48,
    minVolRatio: 0,
    requireAboveMa20: true,
    ma20MaxPct: 9,
    rsiMax: 72,
    stopLossPct: 4.5,
    takeProfitPct: 11,
    trailingStopPct: 5,
    maxHoldDays: 25,
    exitScore: -18,
    feeBps: 3,
    slippageBps: 3,
  },
};

export function listStrategyPresets() {
  return Object.values(STRATEGY_PRESETS).map((x) => ({ ...x }));
}

export function normalizeStrategyConfig(input = {}) {
  const presetId = input.presetId || input.id || "trend_breakout";
  const base = STRATEGY_PRESETS[presetId] || STRATEGY_PRESETS.trend_breakout;
  const c = { ...base, ...input, presetId };
  const num = (k, lo, hi, fallback) => {
    const v = Number(c[k]);
    c[k] = finite(v) ? clamp(v, lo, hi) : fallback;
  };
  num("entryScore", -20, 90, base.entryScore);
  num("minTrend", -100, 100, base.minTrend);
  num("minMomentum", -100, 100, base.minMomentum);
  num("minVolume", -100, 100, base.minVolume);
  num("maxRisk", 10, 100, base.maxRisk);
  num("minVolRatio", 0, 5, base.minVolRatio || 0);
  num("stopLossPct", 0, 30, base.stopLossPct);
  num("takeProfitPct", 0, 80, base.takeProfitPct);
  num("trailingStopPct", 0, 40, base.trailingStopPct || 0);
  num("maxHoldDays", 1, 120, base.maxHoldDays);
  num("exitScore", -90, 40, base.exitScore);
  num("feeBps", 0, 100, base.feeBps);
  num("slippageBps", 0, 100, base.slippageBps);
  if (c.ma20MinPct != null) num("ma20MinPct", -50, 50, base.ma20MinPct ?? -50);
  if (c.ma20MaxPct != null) num("ma20MaxPct", -50, 100, base.ma20MaxPct ?? 100);
  if (c.rsiMin != null) num("rsiMin", 0, 100, base.rsiMin ?? 0);
  if (c.rsiMax != null) num("rsiMax", 0, 100, base.rsiMax ?? 100);
  if (c.minRet20 != null) num("minRet20", -80, 200, base.minRet20 ?? -80);
  if (c.breakoutWithinPct != null) num("breakoutWithinPct", -30, 10, base.breakoutWithinPct ?? -30);
  c.requireAboveMa20 = c.requireAboveMa20 !== false;
  return c;
}

function factor(sig, key, fallback = 0) {
  const f = sig?.factors?.find((x) => x.key === key);
  return finite(f?.score) ? f.score : fallback;
}

function entryCheck(feature, cfg) {
  const { daily: d, signal: s } = feature || {};
  if (!d || !s) return { ok: false, failed: ["数据不足"] };
  const failed = [];
  const trend = factor(s, "trend");
  const momentum = factor(s, "momentum");
  const volume = factor(s, "volume");
  const risk = factor(s, "risk", 100);
  if (s.score < cfg.entryScore) failed.push(`综合分<${cfg.entryScore}`);
  if (trend < cfg.minTrend) failed.push(`趋势<${cfg.minTrend}`);
  if (momentum < cfg.minMomentum) failed.push(`动量<${cfg.minMomentum}`);
  if (volume < cfg.minVolume) failed.push(`量价<${cfg.minVolume}`);
  if (risk > cfg.maxRisk) failed.push(`风险>${cfg.maxRisk}`);
  if (cfg.requireAboveMa20 && finite(d.close) && finite(d.ma20) && d.close <= d.ma20) failed.push("未站上MA20");
  if (cfg.minVolRatio > 0 && (!finite(d.volRatio) || d.volRatio < cfg.minVolRatio)) failed.push(`量比<${cfg.minVolRatio.toFixed(2)}`);
  if (cfg.breakoutWithinPct != null && (!finite(d.pctFrom20dHigh) || d.pctFrom20dHigh < cfg.breakoutWithinPct)) failed.push("离20日高点过远");
  if (cfg.ma20MinPct != null && (!finite(d.pctFromMa20) || d.pctFromMa20 < cfg.ma20MinPct)) failed.push("低于回踩区间");
  if (cfg.ma20MaxPct != null && (!finite(d.pctFromMa20) || d.pctFromMa20 > cfg.ma20MaxPct)) failed.push("偏离MA20过大");
  if (cfg.rsiMin != null && (!finite(d.rsi) || d.rsi < cfg.rsiMin)) failed.push(`RSI<${cfg.rsiMin}`);
  if (cfg.rsiMax != null && (!finite(d.rsi) || d.rsi > cfg.rsiMax)) failed.push(`RSI>${cfg.rsiMax}`);
  if (cfg.minRet20 != null && (!finite(d.ret20) || d.ret20 < cfg.minRet20)) failed.push(`20日收益<${cfg.minRet20}%`);
  return { ok: failed.length === 0, failed, values: { score: s.score, trend, momentum, volume, risk } };
}

function exitCheck(feature, cfg) {
  const s = feature?.signal;
  if (!s) return false;
  const trend = factor(s, "trend");
  return s.score <= cfg.exitScore || trend <= Math.min(-10, cfg.minTrend * -0.45);
}

export function precomputeStrategyFeatures(candles, warmup = 60) {
  const out = new Array(candles.length).fill(null);
  for (let i = warmup; i < candles.length; i++) {
    const daily = analyzeDaily(candles.slice(0, i + 1));
    const signal = analyzeSignals(daily);
    out[i] = { daily, signal };
  }
  return out;
}

function exitAt(position, rawPrice, reason, date, capital, cfg) {
  const sellCost = (cfg.feeBps + cfg.slippageBps) / 10000;
  const exitExec = rawPrice * (1 - sellCost);
  const value = position.shares * exitExec;
  const ret = (value / position.capitalIn - 1) * 100;
  return {
    capital: value,
    trade: {
      entryDate: position.entryDate,
      exitDate: date,
      entryPrice: round(position.entryRaw),
      exitPrice: round(rawPrice),
      returnPct: round(ret),
      holdDays: position.holdDays,
      reason,
      entryScore: position.entryScore,
      entryRisk: position.entryRisk,
    },
  };
}

function calcMetrics(equityCurve, trades, startCapital, endCapital, testedDays, positionDays, benchmarkReturn) {
  const totalReturn = (endCapital / startCapital - 1) * 100;
  let peak = -Infinity, maxDd = 0;
  for (const p of equityCurve) {
    const v = p.equity;
    if (!finite(v)) continue;
    peak = Math.max(peak, v);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak * 100);
  }
  const dailyRets = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const a = equityCurve[i - 1].equity, b = equityCurve[i].equity;
    if (a > 0 && b > 0) dailyRets.push(b / a - 1);
  }
  const mean = dailyRets.length ? dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length : 0;
  const variance = dailyRets.length > 1 ? dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyRets.length - 1) : 0;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(244) : 0;
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct < 0);
  const grossWin = wins.reduce((a, t) => a + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.returnPct, 0));
  const years = Math.max(testedDays / 244, 1 / 244);
  const annualized = endCapital > 0 ? (Math.pow(endCapital / startCapital, 1 / years) - 1) * 100 : -100;
  return {
    totalReturn: round(totalReturn),
    annualized: round(annualized),
    maxDrawdown: round(maxDd),
    sharpe: round(sharpe),
    trades: trades.length,
    winRate: trades.length ? round(wins.length / trades.length * 100, 1) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? 99 : null),
    avgTrade: trades.length ? round(trades.reduce((a, t) => a + t.returnPct, 0) / trades.length) : null,
    exposure: testedDays ? round(positionDays / testedDays * 100, 1) : 0,
    benchmarkReturn: round(benchmarkReturn),
    excessReturn: finite(benchmarkReturn) ? round(totalReturn - benchmarkReturn) : null,
  };
}

export function simulateStrategy(candles, features, inputConfig = {}, options = {}) {
  const cfg = normalizeStrategyConfig(inputConfig);
  const start = Math.max(60, options.startIndex ?? 60);
  const end = Math.min(candles.length - 1, options.endIndex ?? candles.length - 1);
  if (!Array.isArray(candles) || end - start < 20) {
    return { status: "insufficient", config: cfg, metrics: null, trades: [], equityCurve: [] };
  }

  let capital = 1;
  let position = null;
  let pendingEntry = null;
  let pendingExit = null;
  const trades = [];
  const equityCurve = [];
  let positionDays = 0;
  const buyCost = (cfg.feeBps + cfg.slippageBps) / 10000;

  for (let i = start; i <= end; i++) {
    const c = candles[i];
    if (!c || !(c.open > 0) || !(c.close > 0)) continue;

    // 收盘信号统一下一交易日开盘执行。
    if (position && pendingExit) {
      const ex = exitAt(position, c.open, pendingExit, c.time, capital, cfg);
      capital = ex.capital; trades.push(ex.trade); position = null; pendingExit = null;
    }

    if (!position && pendingEntry) {
      const entryExec = c.open * (1 + buyCost);
      position = {
        capitalIn: capital,
        shares: capital / entryExec,
        entryRaw: c.open,
        entryDate: c.time,
        entryIndex: i,
        holdDays: 0,
        highestPrior: c.open,
        entryScore: pendingEntry.values?.score ?? null,
        entryRisk: pendingEntry.values?.risk ?? null,
      };
      pendingEntry = null;
    }

    if (position) {
      position.holdDays += 1;
      positionDays += 1;
      const stop = cfg.stopLossPct > 0 ? position.entryRaw * (1 - cfg.stopLossPct / 100) : null;
      const trailing = cfg.trailingStopPct > 0 ? position.highestPrior * (1 - cfg.trailingStopPct / 100) : null;
      const stopLine = [stop, trailing].filter(finite).length ? Math.max(...[stop, trailing].filter(finite)) : null;
      const take = cfg.takeProfitPct > 0 ? position.entryRaw * (1 + cfg.takeProfitPct / 100) : null;
      let intradayExit = null;
      if (finite(stopLine) && c.open <= stopLine) intradayExit = { price: c.open, reason: c.open < stopLine ? "跳空止损" : "止损" };
      else if (finite(stopLine) && finite(c.low) && c.low <= stopLine) intradayExit = { price: stopLine, reason: trailing >= stop ? "移动止损" : "止损" };
      else if (finite(take) && c.open >= take) intradayExit = { price: c.open, reason: "跳空止盈" };
      else if (finite(take) && finite(c.high) && c.high >= take) intradayExit = { price: take, reason: "止盈" };

      if (intradayExit) {
        const ex = exitAt(position, intradayExit.price, intradayExit.reason, c.time, capital, cfg);
        capital = ex.capital; trades.push(ex.trade); position = null; pendingExit = null;
      } else {
        if (finite(c.high)) position.highestPrior = Math.max(position.highestPrior, c.high);
      }
    }

    // 按收盘市值记录权益。
    const equity = position ? position.shares * c.close : capital;
    equityCurve.push({ time: c.time, equity: round(equity, 6) });

    const f = features[i];
    if (position) {
      if (position.holdDays >= cfg.maxHoldDays) pendingExit = "最长持有期";
      else if (exitCheck(f, cfg)) pendingExit = "因子转弱";
    } else if (!pendingEntry && i < end) {
      const check = entryCheck(f, cfg);
      if (check.ok) pendingEntry = check;
    }
  }

  if (position) {
    const c = candles[end];
    const ex = exitAt(position, c.close, "样本结束", c.time, capital, cfg);
    capital = ex.capital; trades.push(ex.trade);
    if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = round(capital, 6);
  }

  const b0 = candles[start]?.close;
  const b1 = candles[end]?.close;
  const benchmarkReturn = b0 > 0 && b1 > 0 ? (b1 / b0 - 1) * 100 : null;
  const metrics = calcMetrics(equityCurve, trades, 1, capital, Math.max(1, end - start + 1), positionDays, benchmarkReturn);
  return { status: "ok", config: cfg, metrics, trades, equityCurve, range: { start: candles[start]?.time, end: candles[end]?.time, bars: end - start + 1 } };
}

function foldValidation(candles, features, cfg) {
  const start = 60, end = candles.length - 1;
  const usable = end - start + 1;
  if (usable < 150) return [];
  const folds = Math.min(4, Math.max(3, Math.floor(usable / 120)));
  const size = Math.floor(usable / folds);
  const out = [];
  for (let k = 0; k < folds; k++) {
    const a = start + k * size;
    const b = k === folds - 1 ? end : Math.min(end, a + size - 1);
    const r = simulateStrategy(candles, features, cfg, { startIndex: a, endIndex: b });
    out.push({
      label: `${candles[a]?.time || ""} → ${candles[b]?.time || ""}`,
      ...r.metrics,
    });
  }
  return out;
}

function parameterScan(candles, features, cfg) {
  const es = [...new Set([cfg.entryScore - 8, cfg.entryScore, cfg.entryScore + 8].map((x) => clamp(Math.round(x), -20, 90)))];
  const risks = [...new Set([cfg.maxRisk - 10, cfg.maxRisk, cfg.maxRisk + 10].map((x) => clamp(Math.round(x), 20, 95)))];
  const holds = [...new Set([Math.max(5, Math.round(cfg.maxHoldDays * 0.7)), cfg.maxHoldDays, Math.round(cfg.maxHoldDays * 1.35)])];
  const rows = [];
  for (const entryScore of es) for (const maxRisk of risks) for (const maxHoldDays of holds) {
    const c = { ...cfg, entryScore, maxRisk, maxHoldDays };
    const r = simulateStrategy(candles, features, c);
    const m = r.metrics;
    if (!m) continue;
    const objective = (m.totalReturn ?? -100) - (m.maxDrawdown ?? 100) * 0.65 + (m.sharpe ?? 0) * 2.5 + Math.min(m.trades, 12) * 0.12;
    rows.push({ entryScore, maxRisk, maxHoldDays, objective: round(objective), ...m });
  }
  rows.sort((a, b) => (b.objective ?? -999) - (a.objective ?? -999));
  const positive = rows.filter((x) => (x.totalReturn ?? -1) > 0).length;
  const baseLike = rows.filter((x) => Math.abs(x.entryScore - cfg.entryScore) <= 8 && Math.abs(x.maxRisk - cfg.maxRisk) <= 10);
  const robustPositive = baseLike.filter((x) => (x.totalReturn ?? -1) > 0).length;
  return {
    tested: rows.length,
    positivePct: rows.length ? round(positive / rows.length * 100, 1) : null,
    neighborhoodPositivePct: baseLike.length ? round(robustPositive / baseLike.length * 100, 1) : null,
    top: rows.slice(0, 7),
  };
}

function regimeFit(regime, cfg) {
  const state = regime?.state || "unknown";
  let score = 50;
  let note = "市场状态数据不足，仅按个股策略回测。";
  if (["bull", "range_bull"].includes(state)) {
    score = cfg.id === "momentum" || cfg.presetId === "momentum" ? 90 : cfg.presetId === "trend_breakout" ? 86 : cfg.presetId === "defensive" ? 72 : 78;
    note = "当前市场偏多，趋势/动量类规则相对匹配。";
  } else if (state === "range") {
    score = cfg.presetId === "trend_pullback" ? 82 : cfg.presetId === "defensive" ? 75 : 55;
    note = "当前更接近震荡，回踩/稳健规则通常比追突破更合适。";
  } else if (["bear", "range_bear"].includes(state)) {
    score = cfg.presetId === "defensive" ? 62 : 30;
    note = "当前市场偏空，任何做多策略都应降低仓位与信号频率。";
  } else if (state === "high_vol") {
    score = cfg.presetId === "defensive" ? 68 : 38;
    note = "当前高波动，止损和风险门槛比收益目标更重要。";
  }
  return { score, note };
}


// ---------------------------------------------------------------------------
// v1.6 · 智能策略推荐（沿用 v1.5 核心）
// ---------------------------------------------------------------------------

const PROFILE_META = {
  conservative: { id: "conservative", name: "稳健", description: "更高入场门槛、更低风险容忍，优先控制回撤与参数脆弱性。" },
  balanced: { id: "balanced", name: "均衡", description: "在样本外表现、回撤、交易机会和稳定性之间取平衡。" },
  aggressive: { id: "aggressive", name: "积极", description: "降低入场门槛并放宽波动容忍，换取更多交易机会。" },
};

const percentile = (values, q, fallback = null) => {
  const xs = (values || []).filter(finite).slice().sort((a, b) => a - b);
  if (!xs.length) return fallback;
  const pos = clamp(q, 0, 1) * (xs.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] * (hi - pos) + xs[hi] * (pos - lo);
};
const avg = (xs, fallback = 0) => {
  const a = (xs || []).filter(finite);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : fallback;
};
const metric01 = (v, lo, hi, fallback = 0.5) => finite(v) ? clamp((v - lo) / Math.max(1e-9, hi - lo), 0, 1) : fallback;
const inverseMetric01 = (v, good, bad, fallback = 0.5) => finite(v) ? clamp((bad - v) / Math.max(1e-9, bad - good), 0, 1) : fallback;

function collectStrategyStats(features) {
  const usable = (features || []).filter((f) => f?.daily && f?.signal);
  const recent = usable.slice(-60);
  const vals = (getter) => usable.map(getter).filter(finite);
  const latest = usable.at(-1) || null;
  return {
    usable: usable.length,
    latest,
    score: vals((f) => f.signal.score),
    trend: vals((f) => factor(f.signal, "trend")),
    momentum: vals((f) => factor(f.signal, "momentum")),
    volume: vals((f) => factor(f.signal, "volume")),
    risk: vals((f) => factor(f.signal, "risk", 50)),
    atr: vals((f) => f.daily.atr14Pct),
    vol: vals((f) => f.daily.volatility20),
    recentTrend: avg(recent.map((f) => factor(f.signal, "trend"))),
    recentMomentum: avg(recent.map((f) => factor(f.signal, "momentum"))),
    recentRisk: avg(recent.map((f) => factor(f.signal, "risk", 50)), 50),
    atrMedian: percentile(vals((f) => f.daily.atr14Pct), 0.5, 3),
    atrRecent: percentile(recent.map((f) => f.daily.atr14Pct), 0.5, 3),
  };
}

function currentPresetStyleFit(stats, presetId) {
  const f = stats.latest;
  if (!f?.daily || !f?.signal) return { score: 50, note: "当前技术状态数据不足。" };
  const d = f.daily, s = f.signal;
  const trend = factor(s, "trend"), momentum = factor(s, "momentum"), volume = factor(s, "volume"), risk = factor(s, "risk", 50);
  let score = 50, note = "当前状态与策略中性匹配。";
  if (presetId === "trend_breakout") {
    score = 25 + metric01(trend, 5, 65) * 35 + metric01(momentum, -5, 55) * 15 + metric01(volume, -15, 55) * 10 + metric01(d.pctFrom20dHigh, -8, 0) * 15;
    note = `当前趋势 ${Math.round(trend)}、距20日高点 ${round(d.pctFrom20dHigh, 1) ?? "—"}%${finite(d.volRatio) ? `、量比 ${round(d.volRatio, 2)}` : ""}。`;
  } else if (presetId === "trend_pullback") {
    const nearMa = finite(d.pctFromMa20) ? clamp(1 - Math.abs(d.pctFromMa20 - 1) / 9, 0, 1) : 0.5;
    const rsiFit = finite(d.rsi) ? clamp(1 - Math.abs(d.rsi - 55) / 25, 0, 1) : 0.5;
    score = 25 + metric01(trend, 5, 65) * 35 + nearMa * 25 + rsiFit * 15;
    note = `当前趋势 ${Math.round(trend)}、距MA20 ${round(d.pctFromMa20, 1) ?? "—"}%、RSI ${round(d.rsi, 1) ?? "—"}。`;
  } else if (presetId === "momentum") {
    score = 20 + metric01(momentum, 0, 70) * 40 + metric01(trend, 0, 60) * 20 + metric01(volume, -10, 65) * 10 + inverseMetric01(risk, 35, 90) * 10;
    note = `当前动量 ${Math.round(momentum)}、趋势 ${Math.round(trend)}、量价 ${Math.round(volume)}。`;
  } else if (presetId === "defensive") {
    score = 25 + metric01(trend, 10, 70) * 30 + inverseMetric01(risk, 25, 75) * 30 + inverseMetric01(d.atr14Pct, 1.5, 6.5) * 15;
    note = `当前趋势 ${Math.round(trend)}、风险 ${Math.round(risk)}${finite(d.atr14Pct) ? `、ATR ${round(d.atr14Pct, 1)}%` : ""}。`;
  }
  return { score: round(clamp(score, 0, 100), 0), note };
}

function regimePrior(regime, presetId) {
  return regimeFit(regime, normalizeStrategyConfig({ presetId })).score;
}

function adaptiveSeedConfig(presetId, profileId, stats, marketRegime) {
  const base = STRATEGY_PRESETS[presetId] || STRATEGY_PRESETS.trend_breakout;
  const p = PROFILE_META[profileId] || PROFILE_META.balanced;
  const qEntry = profileId === "conservative" ? 0.72 : profileId === "aggressive" ? 0.52 : 0.62;
  const qRisk = profileId === "conservative" ? 0.45 : profileId === "aggressive" ? 0.78 : 0.62;
  const empiricalEntry = percentile(stats.score, qEntry, base.entryScore);
  const empiricalRisk = percentile(stats.risk, qRisk, base.maxRisk);
  const entryShift = profileId === "conservative" ? 5 : profileId === "aggressive" ? -5 : 0;
  const riskShift = profileId === "conservative" ? -6 : profileId === "aggressive" ? 8 : 0;
  const entryScore = clamp(Math.round(base.entryScore * 0.55 + empiricalEntry * 0.45 + entryShift), -10, 80);
  const maxRisk = clamp(Math.round(base.maxRisk * 0.55 + empiricalRisk * 0.45 + riskShift), 25, 92);

  const atr = finite(stats.atrRecent) ? stats.atrRecent : finite(stats.atrMedian) ? stats.atrMedian : 3;
  const atrMult = profileId === "conservative" ? 1.55 : profileId === "aggressive" ? 2.15 : 1.8;
  const stopAtr = clamp(atr * atrMult, 3, 12);
  const stopLossPct = round(clamp(base.stopLossPct * 0.5 + stopAtr * 0.5, 3, 12), 1);
  const rr = profileId === "conservative" ? 2.15 : profileId === "aggressive" ? 2.9 : 2.55;
  const takeProfitPct = round(clamp(base.takeProfitPct * 0.45 + stopLossPct * rr * 0.55, 7, 35), 1);
  const trailingStopPct = round(clamp(stopLossPct * (profileId === "conservative" ? 0.9 : profileId === "aggressive" ? 1.2 : 1.05), 3, 18), 1);
  let holdScale = profileId === "conservative" ? 0.85 : profileId === "aggressive" ? 1.2 : 1;
  const rs = marketRegime?.state;
  if (["bear", "range_bear", "high_vol"].includes(rs)) holdScale *= 0.85;
  if (["bull", "range_bull"].includes(rs)) holdScale *= 1.08;
  const maxHoldDays = clamp(Math.round(base.maxHoldDays * holdScale), 7, 45);
  return normalizeStrategyConfig({ ...base, presetId, entryScore, maxRisk, stopLossPct, takeProfitPct, trailingStopPct, maxHoldDays, profileId: p.id });
}

function candidateConfigs(seed) {
  const entryD = [-5, 0, 5];
  const riskD = [-7, 0, 7];
  const holdM = [0.82, 1, 1.18];
  const out = [];
  for (const de of entryD) for (const dr of riskD) for (const hm of holdM) {
    out.push(normalizeStrategyConfig({
      ...seed,
      entryScore: clamp(Math.round(seed.entryScore + de), -20, 90),
      maxRisk: clamp(Math.round(seed.maxRisk + dr), 20, 95),
      maxHoldDays: clamp(Math.round(seed.maxHoldDays * hm), 5, 60),
    }));
  }
  return out;
}

function recommendationSplit(candles) {
  const start = 60, end = candles.length - 1;
  const usable = Math.max(1, end - start + 1);
  const validationStart = start + Math.floor(usable * 0.60);
  const holdoutStart = start + Math.floor(usable * 0.80);
  return {
    train: { start, end: Math.max(start + 20, validationStart - 1) },
    validation: { start: validationStart, end: Math.max(validationStart + 15, holdoutStart - 1) },
    holdout: { start: holdoutStart, end },
  };
}

function rollingOosSegments(candles, features, cfg) {
  const start = 60, end = candles.length - 1;
  const usable = end - start + 1;
  if (usable < 180) return [];
  const testStart = start + Math.floor(usable * 0.48);
  const remain = end - testStart + 1;
  const size = Math.max(35, Math.floor(remain / 3));
  const rows = [];
  for (let k = 0; k < 3; k++) {
    const a = testStart + k * size;
    if (a >= end - 10) break;
    const b = k === 2 ? end : Math.min(end, a + size - 1);
    const r = simulateStrategy(candles, features, cfg, { startIndex: a, endIndex: b });
    if (r.metrics) rows.push({ label: `${candles[a]?.time || ""} → ${candles[b]?.time || ""}`, ...r.metrics });
  }
  return rows;
}

function recommendationObjective(train, validation, styleFit, marketFit) {
  const fm = train?.metrics || {}, om = validation?.metrics || {};
  const sample = clamp((fm.trades || 0) / 12, 0, 1);
  const oosSample = clamp((om.trades || 0) / 5, 0, 1);
  const fullReturn = metric01(fm.totalReturn, -15, 45, 0.2);
  const oosReturn = metric01(om.totalReturn, -12, 25, 0.2);
  const excess = metric01(fm.excessReturn, -30, 25, 0.3);
  const sharpe = metric01(fm.sharpe, -0.3, 1.6, 0.3);
  const oosSharpe = metric01(om.sharpe, -0.5, 1.3, 0.3);
  const drawdown = inverseMetric01(fm.maxDrawdown, 5, 28, 0.4);
  const pf = metric01(Math.min(fm.profitFactor ?? 0, 4), 0.8, 2.6, 0.3);
  let score = (
    oosReturn * 0.19 + oosSharpe * 0.11 + fullReturn * 0.11 + excess * 0.11 + sharpe * 0.10 +
    drawdown * 0.13 + pf * 0.05 + sample * 0.08 + oosSample * 0.05 +
    clamp(styleFit / 100, 0, 1) * 0.04 + clamp(marketFit / 100, 0, 1) * 0.03
  ) * 100;
  if ((fm.trades || 0) < 3) score -= 24;
  else if ((fm.trades || 0) < 6) score -= 12;
  if ((om.trades || 0) < 2) score -= 12;
  if (finite(fm.excessReturn) && fm.excessReturn < -35) score -= 20;
  else if (finite(fm.excessReturn) && fm.excessReturn < -15) score -= 10;
  if (finite(om.totalReturn) && om.totalReturn < -8) score -= 15;
  if (finite(fm.maxDrawdown) && fm.maxDrawdown > 25) score -= 14;
  if (finite(fm.exposure) && fm.exposure < 3 && (fm.trades || 0) < 6) score -= 8;
  return round(clamp(score, 0, 100), 1);
}

function evaluateCandidate(candles, features, cfg, marketRegime, styleFit) {
  const split = recommendationSplit(candles);
  const train = simulateStrategy(candles, features, cfg, { startIndex: split.train.start, endIndex: split.train.end });
  const validation = simulateStrategy(candles, features, cfg, { startIndex: split.validation.start, endIndex: split.validation.end });
  const marketFit = regimeFit(marketRegime, cfg).score;
  const objective = recommendationObjective(train, validation, styleFit, marketFit);
  return { config: cfg, train, validation, objective, marketFit, split };
}

function localStability(evals, best) {
  if (!best || !evals?.length) return { score: 0, positivePct: null, nearCount: 0 };
  const near = evals.filter((x) => Math.abs(x.config.entryScore - best.config.entryScore) <= 5 && Math.abs(x.config.maxRisk - best.config.maxRisk) <= 7 && Math.abs(x.config.maxHoldDays - best.config.maxHoldDays) <= Math.max(4, best.config.maxHoldDays * 0.22));
  if (!near.length) return { score: 0, positivePct: null, nearCount: 0 };
  const positive = near.filter((x) => (x.train.metrics?.totalReturn ?? -1) > 0 && (x.validation.metrics?.totalReturn ?? -1) >= -2).length;
  const positivePct = positive / near.length * 100;
  const objectiveSpread = Math.max(...near.map((x) => x.objective)) - Math.min(...near.map((x) => x.objective));
  const score = clamp(positivePct * 0.75 + inverseMetric01(objectiveSpread, 8, 35) * 25, 0, 100);
  return { score: round(score, 1), positivePct: round(positivePct, 1), nearCount: near.length };
}

function confidenceFromEvaluation(best, stability, rolling, candles) {
  const m = best.full?.metrics || best.train?.metrics || {}, o = best.holdout?.metrics || {};
  const sample = clamp((m.trades || 0) / 12, 0, 1) * 100;
  const oosSample = clamp((o.trades || 0) / 5, 0, 1) * 100;
  const positiveRoll = rolling.length ? rolling.filter((x) => (x.totalReturn ?? -1) > 0).length / rolling.length * 100 : 35;
  const history = clamp(((candles?.length || 0) - 60) / 550, 0, 1) * 100;
  let score = sample * 0.28 + oosSample * 0.18 + (stability?.score ?? 0) * 0.26 + positiveRoll * 0.18 + history * 0.10;
  if ((m.trades || 0) < 4) score = Math.min(score, 42);
  if ((o.trades || 0) < 2) score = Math.min(score, 48);
  return round(clamp(score, 0, 100), 0);
}

function recommendationReasons(best, stability, rolling, style, profileId) {
  const m = best.full?.metrics || best.train?.metrics || {}, o = best.holdout?.metrics || {};
  const reasons = [];
  reasons.push(`当前形态适配 ${style.score}/100：${style.note}`);
  if (finite(o.totalReturn)) reasons.push(`最终保留检验区间收益 ${o.totalReturn > 0 ? "+" : ""}${o.totalReturn}%${o.trades != null ? `，${o.trades}笔交易` : ""}。`);
  if (finite(m.maxDrawdown)) reasons.push(`全样本最大回撤 ${m.maxDrawdown}%${finite(m.sharpe) ? `，Sharpe ${m.sharpe}` : ""}。`);
  if (finite(stability?.positivePct)) reasons.push(`推荐参数附近 ${stability.positivePct}% 的组合保持非负/近似非负样本外表现。`);
  if (rolling.length) reasons.push(`滚动样本外 ${rolling.filter((x) => (x.totalReturn ?? -1) > 0).length}/${rolling.length} 段盈利。`);
  if ((m.trades || 0) < 6) reasons.push(`历史仅 ${m.trades || 0} 笔交易，统计样本偏少，推荐可信度被主动下调。`);
  if (finite(m.excessReturn) && m.excessReturn < -15) reasons.push(`相对买入持有少 ${Math.abs(m.excessReturn).toFixed(1)} 个百分点，暂不应把正收益误认为策略优势。`);
  if (profileId === "conservative") reasons.push("稳健档提高信号门槛并降低允许风险，交易会更少。" );
  if (profileId === "aggressive") reasons.push("积极档放宽信号与风险门槛，交易机会增加但回撤容忍更高。" );
  return reasons.slice(0, 7);
}

function profileSummary(best, stability, rolling, style, profileId, candles) {
  const m = best.full?.metrics || best.train?.metrics || {}, o = best.holdout?.metrics || {};
  const confidence = confidenceFromEvaluation(best, stability, rolling, candles);
  const rollingPositivePct = rolling.length ? round(rolling.filter((x) => (x.totalReturn ?? -1) > 0).length / rolling.length * 100, 1) : null;
  let action = "可作为研究候选";
  if (confidence < 45 || (m.trades || 0) < 4 || (o.trades || 0) < 2) action = "样本不足，暂不建议依赖";
  else if ((best.marketFit ?? 50) < 40) action = "当前市场不匹配";
  else if (best.objective >= 68 && confidence >= 65 && (m.excessReturn ?? -999) > -15) action = "当前较适合";
  else if (best.objective < 45 || (m.excessReturn ?? 0) < -35) action = "当前不优先使用";
  const sampleAdequacy = round(clamp(clamp((m.trades || 0) / 12, 0, 1) * 65 + clamp((o.trades || 0) / 4, 0, 1) * 35, 0, 100), 0);
  const rollingPositive = rolling.length ? rolling.filter((x) => (x.totalReturn ?? -1) > 0).length / rolling.length * 100 : 35;
  const historicalReliability = round(clamp(metric01(o.totalReturn, -8, 16, 0.35) * 35 + metric01(o.sharpe, -0.5, 1.2, 0.35) * 20 + metric01(m.excessReturn, -25, 20, 0.4) * 20 + rollingPositive * 0.25, 0, 100), 0);
  return {
    id: profileId,
    name: PROFILE_META[profileId]?.name || profileId,
    description: PROFILE_META[profileId]?.description || "",
    config: best.config,
    score: round(best.objective, 0),
    confidence,
    action,
    diagnostics: { strategyFit: round(best.objective,0), historicalReliability, parameterStability: round(stability?.score ?? 0,0), marketFit: round(best.marketFit ?? 50,0), sampleAdequacy },
    metrics: {
      totalReturn: m.totalReturn, excessReturn: m.excessReturn, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe,
      trades: m.trades, winRate: m.winRate, exposure: m.exposure,
      oosReturn: o.totalReturn, oosSharpe: o.sharpe, oosTrades: o.trades,
      validationReturn: best.validation?.metrics?.totalReturn ?? null, validationTrades: best.validation?.metrics?.trades ?? null,
      rollingPositivePct,
    },
    stability,
    reasons: recommendationReasons(best, stability, rolling, style, profileId),
  };
}

/**
 * 对四类规则分别构造数据自适应参数，再用训练段 + 验证段筛选参数；最后约20%历史作为独立保留检验，再结合滚动区间与参数邻域稳定性评估。
 * 注意：这不是“未来最优参数”预测，而是帮助普通用户避开明显不稳健的手工猜参。
 */
export function recommendStrategy(candles, features = null, marketRegime = null) {
  if (!Array.isArray(candles) || candles.length < 180) {
    return { status: "insufficient", message: "至少需要约180根日K才能进行智能策略推荐。", profiles: {}, rankings: [] };
  }
  const fs = features || precomputeStrategyFeatures(candles);
  const split = recommendationSplit(candles);
  // 参数分布只使用保留检验区间之前的历史；当前形态匹配单独使用最新状态。
  const selectionStats = collectStrategyStats(fs.slice(0, split.holdout.start));
  const currentStats = collectStrategyStats(fs);
  const profileIds = ["conservative", "balanced", "aggressive"];
  const presetRows = [];
  const byPreset = {};

  for (const preset of Object.values(STRATEGY_PRESETS)) {
    const style = currentPresetStyleFit(currentStats, preset.id);
    const pRows = {};
    for (const profileId of profileIds) {
      const seed = adaptiveSeedConfig(preset.id, profileId, selectionStats, marketRegime);
      const evals = candidateConfigs(seed).map((cfg) => evaluateCandidate(candles, fs, cfg, marketRegime, style.score));
      evals.sort((a, b) => b.objective - a.objective);
      const best = evals[0];
      const split = best.split || recommendationSplit(candles);
      best.full = simulateStrategy(candles, fs, best.config);
      best.holdout = simulateStrategy(candles, fs, best.config, { startIndex: split.holdout.start, endIndex: split.holdout.end });
      const stability = localStability(evals, best);
      const rolling = rollingOosSegments(candles, fs, best.config);
      pRows[profileId] = profileSummary(best, stability, rolling, style, profileId, candles);
      pRows[profileId].rolling = rolling;
    }
    const bal = pRows.balanced;
    const marketFit = regimePrior(marketRegime, preset.id);
    const rankScore = round(clamp((bal?.score ?? 0) * 0.70 + (bal?.diagnostics?.parameterStability ?? 0) * 0.05 + style.score * 0.15 + marketFit * 0.10, 0, 100), 1);
    byPreset[preset.id] = { preset: { id: preset.id, name: preset.name, description: preset.description }, styleFit: style, marketFit, rankScore, profiles: pRows };
    presetRows.push({ id: preset.id, name: preset.name, score: rankScore, styleFit: style.score, marketFit, balanced: bal });
  }

  presetRows.sort((a, b) => b.score - a.score);
  const bestPresetId = presetRows[0]?.id || "trend_breakout";
  const selected = byPreset[bestPresetId];
  const balanced = selected?.profiles?.balanced;
  const confidence = balanced?.confidence ?? 0;
  let headline = `${selected?.preset?.name || "策略"} · 均衡档`;
  let summary = "根据当前股票状态、历史回放、样本外表现和参数稳定性给出推荐。";
  if (balanced?.action === "样本不足，暂不建议依赖") summary = "目前没有足够历史交易样本证明参数稳定，以下配置仅作为研究起点。";
  else if (balanced?.action === "当前不优先使用") summary = "当前股票/市场与候选策略匹配度有限，建议等待环境变化或切换其他规则。";
  return {
    status: "ok",
    mode: "smart",
    recommendedPresetId: bestPresetId,
    headline,
    summary,
    confidence,
    profiles: selected?.profiles || {},
    rankings: presetRows.slice(0, 4),
    styleFit: selected?.styleFit || null,
    marketFit: selected?.marketFit ?? null,
    sample: { historyBars: candles.length, usableBars: currentStats.usable, scoreMedian: round(percentile(selectionStats.score, .5), 1), riskMedian: round(percentile(selectionStats.risk, .5), 1), atrMedian: round(selectionStats.atrMedian, 1), atrRecent: round(currentStats.atrRecent, 1) },
    notice: "推荐基于历史统计、参数稳定性与保留检验，不代表未来最优；保留检验不参与历史参数筛选，当前市场/个股状态只用于当下策略适配。样本较少、市场结构变化或交易成本变化时应降低信任。",
  };
}

export function runStrategyLab(candles, inputConfig = {}, options = {}) {
  const requestedMode = inputConfig?.mode === "smart" ? "smart" : "manual";
  const fallbackCfg = normalizeStrategyConfig(inputConfig);
  candles = (Array.isArray(candles) ? candles : []).filter((x) =>
    finite(Number(x?.open)) && finite(Number(x?.high)) && finite(Number(x?.low)) &&
    finite(Number(x?.close)) && Number(x.close) > 0
  );
  if (candles.length < 100) {
    const closes = candles.map((x) => Number(x.close));
    const returns = closes.slice(1).map((close, i) => (close / closes[i] - 1) * 100).filter(finite);
    const change = (days) => closes.length > 1
      ? round((closes.at(-1) / closes[Math.max(0, closes.length - 1 - days)] - 1) * 100, 2)
      : null;
    let peak = closes[0] || null;
    let maxDrawdownPct = null;
    for (const close of closes) {
      peak = peak == null ? close : Math.max(peak, close);
      const drawdown = peak > 0 ? (peak - close) / peak * 100 : 0;
      maxDrawdownPct = Math.max(maxDrawdownPct || 0, drawdown);
    }
    const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
    const dailyVolatilityPct = returns.length && mean != null
      ? Math.sqrt(returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / returns.length)
      : null;
    const volumes = candles.map((x) => Number(x.volume)).filter((x) => finite(x) && x >= 0);
    const recentVolumes = volumes.slice(-5);
    const priorVolumes = volumes.slice(Math.max(0, volumes.length - 25), Math.max(0, volumes.length - 5));
    const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const recentAvg = avg(recentVolumes);
    const priorAvg = avg(priorVolumes);
    const volumeRatio = recentAvg != null && priorAvg > 0 ? round(recentAvg / priorAvg, 2) : null;
    const bars = candles.length;
    return {
      status: "limited",
      message: `上市历史仅 ${bars} 根，已进入新股有限样本模式。`,
      presets: listStrategyPresets(),
      config: fallbackCfg,
      mode: requestedMode,
      historyBars: bars,
      range: { start: candles[0]?.time || null, end: candles.at(-1)?.time || null, bars },
      current: { matched: false, failed: ["有限样本阶段不生成规则买点"], values: null },
      limitedAnalysis: {
        bars,
        listingReturnPct: closes.length > 1 ? round((closes.at(-1) / closes[0] - 1) * 100, 2) : null,
        return5Pct: change(5),
        return10Pct: change(10),
        return20Pct: change(20),
        maxDrawdownPct: round(maxDrawdownPct, 2),
        dailyVolatilityPct: round(dailyVolatilityPct, 2),
        volumeRatio,
        capabilities: [
          { key: "short_stats", label: "短样本统计", required: 2, ready: bars >= 2 },
          { key: "technical", label: "基础技术指标", required: 20, ready: bars >= 20 },
          { key: "kronos", label: "Kronos 路径预测", required: 40, ready: bars >= 40 },
          { key: "strategy", label: "策略回测与智能推荐", required: 100, ready: false },
        ],
      },
    };
  }

  const features = precomputeStrategyFeatures(candles);
  let recommendation = null;
  let cfg = fallbackCfg;
  let profileId = inputConfig?.profile || "balanced";

  if (requestedMode === "smart") {
    recommendation = recommendStrategy(candles, features, options.marketRegime || null);
    if (recommendation.status === "ok") {
      if (!PROFILE_META[profileId]) profileId = "balanced";
      const p = recommendation.profiles?.[profileId] || recommendation.profiles?.balanced;
      if (p?.config) cfg = normalizeStrategyConfig(p.config);
    }
  }

  const result = simulateStrategy(candles, features, cfg);
  const currentCheck = entryCheck(features[candles.length - 1], cfg);
  const folds = foldValidation(candles, features, cfg);
  const scan = options.scan === false ? null : parameterScan(candles, features, cfg);
  const positiveFolds = folds.filter((x) => (x.totalReturn ?? -1) > 0).length;
  const fit = regimeFit(options.marketRegime, cfg);

  // 选择的推荐档位用最终 27 组邻近扫描再次校验稳定性，UI 显示的是这一步而非候选搜索的乐观值。
  if (recommendation?.status === "ok") {
    const rp = recommendation.profiles?.[profileId];
    if (rp) {
      rp.finalNeighborhoodPositivePct = scan?.neighborhoodPositivePct ?? null;
      rp.finalFoldConsistency = folds.length ? round(positiveFolds / folds.length * 100, 1) : null;
      rp.finalRegimeFit = fit.score;
    }
    recommendation.selectedProfile = profileId;
  }

  return {
    ...result,
    mode: requestedMode,
    recommendation,
    selectedProfile: requestedMode === "smart" ? profileId : null,
    presets: listStrategyPresets(),
    current: {
      matched: currentCheck.ok,
      failed: currentCheck.failed.slice(0, 5),
      values: currentCheck.values || null,
    },
    folds,
    foldConsistency: folds.length ? round(positiveFolds / folds.length * 100, 1) : null,
    scan,
    regimeFit: fit,
    methodology: {
      execution: "收盘生成信号，下一交易日开盘执行",
      costs: `双边近似：手续费 ${cfg.feeBps}bp + 滑点 ${cfg.slippageBps}bp / 每次成交`,
      position: "单标的单仓位，不加杠杆",
      recommendation: "智能推荐综合当前状态、训练/验证参数筛选、最后20%独立保留检验、滚动区间、参数邻域与市场状态；不会把历史收益第一名直接当未来最优。",
    },
  };
}
