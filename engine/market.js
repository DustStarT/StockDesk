/**
 * StockDesk v1.1 · 市场状态引擎
 * 输入若干指数的日K快照/量化信号与实时涨跌，输出一个可解释的市场 Regime。
 * 只做状态分类，不直接给交易指令。
 */

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

export function classifyMarketRegime(indices = []) {
  const valid = indices.filter((x) => x && x.daily && x.signal);
  if (!valid.length) {
    return {
      state: "unknown",
      label: "市场状态未知",
      score: 50,
      risk: 50,
      confidence: 0,
      indices: [],
      strategy: ["指数数据不足，暂停使用市场状态加权"],
    };
  }

  const directional = valid.map((x) => Number(x.signal.score) || 0);
  const changes = valid.map((x) => Number(x.changePercent)).filter(Number.isFinite);
  const atrs = valid.map((x) => Number(x.daily.atr14Pct)).filter(Number.isFinite);
  const vols = valid.map((x) => Number(x.daily.volatility20)).filter(Number.isFinite);
  const bullCount = valid.filter((x) => x.signal.direction === "bullish").length;
  const bearCount = valid.filter((x) => x.signal.direction === "bearish").length;

  const dir = avg(directional);
  const chg = avg(changes);
  const atr = avg(atrs);
  const vol = avg(vols);

  let risk = 35;
  if (atr >= 2.5) risk += 15;
  if (atr >= 4) risk += 15;
  if (vol >= 35) risk += 15;
  if (vol >= 50) risk += 10;
  if (Math.abs(chg) >= 2) risk += 10;
  risk = Math.round(clamp(risk));

  let state = "range", label = "震荡", score = Math.round(clamp(50 + dir * 0.45, 0, 100));
  if (risk >= 75 && Math.abs(dir) < 35) { state = "high_vol"; label = "高波动震荡"; }
  else if (dir >= 38 && bullCount >= Math.ceil(valid.length / 2)) { state = "bull"; label = "趋势偏多"; }
  else if (dir <= -38 && bearCount >= Math.ceil(valid.length / 2)) { state = "bear"; label = "趋势偏空"; }
  else if (dir >= 15) { state = "range_bull"; label = "震荡偏多"; }
  else if (dir <= -15) { state = "range_bear"; label = "震荡偏空"; }

  const strategy = [];
  if (state === "bull") strategy.push("趋势/动量策略权重可适度提高", "避免对强势股仅因RSI偏高就机械做空");
  else if (state === "range_bull") strategy.push("优先回踩确认与板块相对强度", "突破信号要求成交量确认");
  else if (state === "range" || state === "high_vol") strategy.push("降低追涨权重", "重视均值回归、仓位与止损");
  else if (state === "range_bear") strategy.push("降低总仓位与追涨频率", "只保留高相对强度标的观察");
  else if (state === "bear") strategy.push("风险优先，趋势策略以减仓/观望为主", "等待指数重新站回中期趋势");

  const confidence = Math.round(clamp(valid.length / 4 * 100));
  return {
    state,
    label,
    score,
    risk,
    confidence,
    avgSignalScore: Math.round(dir),
    avgChangePercent: Math.round(chg * 100) / 100,
    bullCount,
    bearCount,
    activeCount: valid.length,
    strategy,
    indices: valid.map((x) => ({
      code: x.code,
      name: x.name,
      changePercent: x.changePercent,
      score: x.signal.score,
      direction: x.signal.direction,
      risk: x.signal.factors?.find((f) => f.key === "risk")?.score ?? null,
    })),
  };
}
