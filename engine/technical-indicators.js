/**
 * StockDesk v1.3 · 常用技术指标库
 *
 * 目标：为桌面端“指标分屏”与 AI 研报提供统一、可测试的指标结果。
 * 说明：不同行情软件对个别国内指标（FSL/EMV/MCST/MIKE）的参数与平滑细节
 * 可能略有差异；这里采用公开常见定义，并在返回 note 中明确近似项。
 */

const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const nval = (v, d = null) => finite(v) ? Number(v) : d;

function arrOf(candles, key) { return candles.map((c) => nval(c?.[key], 0)); }
function nulls(n) { return new Array(n).fill(null); }

function sma(values, period) {
  const out = nulls(values.length);
  let sum = 0, valid = 0;
  const q = [];
  for (let i = 0; i < values.length; i++) {
    const v = nval(values[i]);
    q.push(v);
    if (v != null) { sum += v; valid++; }
    if (q.length > period) {
      const old = q.shift();
      if (old != null) { sum -= old; valid--; }
    }
    if (q.length === period && valid === period) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = nulls(values.length);
  const alpha = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = nval(values[i]);
    if (v == null) continue;
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

// 通达信/国内指标中常见的 SMA(X,N,M)：Y=(M*X+(N-M)*Y')/N
function cnSma(values, period, m = 1, seed = null) {
  const out = nulls(values.length);
  let prev = seed;
  for (let i = 0; i < values.length; i++) {
    const v = nval(values[i]);
    if (v == null) continue;
    if (prev == null) prev = v;
    else prev = (m * v + (period - m) * prev) / period;
    out[i] = prev;
  }
  return out;
}

function rolling(values, period, fn) {
  const out = nulls(values.length);
  for (let i = period - 1; i < values.length; i++) {
    const w = values.slice(i - period + 1, i + 1).map((x) => nval(x)).filter((x) => x != null);
    if (w.length === period) out[i] = fn(w);
  }
  return out;
}
function rsum(v, p) { return rolling(v, p, (w) => w.reduce((a, b) => a + b, 0)); }
function rmax(v, p) { return rolling(v, p, (w) => Math.max(...w)); }
function rmin(v, p) { return rolling(v, p, (w) => Math.min(...w)); }
function rstd(v, p) {
  return rolling(v, p, (w) => {
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
  });
}
function map2(a, b, fn) {
  return a.map((x, i) => (nval(x) == null || nval(b[i]) == null) ? null : fn(Number(x), Number(b[i]), i));
}
function latest(values) {
  for (let i = values.length - 1; i >= 0; i--) if (nval(values[i]) != null) return Number(values[i]);
  return null;
}
function line(name, values, extra = {}) { return { name, values, type: "line", ...extra }; }
function bar(name, values, extra = {}) { return { name, values, type: "bar", ...extra }; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }
function pnum(params, key, def, lo, hi, integer = true) {
  let v = Number(params?.[key]);
  if (!Number.isFinite(v)) v = def;
  v = Math.max(lo, Math.min(hi, v));
  return integer ? Math.round(v) : v;
}
function prevFinite(values, back = 1) {
  let n = 0;
  for (let i = values.length - 1; i >= 0; i--) if (nval(values[i]) != null) { if (n++ >= back) return Number(values[i]); }
  return null;
}

export const INDICATOR_CATALOG = [
  { id:"MACD", name:"MACD 平滑异同平均线", group:"趋势/动量", family:"trend", params:[P("fast","短周期",12,2,60),P("slow","长周期",26,3,120),P("signal","信号周期",9,2,60)] },
  { id:"DMI", name:"DMI 趋向指标", group:"趋势", family:"trend", params:[P("period","DI周期",14,5,60),P("adxPeriod","ADX周期",14,5,60)] },
  { id:"DMA", name:"DMA 平均差", group:"趋势", family:"trend", params:[P("short","短均线",10,2,60),P("long","长均线",50,5,180),P("signal","信号均线",10,2,60)] },
  { id:"FSL", name:"FSL 分水岭", group:"趋势", family:"trend", params:[P("fast","快速EMA",5,2,30),P("slow","慢速EMA",10,3,60),P("signal","分水岭EMA",20,5,120)] },
  { id:"TRIX", name:"TRIX 三重指数平均线", group:"趋势", family:"trend", params:[P("period","TRIX周期",12,3,60),P("signal","信号周期",9,2,60)] },
  { id:"BRAR", name:"BRAR 情绪指标", group:"情绪", family:"sentiment", params:[P("period","统计周期",26,5,120)] },
  { id:"CR", name:"CR 带状能量线", group:"情绪", family:"sentiment", params:[P("period","CR周期",26,5,120),P("maShort","短均线",5,2,30),P("maLong","长均线",10,3,60)] },
  { id:"VR", name:"VR 成交量变异率", group:"量价", family:"volume", params:[P("period","统计周期",26,5,120)] },
  { id:"OBV", name:"OBV 累积能量线", group:"量价", family:"volume", params:[P("maPeriod","OBV均线",30,3,120)] },
  { id:"ASI", name:"ASI 振动升降指标", group:"趋势", family:"trend", params:[P("maPeriod","ASI均线",10,2,60)] },
  { id:"EMV", name:"EMV 简易波动指标", group:"量价", family:"volume", params:[P("period","EMV周期",14,3,60),P("signal","信号周期",9,2,60)] },
  { id:"VOL", name:"VOL-TDX 成交量", group:"量价", family:"volume", params:[P("maShort","短均量",5,2,30),P("maLong","长均量",10,3,90)] },
  { id:"RSI", name:"RSI 相对强弱指标", group:"动量", family:"momentum", params:[P("p1","短周期",6,2,30),P("p2","中周期",12,3,60),P("p3","长周期",24,5,120)] },
  { id:"WR", name:"WR 威廉指标", group:"动量", family:"momentum", params:[P("p1","周期1",10,2,60),P("p2","周期2",6,2,60)] },
  { id:"SAR", name:"SAR 抛物线指标", group:"趋势", family:"trend", params:[P("step","加速步长",0.02,0.005,0.1,false),P("maxAf","最大加速",0.2,0.05,0.5,false)] },
  { id:"KDJ", name:"KDJ 随机指标", group:"动量", family:"momentum", params:[P("period","RSV周期",9,3,60),P("kSmooth","K平滑",3,2,20),P("dSmooth","D平滑",3,2,20)] },
  { id:"CCI", name:"CCI 商品路径指标", group:"动量", family:"momentum", params:[P("period","CCI周期",14,5,90)] },
  { id:"ROC", name:"ROC 变动率指标", group:"动量", family:"momentum", params:[P("period","ROC周期",12,2,90),P("signal","信号均线",6,2,60)] },
  { id:"MIKE", name:"MIKE 支撑压力", group:"支撑压力", family:"support", params:[P("period","区间周期",12,5,90)] },
  { id:"BOLL", name:"BOLL 布林线", group:"波动", family:"volatility", params:[P("period","中轨周期",20,5,120),P("mult","标准差倍数",2,0.5,4,false)] },
  { id:"PSY", name:"PSY 心理线", group:"情绪", family:"sentiment", params:[P("period","统计周期",12,3,60),P("maPeriod","PSY均线",6,2,30)] },
  { id:"MCST", name:"MCST 市场成本线", group:"成本", family:"cost", params:[P("fallbackPeriod","缺股本时VWAP周期",20,5,120)] },
];

function P(key, label, def, min, max, integer = true) { return { key, label, default: def, min, max, step: integer ? 1 : (key === "step" ? 0.005 : 0.1), integer }; }

export function defaultIndicatorParams(id) {
  const meta = INDICATOR_CATALOG.find((x) => x.id === String(id || "").toUpperCase());
  return Object.fromEntries((meta?.params || []).map((p) => [p.key, p.default]));
}

export function sanitizeIndicatorParams(id, params = {}) {
  const meta = INDICATOR_CATALOG.find((x) => x.id === String(id || "").toUpperCase());
  if (!meta) return {};
  const out = {};
  for (const spec of meta.params || []) out[spec.key] = pnum(params, spec.key, spec.default, spec.min, spec.max, spec.integer !== false);
  if (["MACD","DMA","FSL"].includes(meta.id)) {
    const a = meta.id === "DMA" ? "short" : "fast", b = meta.id === "DMA" ? "long" : "slow";
    if (out[a] >= out[b]) out[b] = Math.min((meta.params.find((p) => p.key === b)?.max || 240), out[a] + 1);
  }
  if (meta.id === "RSI") { const xs=[out.p1,out.p2,out.p3].sort((a,b)=>a-b); [out.p1,out.p2,out.p3]=xs; }
  return out;
}

export function getIndicatorCatalog() { return INDICATOR_CATALOG.map((x) => ({ ...x, params: (x.params || []).map((p) => ({ ...p })), defaultParams: defaultIndicatorParams(x.id) })); }

function macd(c, params = {}) {
  const p = sanitizeIndicatorParams("MACD", params);
  const close = arrOf(c, "close"), e12 = ema(close, p.fast), e26 = ema(close, p.slow);
  const dif = map2(e12, e26, (a, b) => a - b);
  const dea = ema(dif, p.signal);
  const hist = map2(dif, dea, (a, b) => 2 * (a - b));
  return { lines: [line("DIF", dif), line("DEA", dea), bar("MACD", hist, { zeroLine: true })], guides: [{ value: 0, label: "0" }] };
}

function dmi(c, params = {}) {
  const p = sanitizeIndicatorParams("DMI", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), cl = arrOf(c, "close");
  const tr = nulls(c.length), pdm = nulls(c.length), mdm = nulls(c.length);
  for (let i = 1; i < c.length; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - cl[i - 1]), Math.abs(l[i] - cl[i - 1]));
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr14 = rsum(tr, p.period), p14 = rsum(pdm, p.period), m14 = rsum(mdm, p.period);
  const pdi = tr14.map((x, i) => nval(x) != null && x !== 0 ? 100 * p14[i] / x : null);
  const mdi = tr14.map((x, i) => nval(x) != null && x !== 0 ? 100 * m14[i] / x : null);
  const dx = pdi.map((p, i) => nval(p) != null && nval(mdi[i]) != null && p + mdi[i] !== 0 ? 100 * Math.abs(p - mdi[i]) / (p + mdi[i]) : null);
  const adx = sma(dx, p.adxPeriod);
  return { lines: [line("+DI", pdi), line("-DI", mdi), line("ADX", adx)], guides: [{ value: 20, label: "20" }, { value: 40, label: "40" }] };
}

function dma(c, params = {}) {
  const p = sanitizeIndicatorParams("DMA", params);
  const close = arrOf(c, "close");
  const m10 = sma(close, p.short), m50 = sma(close, p.long);
  const dif = map2(m10, m50, (a, b) => a - b), ama = sma(dif, p.signal);
  return { lines: [line("DMA", dif), line("AMA", ama)], guides: [{ value: 0, label: "0" }] };
}

function fsl(c, params = {}) {
  const p = sanitizeIndicatorParams("FSL", params);
  const close = arrOf(c, "close"), e5 = ema(close, p.fast), e10 = ema(close, p.slow);
  const swl = e5.map((v, i) => nval(v) != null && nval(e10[i]) != null ? (7 * v + 3 * e10[i]) / 10 : null);
  const sws = ema(swl, p.signal);
  return { lines: [line("SWL", swl), line("SWS", sws)], note: "FSL 各终端公式存在差异；本版采用双EMA分水岭近似，适合趋势比较，不保证与券商终端逐点一致。" };
}

function trix(c, params = {}) {
  const p = sanitizeIndicatorParams("TRIX", params);
  const close = arrOf(c, "close"), e1 = ema(close, p.period), e2 = ema(e1, p.period), e3 = ema(e2, p.period);
  const t = e3.map((v, i) => i > 0 && nval(e3[i - 1]) != null && e3[i - 1] !== 0 ? (v / e3[i - 1] - 1) * 100 : null);
  return { lines: [line("TRIX", t), line("MATRIX", sma(t, p.signal))], guides: [{ value: 0, label: "0" }] };
}

function brar(c, params = {}) {
  const p = sanitizeIndicatorParams("BRAR", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), o = arrOf(c, "open"), cl = arrOf(c, "close");
  const arNum = h.map((v, i) => Math.max(0, v - o[i]));
  const arDen = o.map((v, i) => Math.max(0, v - l[i]));
  const brNum = h.map((v, i) => i ? Math.max(0, v - cl[i - 1]) : null);
  const brDen = l.map((v, i) => i ? Math.max(0, cl[i - 1] - v) : null);
  const an = rsum(arNum, p.period), ad = rsum(arDen, p.period), bn = rsum(brNum, p.period), bd = rsum(brDen, p.period);
  const ar = an.map((v, i) => nval(v) != null && ad[i] ? 100 * v / ad[i] : null);
  const br = bn.map((v, i) => nval(v) != null && bd[i] ? 100 * v / bd[i] : null);
  return { lines: [line("AR", ar), line("BR", br)], guides: [{ value: 100, label: "100" }] };
}

function cr(c, params = {}) {
  const p = sanitizeIndicatorParams("CR", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low");
  const mid = h.map((v, i) => (v + l[i]) / 2);
  const num = h.map((v, i) => i ? Math.max(0, v - mid[i - 1]) : null);
  const den = l.map((v, i) => i ? Math.max(0, mid[i - 1] - v) : null);
  const sn = rsum(num, p.period), sd = rsum(den, p.period);
  const val = sn.map((v, i) => nval(v) != null && sd[i] ? 100 * v / sd[i] : null);
  return { lines: [line("CR", val), line(`MA${p.maShort}`, sma(val, p.maShort)), line(`MA${p.maLong}`, sma(val, p.maLong))], guides: [{ value: 100, label: "100" }] };
}

function vr(c, params = {}) {
  const p = sanitizeIndicatorParams("VR", params);
  const cl = arrOf(c, "close"), vol = arrOf(c, "volume");
  const up = nulls(c.length), dn = nulls(c.length), eq = nulls(c.length);
  for (let i = 1; i < c.length; i++) {
    up[i] = cl[i] > cl[i - 1] ? vol[i] : 0;
    dn[i] = cl[i] < cl[i - 1] ? vol[i] : 0;
    eq[i] = cl[i] === cl[i - 1] ? vol[i] : 0;
  }
  const su = rsum(up, p.period), sd = rsum(dn, p.period), se = rsum(eq, p.period);
  const v = su.map((x, i) => nval(x) != null && (sd[i] + (se[i] || 0) / 2) !== 0 ? 100 * (x + (se[i] || 0) / 2) / (sd[i] + (se[i] || 0) / 2) : null);
  return { lines: [line("VR", v)], guides: [{ value: 70, label: "70" }, { value: 160, label: "160" }, { value: 350, label: "350" }] };
}

function obv(c, params = {}) {
  const p = sanitizeIndicatorParams("OBV", params);
  const cl = arrOf(c, "close"), vol = arrOf(c, "volume"), out = nulls(c.length);
  let acc = 0;
  for (let i = 0; i < c.length; i++) {
    if (i === 0) acc = vol[i];
    else if (cl[i] > cl[i - 1]) acc += vol[i];
    else if (cl[i] < cl[i - 1]) acc -= vol[i];
    out[i] = acc;
  }
  return { lines: [line("OBV", out), line(`MA${p.maPeriod}`, sma(out, p.maPeriod))] };
}

function asi(c, params = {}) {
  const p = sanitizeIndicatorParams("ASI", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), o = arrOf(c, "open"), cl = arrOf(c, "close");
  const si = nulls(c.length), asiV = nulls(c.length); let acc = 0;
  for (let i = 1; i < c.length; i++) {
    const A = Math.abs(h[i] - cl[i - 1]), B = Math.abs(l[i] - cl[i - 1]), C = Math.abs(h[i] - l[i]), D = Math.abs(cl[i - 1] - o[i - 1]);
    let R;
    if (A >= B && A >= C) R = A + B / 2 + D / 4;
    else if (B >= A && B >= C) R = B + A / 2 + D / 4;
    else R = C + D / 4;
    const X = (cl[i] - cl[i - 1]) + (cl[i] - o[i]) / 2 + (cl[i - 1] - o[i - 1]);
    const K = Math.max(A, B);
    si[i] = R ? 16 * X / R * K : 0;
    acc += si[i]; asiV[i] = acc;
  }
  return { lines: [line("ASI", asiV), line("ASIT", sma(asiV, p.maPeriod))], guides: [{ value: 0, label: "0" }] };
}

function emv(c, params = {}) {
  const p = sanitizeIndicatorParams("EMV", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), vol = arrOf(c, "volume"), raw = nulls(c.length);
  for (let i = 1; i < c.length; i++) {
    const midMove = ((h[i] + l[i]) - (h[i - 1] + l[i - 1])) / 2;
    const range = Math.max(1e-9, h[i] - l[i]);
    raw[i] = midMove * range / Math.max(1, vol[i]) * 1e6;
  }
  const e = sma(raw, p.period);
  return { lines: [line("EMV", e), line("MAEMV", sma(e, p.signal))], guides: [{ value: 0, label: "0" }], note: "EMV 已按成交量尺度归一化；不同终端显示数值可有比例差异，方向与拐点更有参考意义。" };
}

function volTdx(c, params = {}) {
  const p = sanitizeIndicatorParams("VOL", params);
  const v = arrOf(c, "volume");
  return { lines: [bar("VOL", v), line(`MA${p.maShort}`, sma(v, p.maShort)), line(`MA${p.maLong}`, sma(v, p.maLong))] };
}

function rsiOne(close, p) {
  const up = nulls(close.length), ab = nulls(close.length);
  for (let i = 1; i < close.length; i++) { const d = close[i] - close[i - 1]; up[i] = Math.max(0, d); ab[i] = Math.abs(d); }
  const su = cnSma(up, p, 1), sa = cnSma(ab, p, 1);
  return su.map((v, i) => nval(v) != null && sa[i] ? 100 * v / sa[i] : null);
}
function rsi(c, params = {}) {
  const p = sanitizeIndicatorParams("RSI", params);
  const cl = arrOf(c, "close");
  return { lines: [line(`RSI${p.p1}`, rsiOne(cl, p.p1)), line(`RSI${p.p2}`, rsiOne(cl, p.p2)), line(`RSI${p.p3}`, rsiOne(cl, p.p3))], guides: [{ value: 30, label: "30" }, { value: 50, label: "50" }, { value: 70, label: "70" }] };
}

function wr(c, params = {}) {
  const p = sanitizeIndicatorParams("WR", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), cl = arrOf(c, "close");
  const one = (p) => { const hh = rmax(h, p), ll = rmin(l, p); return cl.map((v, i) => nval(hh[i]) != null && hh[i] !== ll[i] ? 100 * (hh[i] - v) / (hh[i] - ll[i]) : null); };
  return { lines: [line(`WR${p.p1}`, one(p.p1)), line(`WR${p.p2}`, one(p.p2))], guides: [{ value: 20, label: "20" }, { value: 80, label: "80" }] };
}

function sar(c, params = {}) {
  const p = sanitizeIndicatorParams("SAR", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), cl = arrOf(c, "close"), out = nulls(c.length);
  if (c.length < 2) return { lines: [line("SAR", out)] };
  let up = cl[1] >= cl[0], af = p.step, ep = up ? h[0] : l[0], s = up ? l[0] : h[0];
  out[0] = s;
  for (let i = 1; i < c.length; i++) {
    s = s + af * (ep - s);
    if (up) {
      s = Math.min(s, l[i - 1], i > 1 ? l[i - 2] : l[i - 1]);
      if (l[i] < s) { up = false; s = ep; ep = l[i]; af = p.step; }
      else if (h[i] > ep) { ep = h[i]; af = Math.min(p.maxAf, af + p.step); }
    } else {
      s = Math.max(s, h[i - 1], i > 1 ? h[i - 2] : h[i - 1]);
      if (h[i] > s) { up = true; s = ep; ep = h[i]; af = p.step; }
      else if (l[i] < ep) { ep = l[i]; af = Math.min(p.maxAf, af + p.step); }
    }
    out[i] = s;
  }
  return { lines: [line("SAR", out)] };
}

function kdj(c, params = {}) {
  const p = sanitizeIndicatorParams("KDJ", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), cl = arrOf(c, "close"), hh = rmax(h, p.period), ll = rmin(l, p.period);
  const rsv = cl.map((v, i) => nval(hh[i]) != null && hh[i] !== ll[i] ? 100 * (v - ll[i]) / (hh[i] - ll[i]) : null);
  const k = cnSma(rsv, p.kSmooth, 1, 50), d = cnSma(k, p.dSmooth, 1, 50), j = map2(k, d, (a, b) => 3 * a - 2 * b);
  return { lines: [line("K", k), line("D", d), line("J", j)], guides: [{ value: 20, label: "20" }, { value: 80, label: "80" }] };
}

function cci(c, params = {}) {
  const p = sanitizeIndicatorParams("CCI", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), cl = arrOf(c, "close"), tp = h.map((v, i) => (v + l[i] + cl[i]) / 3), ma = sma(tp, p.period), out = nulls(c.length);
  for (let i = p.period - 1; i < c.length; i++) {
    if (ma[i] == null) continue;
    const w = tp.slice(i - p.period + 1, i + 1), md = w.reduce((a, x) => a + Math.abs(x - ma[i]), 0) / p.period;
    out[i] = md ? (tp[i] - ma[i]) / (0.015 * md) : 0;
  }
  return { lines: [line("CCI", out)], guides: [{ value: -100, label: "-100" }, { value: 0, label: "0" }, { value: 100, label: "100" }] };
}

function roc(c, params = {}) {
  const p = sanitizeIndicatorParams("ROC", params);
  const cl = arrOf(c, "close"), out = nulls(c.length);
  for (let i = p.period; i < c.length; i++) out[i] = cl[i - p.period] ? (cl[i] / cl[i - p.period] - 1) * 100 : null;
  return { lines: [line("ROC", out), line("MAROC", sma(out, p.signal))], guides: [{ value: 0, label: "0" }] };
}

function mike(c, params = {}) {
  const p = sanitizeIndicatorParams("MIKE", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), cl = arrOf(c, "close"), hh = rmax(h, p.period), ll = rmin(l, p.period);
  const typ = h.map((v, i) => (v + l[i] + cl[i]) / 3);
  const mk = (fn) => typ.map((t, i) => nval(hh[i]) != null ? fn(t, hh[i], ll[i]) : null);
  return {
    lines: [
      line("WR", mk((t, H, L) => t + (t - L))),
      line("MR", mk((t, H, L) => t + (H - L))),
      line("SR", mk((_t, H, L) => 2 * H - L)),
      line("WS", mk((t, H) => t - (H - t))),
      line("MS", mk((t, H, L) => t - (H - L))),
      line("SS", mk((_t, H, L) => 2 * L - H)),
    ],
    note: "MIKE 为动态支撑/压力区间，适合与主图价格共同观察。",
  };
}

function boll(c, params = {}) {
  const p = sanitizeIndicatorParams("BOLL", params);
  const cl = arrOf(c, "close"), mid = sma(cl, p.period), sd = rstd(cl, p.period);
  const up = mid.map((v, i) => nval(v) != null && nval(sd[i]) != null ? v + p.mult * sd[i] : null);
  const dn = mid.map((v, i) => nval(v) != null && nval(sd[i]) != null ? v - p.mult * sd[i] : null);
  return { lines: [line("UPPER", up), line("MID", mid), line("LOWER", dn)] };
}

function psy(c, params = {}) {
  const p = sanitizeIndicatorParams("PSY", params);
  const cl = arrOf(c, "close"), up = nulls(c.length);
  for (let i = 1; i < c.length; i++) up[i] = cl[i] > cl[i - 1] ? 1 : 0;
  const su = rsum(up, p.period), psyV = su.map((v) => nval(v) != null ? v / p.period * 100 : null);
  return { lines: [line("PSY", psyV), line("PSYMA", sma(psyV, p.maPeriod))], guides: [{ value: 25, label: "25" }, { value: 50, label: "50" }, { value: 75, label: "75" }] };
}

function mcst(c, context = {}, params = {}) {
  const p = sanitizeIndicatorParams("MCST", params);
  const h = arrOf(c, "high"), l = arrOf(c, "low"), cl = arrOf(c, "close"), vol = arrOf(c, "volume"), typ = h.map((v, i) => (v + l[i] + cl[i]) / 3);
  const out = nulls(c.length), fs = nval(context.floatShares, 0);
  if (fs > 0) {
    let prev = typ[0];
    for (let i = 0; i < c.length; i++) {
      // 腾讯/东财日K成交量通常以“手”计；100股/手。
      const turnover = Math.max(0.0005, Math.min(1, vol[i] * 100 / fs));
      prev = turnover * typ[i] + (1 - turnover) * prev;
      out[i] = prev;
    }
    return { lines: [line("MCST", out)], note: "MCST 使用流通股本估算日换手率并作动态成本线。" };
  }
  // 无流通股本时退化为 20 日成交量加权成本。
  for (let i = p.fallbackPeriod - 1; i < c.length; i++) {
    let pv = 0, vv = 0;
    for (let j = i - p.fallbackPeriod + 1; j <= i; j++) { pv += typ[j] * vol[j]; vv += vol[j]; }
    out[i] = vv ? pv / vv : null;
  }
  return { lines: [line("MCST", out)], note: `未取得流通股本，本次以${p.fallbackPeriod}日成交量加权平均成本近似 MCST。` };
}

const COMPUTERS = { MACD: macd, DMI: dmi, DMA: dma, FSL: fsl, TRIX: trix, BRAR: brar, CR: cr, VR: vr, OBV: obv, ASI: asi, EMV: emv, VOL: volTdx, RSI: rsi, WR: wr, SAR: sar, KDJ: kdj, CCI: cci, ROC: roc, MIKE: mike, BOLL: boll, PSY: psy, MCST: mcst };

function lineSeries(ind, nameOrPrefix) {
  return (ind?.lines || []).find((x) => x.name === nameOrPrefix || x.name.startsWith(nameOrPrefix))?.values || [];
}
function analysisResult(score, state, summary, risk = 20, evidence = []) {
  return { score: Math.round(clamp(score, -100, 100)), state, summary, risk: Math.round(clamp(risk, 0, 100)), evidence };
}

/**
 * 将“画图指标”转为可进入综合分析的状态。分数表示方向性，不表示未来概率；risk 表示过热/波动/信号不稳程度。
 */
export function assessTechnicalIndicator(ind, candles = []) {
  if (!ind) return null;
  const id = ind.id, close = arrOf(candles, "close"), price = latest(close), prevPrice = prevFinite(close, 1);
  const L = (n) => latest(lineSeries(ind, n)), P = (n) => prevFinite(lineSeries(ind, n), 1);
  const cmp = (a, b, rel = 1e-9) => {
    if (!finite(a) || !finite(b)) return null;
    const aa = Number(a), bb = Number(b), eps = Math.max(1e-10, Math.max(Math.abs(aa), Math.abs(bb), 1) * rel);
    return aa > bb + eps ? 1 : aa < bb - eps ? -1 : 0;
  };
  const need = (...xs) => xs.every(finite);
  const signScore = (x, pos, neg = -pos) => x == null ? 0 : x > 0 ? pos : x < 0 ? neg : 0;
  const insuff = (names = []) => analysisResult(0, "数据不足", "当前样本不足以形成可靠判定", 0, names);
  let r;
  if (id === "MACD") {
    const dif=L("DIF"), dea=L("DEA"), hist=L("MACD"), ph=P("MACD"); if(!need(dif,dea)) r=insuff(["DIF","DEA","MACD"]); else {
      const c1=cmp(dif,dea), c2=cmp(dif,0), c3=need(hist,ph)?cmp(hist,ph):null;
      const sc=signScore(c1,35)+signScore(c2,20)+signScore(c3,15);
      r=analysisResult(sc, sc>=25?"多头":sc<=-25?"偏空":"中性", `DIF ${c1>0?"高于":c1<0?"低于":"接近"} DEA，柱体${c3==null?"变化不足":c3>0?"增强":c3<0?"减弱":"基本持平"}`, need(hist,dif)&&Math.abs(hist)>Math.abs(dif)*2?45:20,["DIF","DEA","MACD"]);
    }
  } else if (id === "DMI") {
    const pd=L("+DI"), md=L("-DI"), adx=L("ADX"); if(!need(pd,md,adx)) r=insuff(["+DI","-DI","ADX"]); else { const dir=pd-md, sc=clamp(dir*2 + (adx>20?Math.sign(dir)*(adx-20):0),-90,90); r=analysisResult(sc, adx>=25?(dir>0?"上升趋势":dir<0?"下降趋势":"方向中性"):"趋势不强", `+DI ${fmt(pd)} / -DI ${fmt(md)}，ADX ${fmt(adx)}`, adx>55?45:20,["+DI","-DI","ADX"]); }
  } else if (id === "DMA") {
    const d=L("DMA"), a=L("AMA"); if(!need(d,a)) r=insuff(["DMA","AMA"]); else { const c1=cmp(d,a),c2=cmp(d,0),sc=signScore(c1,35)+signScore(c2,25); r=analysisResult(sc,sc>10?"偏多":sc<-10?"偏空":"中性",`DMA ${c1>0?"高于":c1<0?"低于":"接近"} AMA，且${c2>0?"在零轴上方":c2<0?"在零轴下方":"接近零轴"}`,20,["DMA","AMA"]); }
  } else if (id === "FSL") {
    const swl=L("SWL"), sws=L("SWS"); if(!need(swl,sws,price)) r=insuff(["SWL","SWS"]); else { const c1=cmp(swl,sws),c2=cmp(price,swl),sc=signScore(c1,35)+signScore(c2,25); r=analysisResult(sc,sc>10?"趋势线上方":sc<-10?"趋势线下方":"趋势中性",`价格${c2>0?"高于":c2<0?"低于":"接近"} SWL，SWL ${c1>0?"高于":c1<0?"低于":"接近"} SWS`,20,["SWL","SWS"]); }
  } else if (id === "TRIX") {
    const t=L("TRIX"), m=L("MATRIX"); if(!need(t,m)) r=insuff(["TRIX","MATRIX"]); else { const c1=cmp(t,m),c2=cmp(t,0),sc=signScore(c1,35)+signScore(c2,25); r=analysisResult(sc,sc>10?"偏多":sc<-10?"偏空":"中性",`TRIX ${c1>0?"高于":c1<0?"低于":"接近"} MATRIX，${c2>0?"位于零轴上方":c2<0?"位于零轴下方":"接近零轴"}`,20,["TRIX","MATRIX"]); }
  } else if (id === "BRAR") {
    const ar=L("AR"), br=L("BR"); if(!need(ar,br)) r=insuff(["AR","BR"]); else { const sc=clamp((ar-100)*0.25+(br-100)*0.18,-65,65), risk=Math.max(ar,br)>300?80:Math.max(ar,br)>200?50:25; r=analysisResult(sc,sc>20?"情绪偏强":sc<-20?"情绪偏弱":"情绪中性",`AR ${fmt(ar)} / BR ${fmt(br)}`,risk,["AR","BR"]); }
  } else if (id === "CR") {
    const v=L("CR"); if(!finite(v)) r=insuff(["CR"]); else { const sc=clamp((v-100)*0.35,-70,70),risk=v>300?80:v>220?55:25; r=analysisResult(sc,sc>20?"能量偏强":sc<-20?"能量偏弱":"中性",`CR ${fmt(v)}`,risk,["CR"]); }
  } else if (id === "VR") {
    const v=L("VR"); if(!finite(v)) r=insuff(["VR"]); else { let sc=0,risk=20,state="量能中性"; if(v<70){sc=-25;state="量能偏弱";} else if(v<=160){sc=5;} else if(v<=350){sc=30;state="量能活跃";} else {sc=10;risk=80;state="量能过热";} r=analysisResult(sc,state,`VR ${fmt(v)}`,risk,["VR"]); }
  } else if (id === "OBV") {
    const v=L("OBV"), ma=(ind.lines||[]).find(x=>x.name.startsWith("MA"))?.values||[], m=latest(ma), pv=P("OBV"); if(!need(v,m)) r=insuff(["OBV"]); else { const c1=cmp(v,m),c2=need(v,pv)?cmp(v,pv):null,sc=signScore(c1,40)+signScore(c2,25); r=analysisResult(sc,sc>10?"量价累积偏多":sc<-10?"量价累积偏空":"量价中性",`OBV ${c1>0?"高于":c1<0?"低于":"接近"} 均线，近期${c2==null?"变化不足":c2>0?"上行":c2<0?"回落":"持平"}`,20,["OBV",(ind.lines||[]).find(x=>x.name.startsWith("MA"))?.name||"MA"]); }
  } else if (id === "ASI") {
    const v=L("ASI"),m=L("ASIT"),pv=P("ASI"); if(!need(v,m)) r=insuff(["ASI","ASIT"]); else { const c1=cmp(v,m),c2=need(v,pv)?cmp(v,pv):null,sc=signScore(c1,35)+signScore(c2,20); r=analysisResult(sc,sc>10?"摆动偏强":sc<-10?"摆动偏弱":"摆动中性",`ASI ${c1>0?"高于":c1<0?"低于":"接近"} ASIT，近期${c2==null?"变化不足":c2>0?"上行":c2<0?"回落":"持平"}`,20,["ASI","ASIT"]); }
  } else if (id === "EMV") {
    const v=L("EMV"),m=L("MAEMV"); if(!need(v,m)) r=insuff(["EMV","MAEMV"]); else { const c1=cmp(v,m),c2=cmp(v,0),sc=signScore(c1,30)+signScore(c2,25); r=analysisResult(sc,sc>10?"价量推动偏多":sc<-10?"价量推动偏空":"价量中性",`EMV ${c1>0?"高于":c1<0?"低于":"接近"} 信号线，${c2>0?"在零轴上":c2<0?"在零轴下":"接近零轴"}`,25,["EMV","MAEMV"]); }
  } else if (id === "VOL") {
    const v=L("VOL"),mas=(ind.lines||[]).filter(x=>x.name.startsWith("MA")),ms=latest(mas[0]?.values||[]),ml=latest(mas[1]?.values||[]); if(!need(v,ms,price,prevPrice)) r=insuff(["VOL"]); else { const ratio=ms? v/ms:null,dir=cmp(price,prevPrice), maCmp=finite(ml)?cmp(ms,ml):null,sc=ratio!=null&&ratio>1.4?signScore(dir,35):ratio!=null&&ratio<0.7?0:signScore(dir,12); r=analysisResult(sc,ratio>1.8?"显著放量":ratio<0.7?"缩量":"量能正常",`当前量/短均量 ${fmt(ratio,2)}，短均量${maCmp==null?"与长均量关系未知":maCmp>0?"高于长均量":maCmp<0?"低于长均量":"接近长均量"}`,ratio>2.5?65:25,["VOL",mas[0]?.name||"MA"]); }
  } else if (id === "RSI") {
    const short=latest(ind.lines?.[0]?.values||[]); if(!finite(short)) r=insuff([ind.lines?.[0]?.name||"RSI"]); else { let sc=clamp((short-50)*1.6,-70,70),risk=20,state=short>52?"动量偏强":short<48?"动量偏弱":"动量中性"; if(short>=80){risk=80;sc=Math.min(sc,25);state="过热";} if(short<=20){risk=65;state="超卖/弱势";} r=analysisResult(sc,state,`${ind.lines?.[0]?.name||"RSI"} ${fmt(short)}`,risk,[ind.lines?.[0]?.name||"RSI"]); }
  } else if (id === "WR") {
    const v=latest(ind.lines?.[0]?.values||[]); if(!finite(v)) r=insuff([ind.lines?.[0]?.name||"WR"]); else { let sc=clamp((50-v)*1.1,-55,55),risk=20,state="中性"; if(v<20){risk=70;state="超买区";sc=Math.min(sc,25);} else if(v>80){risk=55;state="超卖区";} else state=sc>5?"偏强":sc<-5?"偏弱":"中性"; r=analysisResult(sc,state,`${ind.lines?.[0]?.name||"WR"} ${fmt(v)}`,risk,[ind.lines?.[0]?.name||"WR"]); }
  } else if (id === "SAR") {
    const v=L("SAR"); if(!need(price,v)) r=insuff(["SAR"]); else { const c=cmp(price,v),sc=signScore(c,55); r=analysisResult(sc,c>0?"价格在SAR上方":c<0?"价格在SAR下方":"价格接近SAR",`现价 ${fmt(price)} / SAR ${fmt(v)}`,25,["SAR"]); }
  } else if (id === "KDJ") {
    const k=L("K"),d=L("D"),j=L("J"); if(!need(k,d,j)) r=insuff(["K","D","J"]); else { const c=cmp(k,d),sc=signScore(c,30)+clamp((j-50)*0.45,-25,25),risk=j>100||j<0?75:(j>85||j<15?55:20); r=analysisResult(sc,c>0?"K线高于D":c<0?"K线低于D":"K/D接近",`K ${fmt(k)} / D ${fmt(d)} / J ${fmt(j)}`,risk,["K","D","J"]); }
  } else if (id === "CCI") {
    const v=L("CCI"); if(!finite(v)) r=insuff(["CCI"]); else { const sc=clamp(v*0.45,-70,70),risk=Math.abs(v)>200?70:25; r=analysisResult(sc,v>100?"强势区":v<-100?"弱势区":"中性区",`CCI ${fmt(v)}`,risk,["CCI"]); }
  } else if (id === "ROC") {
    const v=L("ROC"),m=L("MAROC"); if(!need(v,m)) r=insuff(["ROC","MAROC"]); else { const c=cmp(v,m),sc=signScore(c,30)+clamp(v*3,-35,35); r=analysisResult(sc,sc>10?"变动率偏强":sc<-10?"变动率偏弱":"变动率中性",`ROC ${fmt(v)}，${c>0?"高于":c<0?"低于":"接近"} MAROC`,25,["ROC","MAROC"]); }
  } else if (id === "MIKE") {
    const mr=L("MR"),ms=L("MS"),wr=L("WR"),ws=L("WS"); if(!need(price,mr,ms,wr,ws)) r=insuff(["MR","MS","WR","WS"]); else { let sc=0,state="区间内"; if(price>mr){sc=35;state="位于中级压力上方";} else if(price<ms){sc=-35;state="位于中级支撑下方";} else { const c=cmp(price,(wr+ws)/2); sc=signScore(c,12); state=c===0?"区间中部":"区间内"; } r=analysisResult(sc,state,`现价 ${fmt(price)}，MR ${fmt(mr)} / MS ${fmt(ms)}`,price>wr||price<ws?50:20,["MR","MS","WR","WS"]); }
  } else if (id === "BOLL") {
    const up=L("UPPER"),mid=L("MID"),lo=L("LOWER"); if(!need(price,up,mid,lo)) r=insuff(["UPPER","MID","LOWER"]); else { const bw=mid?((up-lo)/mid*100):null,c=cmp(price,mid); let sc=signScore(c,28),risk=20,state=c>0?"中轨上方":c<0?"中轨下方":"接近中轨"; if(price>up){risk=75;sc=20;state="突破上轨/过热";} else if(price<lo){risk=65;sc=-20;state="跌破下轨/弱势";} r=analysisResult(sc,state,`现价 ${fmt(price)}，中轨 ${fmt(mid)}，带宽 ${fmt(bw)}%`,risk,["UPPER","MID","LOWER"]); }
  } else if (id === "PSY") {
    const v=L("PSY"),m=L("PSYMA"); if(!need(v,m)) r=insuff(["PSY","PSYMA"]); else { const rc=close.slice(-20).filter(finite).map(Number), flat=rc.length>=5 && Math.max(...rc)-Math.min(...rc) <= Math.max(1e-10, Math.abs(rc.at(-1))*1e-8); if(flat) r=analysisResult(0,"情绪中性",`价格近期基本无变化，PSY ${fmt(v)} 不作为偏空证据`,10,["PSY","PSYMA"]); else { const c=cmp(v,m),sc=clamp((v-50)*1.2+signScore(c,10),-60,60),risk=v>75||v<25?65:20; r=analysisResult(sc,v>75?"情绪过热":v<25?"情绪低迷":sc>5?"情绪偏强":sc<-5?"情绪偏弱":"情绪中性",`PSY ${fmt(v)} / PSYMA ${fmt(m)}`,risk,["PSY","PSYMA"]); } }
  } else if (id === "MCST") {
    const v=L("MCST"); if(!need(v,price) || v===0) r=insuff(["MCST"]); else { const dist=((price/v)-1)*100,sc=clamp(dist*8,-60,60); r=analysisResult(sc,sc>10?"价格高于市场成本":sc<-10?"价格低于市场成本":"接近市场成本",`现价相对 MCST ${fmt(dist)}%`,Math.abs(dist)>20?50:20,["MCST"]); }
  }
  return { ...(r || analysisResult(0,"未判定","暂无足够数据",0,[])), id, family: ind.family, group: ind.group };
}

function fmt(v, d = 1) { return Number.isFinite(Number(v)) ? Number(v).toFixed(d) : "—"; }
function aggregateScores(rows) {
  if (!rows.length) return { score: 0, risk: 0, count: 0 };
  const vals=rows.map(x=>x.score).sort((a,b)=>a-b), mean=vals.reduce((a,b)=>a+b,0)/vals.length, med=vals[Math.floor(vals.length/2)];
  const riskVals=rows.map(x=>x.risk).sort((a,b)=>b-a), risk=(riskVals[0]||0)*0.55+(riskVals.slice(1).reduce((a,b)=>a+b,0)/Math.max(1,riskVals.length-1))*0.45;
  return { score: Math.round(clamp(med*0.6+mean*0.4,-100,100)), risk: Math.round(clamp(risk,0,100)), count: rows.length };
}

/** 按因子族先聚合，再形成高级技术综合，避免 22 个高度相关指标重复计票。 */
export function analyzeTechnicalIndicatorSet(indicators, candles = []) {
  const assessments=(indicators||[]).map((x)=>({ ...assessTechnicalIndicator(x,candles), params:x.params, latest:Object.fromEntries((x.lines||[]).map(s=>[s.name,latest(s.values)])) })).filter(Boolean);
  const familyNames={trend:"趋势",momentum:"动量",volume:"量价",sentiment:"情绪",volatility:"波动",support:"支撑压力",cost:"成本"};
  const families={};
  for(const [key,label] of Object.entries(familyNames)){
    const rows=assessments.filter(x=>x.family===key), a=aggregateScores(rows);
    families[key]={key,label,...a, members:rows.map(x=>({id:x.id,score:x.score,risk:x.risk,state:x.state,summary:x.summary}))};
  }
  const weights={trend:.32,momentum:.25,volume:.20,sentiment:.08,volatility:.04,support:.06,cost:.05};
  let raw=0, ws=0;
  for(const [k,w] of Object.entries(weights)) if(families[k]?.count){raw+=families[k].score*w;ws+=w;}
  raw=ws?raw/ws:0;
  const risk=Math.round(Math.max(...assessments.map(x=>x.risk),0)*0.55 + (assessments.reduce((a,x)=>a+x.risk,0)/Math.max(1,assessments.length))*0.45);
  const compositeScore=Math.round(clamp(raw*(1-Math.min(75,risk)*0.002),-100,100));
  const strongest=[...assessments].sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)).slice(0,6).map(x=>({id:x.id,score:x.score,state:x.state,summary:x.summary,family:x.family}));
  return { methodology:"先在指标族内以中位数+均值聚合，再按趋势/动量/量价等族加权；同源指标不独立计票。", compositeScore, rawDirectionalScore:Math.round(raw), risk, families, indicators:assessments, strongest };
}

export function computeTechnicalIndicator(id, candles, context = {}, params = {}) {
  const key = String(id || "").toUpperCase();
  const meta = INDICATOR_CATALOG.find((x) => x.id === key);
  if (!meta || !Array.isArray(candles) || !candles.length) return null;
  const cleanParams = sanitizeIndicatorParams(key, params);
  const base = key === "MCST" ? COMPUTERS[key](candles, context, cleanParams) : COMPUTERS[key](candles, cleanParams);
  const ind = { ...meta, ...base, id: key, bars: candles.length, params: cleanParams };
  ind.analysis = assessTechnicalIndicator(ind, candles);
  return ind;
}

export function computeTechnicalIndicators(ids, candles, context = {}, paramMap = {}) {
  const uniq = [...new Set((ids || []).map((x) => String(x).toUpperCase()))].slice(0, 24);
  return uniq.map((id) => computeTechnicalIndicator(id, candles, context, paramMap?.[id] || {})).filter(Boolean);
}

function finiteTail(values, n = 60) {
  return (values || []).filter(finite).map(Number).slice(-n);
}
function slopeOf(values, n) {
  const xs=finiteTail(values,n); if(xs.length<Math.min(3,n)) return null;
  const mx=(xs.length-1)/2, my=xs.reduce((a,b)=>a+b,0)/xs.length;
  let num=0,den=0; for(let i=0;i<xs.length;i++){num+=(i-mx)*(xs[i]-my);den+=(i-mx)**2;}
  return den?num/den:null;
}
function trajectoryOf(values) {
  const xs=finiteTail(values,60), cur=xs.at(-1); if(cur==null) return {latest:null,recent12:[],delta5:null,delta20:null,slope5:null,slope20:null,percentile60:null};
  const back=(n)=>xs.length>n?xs.at(-1-n):null;
  const pct=xs.length>=5?Math.round(xs.filter(v=>v<=cur).length/xs.length*100):null;
  return { latest:cur, recent12:xs.slice(-12), delta5:back(5)==null?null:cur-back(5), delta20:back(20)==null?null:cur-back(20), slope5:slopeOf(xs,5), slope20:slopeOf(xs,20), percentile60:pct };
}
function recentCrossForIndicator(ind) {
  const lines=(ind?.lines||[]).filter(x=>x.type==="line"); if(lines.length<2) return null;
  const a=lines[0], b=lines[1];
  const n=Math.min(a.values?.length||0,b.values?.length||0); let last=null;
  for(let i=Math.max(1,n-60);i<n;i++){
    const a0=nval(a.values[i-1]),b0=nval(b.values[i-1]),a1=nval(a.values[i]),b1=nval(b.values[i]);
    if(!finite(a0)||!finite(b0)||!finite(a1)||!finite(b1)) continue;
    const p=a0-b0,c=a1-b1; if((p<=0&&c>0)||(p>=0&&c<0)) last={lineA:a.name,lineB:b.name,direction:c>0?"上穿":"下穿",barsAgo:n-1-i};
  }
  return last;
}

export function indicatorSnapshot(ids, candles, context = {}, paramMap = {}) {
  const rows=computeTechnicalIndicators(ids, candles, context, paramMap);
  const setAnalysis=analyzeTechnicalIndicatorSet(rows,candles);
  return rows.map((ind) => ({
    id: ind.id,
    name: ind.name,
    group: ind.group,
    family: ind.family,
    params: ind.params,
    note: ind.note || null,
    latest: Object.fromEntries((ind.lines || []).map((s) => [s.name, latest(s.values)])),
    trajectory: {
      lines: Object.fromEntries((ind.lines || []).map((s) => [s.name, trajectoryOf(s.values)])),
      recentCross: recentCrossForIndicator(ind),
    },
    guides: ind.guides || [],
    analysis: ind.analysis,
    familySummary: setAnalysis.families?.[ind.family] || null,
  }));
}

