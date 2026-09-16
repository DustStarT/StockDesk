// 日线周期趋势：描述当前形态，不是未来收益预测。各周期独立计算。
export function analyzeTrendHorizons(candles = []) {
  const specs = [
    { key: "short", label: "短期", fast: 5, slow: 10, slopeDays: 3 },
    { key: "medium", label: "中期", fast: 20, slow: 60, slopeDays: 5 },
    { key: "long", label: "长期", fast: 60, slow: 120, slopeDays: 10 },
  ];
  const clamp = (v) => Math.max(-100, Math.min(100, v));
  return specs.map((s) => {
    const required = s.slow + s.slopeDays;
    const base = { ...s, period: `${s.fast}–${s.slow}交易日`, requiredBars: required, asOf: candles.at(-1)?.time || null };
    const closes = candles.slice(-required).map((c) => c.close);
    if (closes.length < required || closes.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
      return { ...base, status: "insufficient", direction: "unknown", score: null, reason: `需至少 ${required} 根有效日K，当前周期数据不足` };
    }
    const avg = (n, offset = 0) => closes.slice(closes.length-n-offset, closes.length-offset).reduce((a,b)=>a+b,0)/n;
    const close = closes.at(-1), fastMA = avg(s.fast), slowMA = avg(s.slow), oldMA = avg(s.slow, s.slopeDays);
    const returnPct = (close/closes[closes.length-1-s.slow]-1)*100;
    const positionPct = (close/slowMA-1)*100;
    const alignmentPct = (fastMA/slowMA-1)*100;
    const slopePct = (slowMA/oldMA-1)*100;
    // 每个周期使用同一口径：价格位置30%、均线结构30%、慢均线斜率20%、周期收益20%。
    const score = Math.round(clamp(positionPct*20)*.3 + clamp(alignmentPct*30)*.3 + clamp(slopePct*60)*.2 + clamp(returnPct*10)*.2);
    const direction = score >= 25 ? "bullish" : score <= -25 ? "bearish" : "neutral";
    return { ...base, status: "ok", direction, score, returnPct, positionPct, alignmentPct, slopePct, fastMA, slowMA,
      reason: `MA${s.fast}/MA${s.slow}结构、价格相对MA${s.slow}位置、均线斜率及${s.slow}日收益` };
  });
}
