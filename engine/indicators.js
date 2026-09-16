/**
 * dsh-stock-watch — 技术指标与信号引擎（host 端纯函数，无副作用）
 *
 * 输入：日K蜡烛数组 [{time, open, high, low, close, volume}]（时间升序）
 * 输出：指标快照 + 综合评分信号。
 *
 * 指标：MA(5/10/20/60)、MACD(12/26/9)、RSI(14)、KDJ(9,3,3)、
 *       布林带(20,2)、量比(volume / MA5(volume))。
 * 信号模型：多指标加权打分（-100..+100）→ 买入/卖出/观望 + 置信度 + 逐条理由。
 * 周期策略：日K定方向，分时（VWAP/均价）择时。
 *
 * 注意：本引擎仅做技术面统计分析，输出仅供参考，不构成投资建议。
 */

// ---------------------------------------------------------------------------
// 基础序列计算
// ---------------------------------------------------------------------------

/** 简单移动平均（不足 n 个数据返回 null） */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    sum += v;
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指数移动平均（首值 = 首个有效价，之后按 alpha 递推） */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    prev = prev === null ? v : v * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** 相对强弱指标 RSI(n)，返回序列（预热期为 null；n 根窗口平均涨跌比） */
export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i < 1) continue;
    const start = Math.max(1, i - n + 1);
    let avgUp = 0;
    let avgDown = 0;
    let count = 0;
    for (let j = start; j <= i; j++) {
      const vj = values[j];
      const pj = values[j - 1];
      if (typeof vj !== "number" || !Number.isFinite(vj) || typeof pj !== "number" || !Number.isFinite(pj)) continue;
      const dj = vj - pj;
      if (dj > 0) avgUp += dj;
      else avgDown -= dj;
      count += 1;
    }
    if (count === 0) continue;
    if (avgUp + avgDown > 0) out[i] = 100 * avgUp / (avgUp + avgDown);
    else out[i] = avgUp > 0 ? 100 : 50;
  }
  return out;
}

/** MACD(12,26,9)：返回 { dif, dea, hist } 三个序列 */
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const dif = values.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f === null || s === null ? null : f - s;
  });
  const dea = ema(dif.filter((v) => v !== null).length > 0 ? dif.filter((v) => v !== null) : [0], signal);
  // 与 dif 对齐（dif 前段为 null 时 dea 也为 null）
  const deaAligned = new Array(values.length).fill(null);
  let di = 0;
  for (let i = 0; i < values.length; i++) {
    if (dif[i] !== null) {
      deaAligned[i] = dea[di];
      di += 1;
    }
  }
  const hist = values.map((_, i) => (dif[i] === null || deaAligned[i] === null ? null : (dif[i] - deaAligned[i]) * 2));
  return { dif, dea: deaAligned, hist };
}

/** KDJ(9,3,3)：返回 { k, d, j } 序列 */
export function kdj(candles, n = 9, kSmooth = 3, dSmooth = 3) {
  const len = candles.length;
  const k = new Array(len).fill(null);
  const d = new Array(len).fill(null);
  const j = new Array(len).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < len; i++) {
    const start = Math.max(0, i - n + 1);
    let high = -Infinity;
    let low = Infinity;
    let ok = true;
    for (let t = start; t <= i; t++) {
      const c = candles[t];
      if (!c || typeof c.high !== "number" || typeof c.low !== "number" || !Number.isFinite(c.high) || !Number.isFinite(c.low)) { ok = false; break; }
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    }
    const c = candles[i];
    if (!ok || typeof c.close !== "number" || !Number.isFinite(c.close) || high === low) continue;
    const rsv = ((c.close - low) / (high - low)) * 100;
    const curK = (prevK * (kSmooth - 1) + rsv) / kSmooth;
    const curD = (prevD * (dSmooth - 1) + curK) / dSmooth;
    k[i] = curK;
    d[i] = curD;
    j[i] = 3 * curK - 2 * curD;
    prevK = curK;
    prevD = curD;
  }
  return { k, d, j };
}

/** 布林带(20, 2)：返回 { upper, mid, lower } 序列 */
export function boll(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (mid[i] === null) continue;
    const start = i - n + 1;
    let sum = 0;
    let count = 0;
    for (let t = Math.max(0, start); t <= i; t++) {
      const v = values[t];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const d = v - mid[i];
      sum += d * d;
      count += 1;
    }
    const sd = count > 0 ? Math.sqrt(sum / count) : 0;
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { upper, mid, lower };
}

// ---------------------------------------------------------------------------
// 交叉检测
// ---------------------------------------------------------------------------

/**
 * 在最近 lookback 根K内找 a 上穿 b（金叉）的最后一根的位置。
 * @returns { index, ago } 或 null（ago = 距最后一根的天数，0 = 今天）
 */
function crossedUp(a, b, lookback = 3) {
  const len = a.length;
  for (let i = len - 1; i >= Math.max(1, len - lookback); i--) {
    if (a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) continue;
    if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return { index: i, ago: len - 1 - i };
  }
  return null;
}

function crossedDown(a, b, lookback = 3) {
  const len = a.length;
  for (let i = len - 1; i >= Math.max(1, len - lookback); i--) {
    if (a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) continue;
    if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return { index: i, ago: len - 1 - i };
  }
  return null;
}

/** 取序列最后一个非 null 值 */
function lastOf(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return { value: series[i], index: i };
  }
  return { value: null, index: -1 };
}

// ---------------------------------------------------------------------------
// 日K指标快照
// ---------------------------------------------------------------------------

/**
 * 从日K蜡烛计算指标快照。
 * @param {Array} candles - [{time, open, high, low, close, volume}] 升序，至少 30 根
 */
export function analyzeDaily(candles) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const closes = candles.map((c) => (typeof c.close === "number" && Number.isFinite(c.close) ? c.close : null));
  const volumes = candles.map((c) => (typeof c.volume === "number" && Number.isFinite(c.volume) ? c.volume : null));

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const m = macd(closes);
  const r = rsi(closes, 14);
  const kd = kdj(candles);
  const bl = boll(closes, 20, 2);
  const volMa5 = sma(volumes, 5);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || null;
  const close = lastOf(closes).value;
  const histLast = lastOf(m.hist);
  const histPrev = m.hist[histLast.index - 1] ?? null;

  // v1.1 · 因子族需要的稳健派生指标（避免重复使用同一指标投票）
  const retN = (n) => {
    if (closes.length <= n || close == null) return null;
    const base = closes[closes.length - 1 - n];
    return typeof base === "number" && Number.isFinite(base) && base > 0 ? (close / base - 1) * 100 : null;
  };
  const highN = (n) => {
    const seg = candles.slice(-n).map((c) => c.high).filter((v) => typeof v === "number" && Number.isFinite(v));
    return seg.length ? Math.max(...seg) : null;
  };
  const lowN = (n) => {
    const seg = candles.slice(-n).map((c) => c.low).filter((v) => typeof v === "number" && Number.isFinite(v));
    return seg.length ? Math.min(...seg) : null;
  };
  const atrPct = (() => {
    if (candles.length < 15 || close == null || close <= 0) return null;
    const trs = [];
    for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) {
      const c = candles[i], pc = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close));
      if (Number.isFinite(tr)) trs.push(tr);
    }
    return trs.length ? (trs.reduce((a, b) => a + b, 0) / trs.length) / close * 100 : null;
  })();
  const volatility20 = (() => {
    if (closes.length < 21) return null;
    const seg = closes.slice(-21);
    const rs = [];
    for (let i = 1; i < seg.length; i++) if (seg[i] > 0 && seg[i - 1] > 0) rs.push(seg[i] / seg[i - 1] - 1);
    if (rs.length < 5) return null;
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rs.length - 1);
    return Math.sqrt(variance) * Math.sqrt(244) * 100;
  })();
  const h20 = highN(20), l20 = lowN(20);

  return {
    close,
    prevClose: prev && typeof prev.close === "number" ? prev.close : null,
    ma5: lastOf(ma5).value,
    ma10: lastOf(ma10).value,
    ma20: lastOf(ma20).value,
    ma60: lastOf(ma60).value,
    macd: { dif: lastOf(m.dif).value, dea: lastOf(m.dea).value, hist: histLast.value, histPrev },
    rsi: lastOf(r).value,
    kdj: { k: lastOf(kd.k).value, d: lastOf(kd.d).value, j: lastOf(kd.j).value },
    boll: { upper: lastOf(bl.upper).value, mid: lastOf(bl.mid).value, lower: lastOf(bl.lower).value },
    volMa5: lastOf(volMa5).value,
    volume: typeof last.volume === "number" ? last.volume : null,
    volRatio: (() => {
      const vm = lastOf(volMa5).value;
      const v = typeof last.volume === "number" ? last.volume : null;
      return vm > 0 && v !== null ? v / vm : null;
    })(),
    ret20: retN(20),
    ret60: retN(60),
    atr14Pct: atrPct,
    volatility20,
    high20: h20,
    low20: l20,
    pctFrom20dHigh: h20 > 0 && close != null ? (close / h20 - 1) * 100 : null,
    pctFromMa20: lastOf(ma20).value > 0 && close != null ? (close / lastOf(ma20).value - 1) * 100 : null,
    crosses: {
      ma5x10: { up: crossedUp(ma5, ma10, 3), down: crossedDown(ma5, ma10, 3) },
      ma10x20: { up: crossedUp(ma10, ma20, 3), down: crossedDown(ma10, ma20, 3) },
      macd: { up: crossedUp(m.dif, m.dea, 3), down: crossedDown(m.dif, m.dea, 3) },
      kdj: { up: crossedUp(kd.k, kd.d, 3), down: crossedDown(kd.k, kd.d, 3) },
    },
  };
}

// ---------------------------------------------------------------------------
// 综合评分信号
// ---------------------------------------------------------------------------

/**
 * 多指标加权打分：输出 verdict（buy/sell/hold）、direction、score、signals。
 * @param {object} s - analyzeDaily 的快照
 */
export function analyzeSignals(s) {
  if (!s) return null;
  const clamp = (v, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, v));
  const nz = (v) => typeof v === "number" && Number.isFinite(v);
  const compare = (a, b) => Math.abs(a-b) <= Math.max(1, Math.abs(a), Math.abs(b))*1e-8 ? 0 : a > b ? 1 : -1;
  const evidence = [];
  const addEvidence = (type, label, reason, weight = 0) => evidence.push({ type, label, reason, weight: Math.round(weight) });

  // ── 1. 趋势因子：只聚合趋势家族，不让 MA/MACD/价格位置重复计票 ──
  let trend = 0, trendN = 0;
  if ([s.ma5, s.ma10, s.ma20].every(nz)) {
    trend += s.ma5 > s.ma10 && s.ma10 > s.ma20 ? 70 : s.ma5 < s.ma10 && s.ma10 < s.ma20 ? -70 : 0;
    trendN++;
  }
  if (nz(s.close) && nz(s.ma20)) { trend += compare(s.close, s.ma20) * 45; trendN++; }
  if (nz(s.ma20) && nz(s.ma60)) { trend += compare(s.ma20, s.ma60) * 55; trendN++; }
  const c510 = s.crosses?.ma5x10 || {};
  if (c510.up) { trend += 35; trendN++; addEvidence("buy", "趋势转强", `MA5 上穿 MA10（${c510.up.ago}天前）`, 8); }
  else if (c510.down) { trend -= 35; trendN++; addEvidence("sell", "趋势转弱", `MA5 下穿 MA10（${c510.down.ago}天前）`, -8); }
  trend = trendN ? clamp(trend / trendN) : 0;

  // ── 2. 动量因子：MACD/RSI/中期收益先归并，再参与总分 ──
  let momentum = 0, momentumN = 0;
  if (nz(s.macd?.hist)) {
    let m = s.macd.hist > 0 ? 45 : s.macd.hist < 0 ? -45 : 0;
    if (nz(s.macd.histPrev)) {
      if (s.macd.hist > s.macd.histPrev && s.macd.hist > 0) m += 15;
      if (s.macd.hist < s.macd.histPrev && s.macd.hist < 0) m -= 15;
    }
    momentum += clamp(m); momentumN++;
  }
  if (nz(s.rsi)) {
    let r = 0;
    if (s.rsi >= 55 && s.rsi <= 70) r = 45;
    else if (s.rsi > 70) r = 25; // 强势但过热，方向仍偏多，风险在 risk 因子处理
    else if (s.rsi <= 30) r = -25;
    else if (s.rsi < 45) r = -35;
    momentum += r; momentumN++;
  }
  if (nz(s.ret20)) { momentum += clamp(s.ret20 * 5, -70, 70); momentumN++; }
  if (nz(s.ret60)) { momentum += clamp(s.ret60 * 2.5, -70, 70); momentumN++; }
  const cm = s.crosses?.macd || {};
  if (cm.up) addEvidence("buy", "MACD转强", `DIF 上穿 DEA（${cm.up.ago}天前）`, 6);
  else if (cm.down) addEvidence("sell", "MACD转弱", `DIF 下穿 DEA（${cm.down.ago}天前）`, -6);
  momentum = momentumN ? clamp(momentum / momentumN) : 0;

  // ── 3. 量价因子：量能本身不决定多空，必须结合价格方向/突破状态 ──
  let volume = 0, volumeN = 0;
  if (nz(s.volRatio)) {
    const dayUp = nz(s.prevClose) && nz(s.close) ? s.close >= s.prevClose : null;
    if (s.volRatio >= 2) volume = dayUp === true ? 75 : dayUp === false ? -75 : 0;
    else if (s.volRatio >= 1.35) volume = dayUp === true ? 45 : dayUp === false ? -45 : 0;
    else if (s.volRatio < 0.65) volume = 0; // 缩量本身只作为状态，不强行给方向
    volumeN = 1;
  }
  if (nz(s.pctFrom20dHigh) && s.pctFrom20dHigh >= -0.5) {
    volume += nz(s.volRatio) && s.volRatio >= 1.35 ? 65 : 25;
    volumeN++;
    addEvidence("buy", "接近20日新高", `距离20日高点 ${s.pctFrom20dHigh.toFixed(2)}%${nz(s.volRatio) ? `，量比 ${s.volRatio.toFixed(2)}` : ""}`, 7);
  }
  volume = volumeN ? clamp(volume / volumeN) : 0;

  // ── 4. 风险因子：0=低风险，100=高风险；只降低动作强度，不反向制造卖点 ──
  let riskParts = [];
  if (nz(s.rsi)) {
    if (s.rsi >= 80) riskParts.push(90);
    else if (s.rsi >= 72) riskParts.push(70);
    else if (s.rsi <= 25) riskParts.push(70);
    else riskParts.push(35);
  }
  if (nz(s.pctFromMa20)) {
    const d = Math.abs(s.pctFromMa20);
    riskParts.push(d >= 20 ? 90 : d >= 12 ? 70 : d >= 7 ? 50 : 25);
  }
  if (nz(s.atr14Pct)) riskParts.push(s.atr14Pct >= 6 ? 90 : s.atr14Pct >= 4 ? 70 : s.atr14Pct >= 2.5 ? 50 : 30);
  if (nz(s.volatility20)) riskParts.push(s.volatility20 >= 60 ? 90 : s.volatility20 >= 40 ? 70 : s.volatility20 >= 25 ? 50 : 30);
  const risk = riskParts.length ? Math.round(riskParts.reduce((a, b) => a + b, 0) / riskParts.length) : 50;

  // 各家族只投一票，避免同源指标重复加权。
  const rawDirectional = trend * 0.45 + momentum * 0.35 + volume * 0.20;
  const riskDamp = risk > 60 ? Math.max(0.72, 1 - (risk - 60) / 140) : 1;
  const score = Math.round(clamp(rawDirectional * riskDamp));
  const verdict = score >= 25 ? "buy" : score <= -25 ? "sell" : "hold";
  const direction = verdict === "buy" ? "bullish" : verdict === "sell" ? "bearish" : "neutral";

  // 数据完整度：这是“有多少输入可用”，不是预测概率。
  const qualityFields = [s.ma5, s.ma10, s.ma20, s.ma60, s.macd?.hist, s.rsi, s.kdj?.k, s.boll?.mid, s.volRatio, s.ret20, s.ret60, s.atr14Pct];
  const validFields = qualityFields.filter(nz).length;
  const dataQuality = Math.round(validFields / qualityFields.length * 100);

  const factorList = [
    { key: "trend", label: "趋势", score: Math.round(trend), directional: true },
    { key: "momentum", label: "动量", score: Math.round(momentum), directional: true },
    { key: "volume", label: "量价", score: Math.round(volume), directional: true },
    { key: "risk", label: "波动风险", score: risk, directional: false },
  ];
  addEvidence(trend >= 20 ? "buy" : trend <= -20 ? "sell" : "info", "趋势因子", `趋势族评分 ${Math.round(trend)}`, Math.round(trend * 0.18));
  addEvidence(momentum >= 20 ? "buy" : momentum <= -20 ? "sell" : "info", "动量因子", `动量族评分 ${Math.round(momentum)}`, Math.round(momentum * 0.14));
  if (Math.abs(volume) >= 20) addEvidence(volume > 0 ? "buy" : "sell", "量价因子", `量价族评分 ${Math.round(volume)}`, Math.round(volume * 0.08));
  if (risk >= 70) addEvidence("info", "风险偏高", `波动/偏离综合风险 ${risk}/100，仅折减强度，不代表看空`, 0);
  else addEvidence("info", "风险水平", `波动/偏离综合风险 ${risk}/100`, 0);

  // 保留少量事件型证据，避免面板丢失可解释性。
  const ck = s.crosses?.kdj || {};
  if (ck.up) addEvidence("buy", "KDJ金叉", `K 上穿 D（${ck.up.ago}天前）`, 3);
  else if (ck.down) addEvidence("sell", "KDJ死叉", `K 下穿 D（${ck.down.ago}天前）`, -3);
  if (nz(s.volRatio) && s.volRatio >= 2) addEvidence(nz(s.prevClose) && s.close >= s.prevClose ? "buy" : "sell", "成交量异常", `量比 ${s.volRatio.toFixed(2)}`, nz(s.prevClose) && s.close >= s.prevClose ? 5 : -5);

  const summary = `${direction === "bullish" ? "偏多" : direction === "bearish" ? "偏空" : "中性"} · 趋势${Math.round(trend)} / 动量${Math.round(momentum)} / 量价${Math.round(volume)} · 风险${risk}`;
  return {
    score,
    verdict,
    direction,
    confidence: dataQuality, // 向后兼容旧 UI；v1.1 UI 改称“数据完整度”
    dataQuality,
    reliability: null,
    factors: factorList,
    signals: evidence.slice(0, 9),
    summary,
  };
}

/**
 * v1.1 · 历史信号验证。
 * 用同一套当前规则在历史截面重放，仅使用当时可见的数据，避免未来数据泄漏。
 * 这不是“预测概率”，而是该类信号在当前样本内的历史统计表现。
 */
export function validateSignalHistory(candles, currentSignal = null, horizons = [1, 5, 20]) {
  if (!Array.isArray(candles) || candles.length < 90) return { status: "insufficient", sampleSize: 0, horizons: {} };
  const current = currentSignal || analyzeSignals(analyzeDaily(candles));
  if (!current || current.direction === "neutral") return { status: "neutral", sampleSize: 0, horizons: {} };
  const maxH = Math.max(...horizons);
  const targetSign = current.direction === "bullish" ? 1 : -1;
  const minAbs = Math.max(20, Math.min(55, Math.abs(current.score) * 0.60));
  const matches = [];
  const start = Math.max(60, candles.length - 180);
  for (let i = start; i < candles.length - maxH; i++) {
    const snap = analyzeDaily(candles.slice(0, i + 1));
    const sig = analyzeSignals(snap);
    if (!sig) continue;
    const sameDirection = targetSign > 0 ? sig.score >= minAbs : sig.score <= -minAbs;
    if (!sameDirection) continue;
    const base = candles[i]?.close;
    if (!(base > 0)) continue;
    const outcome = {};
    for (const h of horizons) {
      const future = candles[i + h]?.close;
      if (future > 0) outcome[h] = (future / base - 1) * 100;
    }
    matches.push(outcome);
  }
  const stats = {};
  for (const h of horizons) {
    const vals = matches.map((m) => m[h]).filter((v) => Number.isFinite(v));
    if (!vals.length) continue;
    const signed = vals.map((v) => v * targetSign);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const hit = signed.filter((v) => v > 0).length / signed.length * 100;
    stats[h] = { n: vals.length, avgReturn: Math.round(avg * 100) / 100, medianReturn: Math.round(med * 100) / 100, hitRate: Math.round(hit * 10) / 10 };
  }
  const sampleSize = matches.length;
  const anchor = stats[5] || stats[20] || stats[1];
  const reliability = anchor && sampleSize >= 8
    ? Math.round(Math.max(0, Math.min(100, anchor.hitRate * Math.min(1, Math.sqrt(sampleSize / 30)))))
    : null;
  return { status: sampleSize >= 8 ? "ok" : "low_sample", sampleSize, direction: current.direction, threshold: Math.round(minAbs), reliability, horizons: stats };
}

// ---------------------------------------------------------------------------
// 分时择时（日K定方向后，用分时均价找买卖点）
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *   - points: [{t, p, v}] 分钟点（升序）
 *   - prevClose: 昨收
 *   - price: 现价
 *   - direction: analyzeSignals 的 direction（bullish/bearish/neutral）
 * @returns {{ type: "buy"|"sell"|"info", hint: string } | null}
 */
export function computeTiming({ points, prevClose, price, direction }) {
  if (!Array.isArray(points) || points.length < 5) return null;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;

  // VWAP（成交量缺失时退化为均价）
  let pv = 0;
  let vv = 0;
  let psum = 0;
  for (const pt of points) {
    const p = typeof pt.p === "number" ? pt.p : null;
    const v = typeof pt.v === "number" ? pt.v : null;
    if (p === null || !Number.isFinite(p)) continue;
    psum += p;
    if (v !== null && Number.isFinite(v) && v > 0) {
      pv += p * v;
      vv += v;
    }
  }
  const vwap = vv > 0 ? pv / vv : psum / points.length;
  if (!Number.isFinite(vwap) || vwap <= 0) return null;

  // 最近 3 分钟点的方向
  const tail = points.slice(-3).map((x) => x.p).filter((x) => typeof x === "number" && Number.isFinite(x));
  const rising = tail.length >= 2 && tail[tail.length - 1] > tail[0];
  const falling = tail.length >= 2 && tail[tail.length - 1] < tail[0];

  const aboveVwap = price > vwap * 1.002;
  const belowVwap = price < vwap * 0.998;

  if (direction === "bullish") {
    if (belowVwap && rising) return { type: "buy", hint: "回踩均价企稳，日内买点" };
    if (aboveVwap && rising) return { type: "info", hint: "沿均价上方上行，持有观察" };
    if (aboveVwap && falling) return { type: "info", hint: "冲高回落，勿追高" };
    return { type: "info", hint: "站上均价，等待企稳" };
  }
  if (direction === "bearish") {
    if (aboveVwap && falling) return { type: "sell", hint: "反抽均价受阻，日内卖点" };
    if (belowVwap && falling) return { type: "info", hint: "沿均价下方下行，弱势观望" };
    if (belowVwap && rising) return { type: "info", hint: "超跌反弹，关注力度" };
    return { type: "info", hint: "跌破均价，反弹减仓" };
  }
  if (aboveVwap && rising) return { type: "info", hint: "站上均价走强，可关注" };
  if (belowVwap && falling) return { type: "info", hint: "跌破均价走弱，观望" };
  return { type: "info", hint: "围绕均价震荡，等待方向" };
}
