import { analyzeDaily, analyzeSignals, computeTiming, validateSignalHistory } from "./indicators.js";
import { analyzeTrendHorizons } from "./trend-horizons.js";
import { INDICATOR_CATALOG, computeTechnicalIndicators, analyzeTechnicalIndicatorSet } from "./technical-indicators.js";

// 注入数据源，供主进程与离线回归复用；刷新时绕过日K/分时数据源缓存。
export function createSignalService({ getKline, getMinute, indicatorParams = () => ({}), buildEvents = () => [], now = Date.now, ttl = 60000 }) {
  const cache = new Map(), inflight = new Map();
  let generation = 0;
  return {
    clear() { generation++; cache.clear(); inflight.clear(); },
    async get(code, force = false) {
      const key = String(code);
      const hit = cache.get(key);
      if (!force && hit && now()-hit.at < ttl) return { ...hit.data, cached: true };
      if (inflight.has(key)) return inflight.get(key);
      cache.delete(key);
      const version = generation;
      const task = (async () => {
        const [history, minute] = await Promise.all([
          getKline(key, "day", 750, { force: true }),
          getMinute(key, { force: true }).catch(() => ({ points: [], stale: true })),
        ]);
        const candles = history.candles || [];
        const daily = analyzeDaily(candles), sig = analyzeSignals(daily);
        const price = minute.price ?? daily?.close ?? null;
        const timing = computeTiming({ points: minute.points, prevClose: minute.prevClose, price, direction: sig?.direction || "neutral" });
        const validation = sig ? validateSignalHistory(candles, sig) : null;
        const rows = sig ? computeTechnicalIndicators(INDICATOR_CATALOG.map(x=>x.id), candles, {}, indicatorParams()) : [];
        const advancedIndicators = sig ? analyzeTechnicalIndicatorSet(rows, candles) : null;
        const compositeScore = sig && advancedIndicators ? Math.round(sig.score*.65 + advancedIndicators.compositeScore*.35) : sig?.score ?? null;
        const horizons = analyzeTrendHorizons(candles);
        const entry = {
          code: key, name: minute.name || key, price, changePercent: minute.changePercent,
          calculatedAt: now(), asOf: candles.at(-1)?.time || null, stale: !!history.stale,
          dataWarning: history.stale ? "日K获取失败，当前使用历史缓存，趋势可能滞后" : history.error || "",
          horizons,
          daily: sig ? { ...sig, compositeScore, reliability: validation?.reliability ?? null, advancedIndicators, horizons } : null,
          timing, validation, events: sig ? buildEvents(daily, sig, timing) : [],
        };
        if (sig && !history.stale && version === generation) {
          cache.set(key, { at: now(), data: entry });
          if (cache.size > 100) cache.delete(cache.keys().next().value);
        }
        return entry;
      })().finally(() => { if (inflight.get(key) === task) inflight.delete(key); });
      inflight.set(key, task);
      return task;
    },
  };
}
