/**
 * StockDesk Data Provider Hub v1.9.3
 *
 * Unified market-data routing layer.
 * Goals:
 * - Do not couple business logic to one public endpoint.
 * - Batch where possible, rate-limit per source/capability, coalesce duplicate requests.
 * - Rotate/adapt among healthy providers; circuit-break on 403/429/WAF-like responses.
 * - Keep deterministic parsers and expose health/status for UI.
 * - Allow user-defined REST providers without arbitrary JavaScript execution.
 *
 * This layer is for respectful load distribution/failover, not bypassing access controls.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 StockDesk/1.9.3";
const SINA_REFERER = "https://finance.sina.com.cn/";
const EM_REFERER = "https://quote.eastmoney.com/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function inferMarket(code, eastmoneyMarket = null) {
  const value = String(code || "");
  if (Number(eastmoneyMarket) === 1) return "sh";
  if (/^(92|8|4)/.test(value)) return "bj";
  if (/^(60|68|51|50|90)/.test(value)) return "sh";
  return "sz";
}

export function normalizeStockCode(input) {
  const raw = String(input || "").trim().toLowerCase();
  let market, code;
  if (raw.startsWith("sh") || raw.startsWith("sz") || raw.startsWith("bj")) {
    market = raw.slice(0, 2); code = raw.slice(2);
  } else {
    code = raw;
    market = inferMarket(code);
  }
  if (!/^\d{6}$/.test(code)) return null;
  if (/^92/.test(code)) market = "bj"; // 兼容旧版本可能持久化的错误 sh920xxx 前缀。
  const emMarket = market === "sh" ? 1 : market === "bj" ? 0 : 0;
  return { raw, market, code, symbol: `${market}${code}`, secid: `${emMarket}.${code}` };
}

export class ProviderError extends Error {
  constructor(message, meta = {}) {
    super(message); this.name = "ProviderError"; Object.assign(this, meta);
  }
}

export const DEFAULT_DATA_SOURCE_CONFIG = Object.freeze({
  configVersion: 3,
  enabled: true,
  routingMode: "adaptive", // adaptive | rotate | priority
  staleFallback: true,
  cacheProfile: "balanced", // conservative | balanced | aggressive
  providers: {
    tencent: { enabled: true, priority: 40, globalMinIntervalMs: 900, minIntervals: { quote: 8000, minute: 1200, kline: 2500, aux: 1200 }, cooldownMinutes: 30 },
    eastmoney: { enabled: true, priority: 40, globalMinIntervalMs: 900, minIntervals: { quote: 8000, minute: 1200, kline: 2500, aux: 900 }, cooldownMinutes: 30 },
    sina: { enabled: true, priority: 50, globalMinIntervalMs: 900, minIntervals: { quote: 8000, kline: 2500, aux: 1500 }, cooldownMinutes: 30 },
    tdx: { enabled: false, priority: 30, globalMinIntervalMs: 1000, minIntervals: { quote: 5000, minute: 8000, kline: 15000 }, cooldownMinutes: 30 },
    tushare: { enabled: false, priority: 25, globalMinIntervalMs: 1200, minIntervals: { kline: 10000, aux: 3000 }, cooldownMinutes: 30 },
    baostock: { enabled: false, priority: 35, globalMinIntervalMs: 1500, minIntervals: { kline: 12000, aux: 5000 }, cooldownMinutes: 30 },
    akshare: { enabled: false, priority: 60, globalMinIntervalMs: 2000, minIntervals: { quote: 15000, minute: 20000, kline: 30000, aux: 5000 }, cooldownMinutes: 30 },
    exchange: { enabled: false, priority: 10, globalMinIntervalMs: 3000, minIntervals: { aux: 10000 }, cooldownMinutes: 30 },
  },
  customProviders: [],
});

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }
function mergeConfig(base, patch) {
  const out = deepClone(base);
  out.configVersion = Number(patch?.configVersion) || 1;
  if (!patch || typeof patch !== "object") return out;
  for (const k of ["enabled", "routingMode", "staleFallback", "cacheProfile"]) if (patch[k] !== undefined) out[k] = patch[k];
  if (patch.providers && typeof patch.providers === "object") {
    for (const [id, p] of Object.entries(patch.providers)) out.providers[id] = { ...(out.providers[id] || {}), ...(p || {}), minIntervals: { ...((out.providers[id] || {}).minIntervals || {}), ...((p || {}).minIntervals || {}) } };
  }
  if (Array.isArray(patch.customProviders)) out.customProviders = patch.customProviders;
  return sanitizeConfig(out);
}

export function sanitizeConfig(input) {
  const c = deepClone(input || DEFAULT_DATA_SOURCE_CONFIG);
  const inputVersion = Number(c.configVersion) || 1;
  // 早期多源配置使用 18s/45s 的分钟线/K线间隔，会让正常分析排队数分钟。
  // 只迁移未被用户修改的旧默认值，保留显式调优。
  if (inputVersion < 2) {
    const legacy = {
      tencent: { globalMinIntervalMs: 1800, minIntervals: { quote: 15000, minute: 18000, kline: 45000, aux: 3000 } },
      eastmoney: { globalMinIntervalMs: 1800, minIntervals: { quote: 15000, minute: 18000, kline: 45000, aux: 3000 } },
      sina: { globalMinIntervalMs: 1800, minIntervals: { quote: 15000, aux: 4000 } },
    };
    for (const [id, old] of Object.entries(legacy)) {
      const p = c.providers?.[id]; const next = DEFAULT_DATA_SOURCE_CONFIG.providers[id];
      if (!p) continue;
      if (Number(p.globalMinIntervalMs) === old.globalMinIntervalMs) p.globalMinIntervalMs = next.globalMinIntervalMs;
      for (const [cap, value] of Object.entries(old.minIntervals)) {
        if (Number(p.minIntervals?.[cap]) === value) p.minIntervals[cap] = next.minIntervals[cap];
      }
    }
  }
  // v1.9.3：旧默认 5 秒分时限速会让用户快速切股时产生明显排队。
  // 仅迁移仍等于旧默认值的配置，保留用户手动设置的更保守间隔。
  if (inputVersion < 3) {
    for (const id of ["tencent", "eastmoney"]) {
      const p = c.providers?.[id];
      if (Number(p?.minIntervals?.minute) === 5000) p.minIntervals.minute = DEFAULT_DATA_SOURCE_CONFIG.providers[id].minIntervals.minute;
    }
  }
  c.configVersion = 3;
  c.enabled = c.enabled !== false;
  c.routingMode = ["adaptive", "rotate", "priority"].includes(c.routingMode) ? c.routingMode : "adaptive";
  c.cacheProfile = ["conservative", "balanced", "aggressive"].includes(c.cacheProfile) ? c.cacheProfile : "balanced";
  c.staleFallback = c.staleFallback !== false;
  c.providers ||= {};
  for (const id of ["tencent", "eastmoney", "sina", "tdx", "tushare", "baostock", "akshare", "exchange"]) {
    const d = DEFAULT_DATA_SOURCE_CONFIG.providers[id], p = c.providers[id] || {};
    p.enabled = p.enabled !== false;
    p.priority = clamp(Number(p.priority) || d.priority, 1, 100);
    p.cooldownMinutes = clamp(Number(p.cooldownMinutes) || d.cooldownMinutes, 1, 360);
    p.globalMinIntervalMs = clamp(Number(p.globalMinIntervalMs) || d.globalMinIntervalMs || 1500, 250, 3600000);
    p.minIntervals = { ...d.minIntervals, ...(p.minIntervals || {}) };
    for (const [cap, val] of Object.entries(p.minIntervals)) p.minIntervals[cap] = clamp(Number(val) || d.minIntervals?.[cap] || 1000, 250, 3600000);
    c.providers[id] = p;
  }
  c.customProviders = Array.isArray(c.customProviders) ? c.customProviders.slice(0, 12).map(sanitizeCustomProvider).filter(Boolean) : [];
  return c;
}

function sanitizeCustomProvider(p) {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  if (!id || ["tencent", "eastmoney", "sina"].includes(id)) return null;
  const caps = Array.isArray(p.capabilities) ? p.capabilities.filter((x) => ["quote", "kline", "minute"].includes(x)) : [];
  if (!caps.length) return null;
  return {
    id, label: String(p.label || id).slice(0, 80), enabled: p.enabled !== false,
    priority: clamp(Number(p.priority) || 50, 1, 100),
    capabilities: [...new Set(caps)],
    minIntervalMs: clamp(Number(p.minIntervalMs) || 5000, 250, 3600000),
    globalMinIntervalMs: clamp(Number(p.globalMinIntervalMs ?? p.minIntervalMs) || 5000, 250, 3600000),
    cooldownMinutes: clamp(Number(p.cooldownMinutes) || 30, 1, 360),
    quote: sanitizeEndpoint(p.quote), kline: sanitizeEndpoint(p.kline), minute: sanitizeEndpoint(p.minute),
  };
}

function sanitizeEndpoint(ep) {
  if (!ep || typeof ep !== "object" || !ep.url) return null;
  const method = String(ep.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  return {
    method, url: String(ep.url).slice(0, 1600), headers: ep.headers && typeof ep.headers === "object" ? ep.headers : {},
    body: ep.body && typeof ep.body === "object" ? ep.body : null,
    root: String(ep.root || "").slice(0, 200), map: ep.map && typeof ep.map === "object" ? ep.map : {},
    responseType: ep.responseType === "text" ? "text" : "json", batch: ep.batch === true, allowPrivateHost: ep.allowPrivateHost === true,
  };
}

let config = sanitizeConfig(DEFAULT_DATA_SOURCE_CONFIG);
let secrets = {};
const health = new Map();
const lastRequestAt = new Map();
const inflight = new Map();
const cache = new Map();
const symbolSearchCache = new Map();
const marketDirectoryCache = new Map();
const marketDirectoryInflight = new Map();
const cursors = new Map();
const rateChains = new Map();
const HEALTH_DIR = process.env.STOCKDESK_DATA_DIR || join(homedir(), ".stockdesk");
const HEALTH_PATH = join(HEALTH_DIR, "provider-health.json");
let persistedHealth = {};
try { persistedHealth = JSON.parse(readFileSync(HEALTH_PATH, "utf8")) || {}; } catch { persistedHealth = {}; }
let persistTimer = null;
function persistHealthSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null; try {
      mkdirSync(HEALTH_DIR,{recursive:true});
      const out={}; for(const [id,h] of health.entries()) out[id]={blockedUntil:h.blockedUntil||0,wafBlocks:h.wafBlocks||0,lastFailureAt:h.lastFailureAt||0,lastError:h.lastError||""};
      writeFileSync(HEALTH_PATH,JSON.stringify({version:1,updatedAt:Date.now(),providers:out},null,2),"utf8");
    } catch {}
  },250);
}

export function configureDataSources(nextConfig = {}, nextSecrets = {}) {
  config = mergeConfig(DEFAULT_DATA_SOURCE_CONFIG, nextConfig);
  secrets = nextSecrets && typeof nextSecrets === "object" ? { ...nextSecrets } : {};
  return getDataSourceConfig();
}
export function getDataSourceConfig() { return deepClone(config); }
export function isProviderEnabled(id) { const p=providerCfg(String(id||"")); return config.enabled !== false && !!p && p.enabled !== false; }

function providerMeta(id) {
  if (id === "tencent") return { id, label: "腾讯行情", kind: "builtin", capabilities: ["quote", "minute", "kline"], batchQuote: true };
  if (id === "eastmoney") return { id, label: "东方财富", kind: "builtin", capabilities: ["quote", "minute", "kline"], batchQuote: true };
  if (id === "sina") return { id, label: "新浪行情", kind: "builtin", capabilities: ["quote", "kline"], batchQuote: true };
  if (id === "tdx") return { id, label: "通达信 / pytdx", kind: "builtin-bridge", capabilities: ["quote", "minute", "kline"], batchQuote: true };
  if (id === "tushare") return { id, label: "Tushare Pro", kind: "builtin-token", capabilities: ["kline", "aux"], batchQuote: false };
  if (id === "baostock") return { id, label: "Baostock", kind: "builtin-bridge", capabilities: ["kline", "aux"], batchQuote: false };
  if (id === "akshare") return { id, label: "AKShare 聚合适配", kind: "builtin-bridge", capabilities: ["quote", "minute", "kline", "aux"], batchQuote: false };
  if (id === "exchange") return { id, label: "交易所/巨潮（权威辅助）", kind: "official", capabilities: ["aux"], batchQuote: false };
  const p = config.customProviders.find((x) => x.id === id);
  return p ? { id, label: p.label, kind: "custom", capabilities: p.capabilities, batchQuote: false } : null;
}
function providerCfg(id) {
  if (config.providers[id]) return config.providers[id];
  return config.customProviders.find((x) => x.id === id) || null;
}
function providerHealth(id) {
  if (!health.has(id)) {
    const saved=(persistedHealth?.providers||persistedHealth||{})[id]||{};
    health.set(id, { requests: 0, successes: 0, failures: 0, consecutiveFailures: 0, blockedUntil: Number(saved.blockedUntil)||0, lastError: String(saved.lastError||""), lastStatus: null, latencyMs: null, lastSuccessAt: 0, lastFailureAt: Number(saved.lastFailureAt)||0, lastUsedAt: 0, wafBlocks: Number(saved.wafBlocks)||0 });
  }
  return health.get(id);
}
function enabledProviders(capability) {
  if (config.enabled === false) return [];
  const ids = ["tencent", "eastmoney", "sina", "tdx", "tushare", "baostock", "akshare", "exchange", ...config.customProviders.map((x) => x.id)];
  return ids.filter((id) => {
    const m = providerMeta(id), p = providerCfg(id);
    return m && p && p.enabled !== false && m.capabilities.includes(capability) && providerHealth(id).blockedUntil <= now();
  });
}

export function isWafLike(status, body = "") {
  const s = Number(status);
  if ([403, 412, 418, 429].includes(s)) return true;
  const t = String(body || "").toLowerCase();
  return /(?:waf|access\s*denied|too\s*many\s*requests|rate\s*limit|forbidden|访问(?:过于)?频繁|访问异常|安全验证|请求过于频繁)/i.test(t);
}

function noteSuccess(id, latency) {
  const h = providerHealth(id); h.requests++; h.successes++; h.consecutiveFailures = 0; h.lastError = ""; h.lastStatus = 200; h.latencyMs = Math.round(latency); h.lastSuccessAt = now(); h.lastUsedAt = now(); const hadWaf=(h.wafBlocks||0)>0; h.wafBlocks = Math.max(0, (h.wafBlocks||0) - 1); if(hadWaf) persistHealthSoon();
}
function noteFailure(id, err) {
  const h = providerHealth(id); h.requests++; h.failures++; h.consecutiveFailures++; h.lastError = String(err?.message || err || "unknown").slice(0, 240); h.lastStatus = err?.status ?? null; h.lastFailureAt = now(); h.lastUsedAt = now();
  const p = providerCfg(id) || {};
  const waf = !!err?.waf || isWafLike(err?.status, err?.body || err?.message);
  if (waf) {
    h.wafBlocks++;
    const base = (Number(p.cooldownMinutes) || 30) * 60000;
    h.blockedUntil = now() + Math.min(6 * 3600000, base * Math.max(1, Math.pow(2, Math.min(3, h.wafBlocks - 1))));
  } else if (h.consecutiveFailures >= 3) {
    h.blockedUntil = now() + Math.min(10 * 60000, 30000 * h.consecutiveFailures);
  }
  persistHealthSoon();
}

function cacheTtl(capability) {
  const profile = config.cacheProfile;
  const table = {
    conservative: { quote: 800, minute: 5000, kline: 120000 },
    balanced: { quote: 1500, minute: 10000, kline: 300000 },
    aggressive: { quote: 3000, minute: 20000, kline: 600000 },
  };
  return table[profile]?.[capability] || 1000;
}
function staleTtl(capability) { return capability === "quote" ? 10 * 60 * 1000 : capability === "minute" ? 30 * 60 * 1000 : 24 * 3600000; }
function ckey(cap, key) { return `${cap}:${key}`; }
function getCache(cap, key, allowStale = false) {
  const hit = cache.get(ckey(cap, key)); if (!hit) return null;
  const age = now() - hit.at;
  if (age <= cacheTtl(cap)) return { ...hit, stale: false };
  if (allowStale && age <= staleTtl(cap)) return { ...hit, stale: true };
  return null;
}
function setCache(cap, key, data, provider) { cache.set(ckey(cap, key), { at: now(), data, provider }); if (cache.size > 500) cache.delete(cache.keys().next().value); }

async function respectRate(id, capability) {
  const p = providerCfg(id) || {};
  const capMin = config.providers[id]?.minIntervals?.[capability] ?? p.minIntervalMs ?? 1000;
  const globalMin = config.providers[id]?.globalMinIntervalMs ?? p.globalMinIntervalMs ?? p.minIntervalMs ?? 1000;
  const capKey = `${id}:${capability}`, globalKey = capability === 'minute' ? `${id}:minute` : `${id}:*`;
  const queueKey = capability === 'minute' ? `${id}:minute` : id;
  // Serialize request starts per provider so quote/minute/kline/F10 cannot burst simultaneously.
  const prev = rateChains.get(queueKey) || Promise.resolve();
  const scheduled = prev.catch(() => {}).then(async () => {
    const capDelta = now() - (lastRequestAt.get(capKey) || 0);
    const globalDelta = now() - (lastRequestAt.get(globalKey) || 0);
    const wait = Math.max(0, capMin - capDelta, globalMin - globalDelta);
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 120));
    const ts = now(); lastRequestAt.set(capKey, ts); lastRequestAt.set(globalKey, ts);
  });
  rateChains.set(queueKey, scheduled);
  try { await scheduled; } finally { if (rateChains.get(queueKey) === scheduled) rateChains.delete(queueKey); }
}

function orderedCandidates(capability, preferredProviders = []) {
  const ids = enabledProviders(capability);
  if (!ids.length) return [];
  const preferred = new Map((Array.isArray(preferredProviders) ? preferredProviders : []).map((id, i) => [String(id), i]));
  const prefer = (a, b) => {
    const ai = preferred.has(a) ? preferred.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = preferred.has(b) ? preferred.get(b) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  };
  if (config.routingMode === "priority") return ids.sort((a, b) => prefer(a, b) || (providerCfg(a)?.priority || 50) - (providerCfg(b)?.priority || 50));
  const start = cursors.get(capability) || 0;
  const rotated = ids.map((_, i) => ids[(start + i) % ids.length]);
  cursors.set(capability, (start + 1) % ids.length);
  if (config.routingMode === "rotate") return rotated.sort((a, b) => prefer(a, b));
  // Adaptive keeps rotation as a fairness signal, but unhealthy/slow providers drift later.
  return rotated.sort((a, b) => {
    const preferredOrder = prefer(a, b);
    if (preferredOrder) return preferredOrder;
    const ha = providerHealth(a), hb = providerHealth(b), pa = providerCfg(a), pb = providerCfg(b);
    const failA = ha.requests ? ha.failures / ha.requests : 0, failB = hb.requests ? hb.failures / hb.requests : 0;
    const recencyA = ha.lastUsedAt ? Math.max(0, 30000 - (now()-ha.lastUsedAt)) / 1000 * 3 : 0;
    const recencyB = hb.lastUsedAt ? Math.max(0, 30000 - (now()-hb.lastUsedAt)) / 1000 * 3 : 0;
    const scoreA = (pa?.priority || 50) * .12 + failA * 100 + (ha.consecutiveFailures * 40) + ((ha.latencyMs || 0) / 500) + recencyA;
    const scoreB = (pb?.priority || 50) * .12 + failB * 100 + (hb.consecutiveFailures * 40) + ((hb.latencyMs || 0) / 500) + recencyB;
    return scoreA - scoreB;
  });
}

async function fetchChecked(url, init = {}, timeoutMs = 12000) {
  let res;
  const { responseType = "json", responseEncoding = "utf-8", ...fetchInit } = init;
  try { res = await fetch(url, { ...fetchInit, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new ProviderError(e?.message || "network error", { cause: e }); }
  if (responseType === "arrayBuffer") {
    const raw = await res.arrayBuffer();
    const probe = new TextDecoder(responseEncoding).decode(raw.slice(0, 2000));
    if (!res.ok || isWafLike(res.status, probe)) throw new ProviderError(`HTTP ${res.status}`, { status: res.status, body: probe, waf: isWafLike(res.status, probe) });
    return raw;
  }
  const raw = await res.text();
  if (!res.ok || isWafLike(res.status, raw.slice(0, 2000))) throw new ProviderError(`HTTP ${res.status}`, { status: res.status, body: raw.slice(0, 2000), waf: isWafLike(res.status, raw) });
  if (responseType === "text") return raw;
  try { return JSON.parse(raw); } catch { throw new ProviderError("响应不是有效 JSON", { status: res.status, body: raw.slice(0, 800) }); }
}

export function parseTencentQuoteText(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/gi)) {
    const symbol = m[1].toLowerCase(), q = m[2].split("~"); if (q.length < 35) continue;
    const price = Number(q[3]), prevClose = Number(q[4]); if (!(price > 0)) continue;
    out.push({ code: symbol.slice(2), symbol, name: String(q[1] || ""), price, prevClose, open: Number(q[5]) || null, high: Number(q[33]) || null, low: Number(q[34]) || null, volume: Number(q[6]) || 0, amount: (Number(q[37]) || 0) * 10000, changeAmount: Number(q[31]) || (price - prevClose), changePercent: Number(q[32]) || (prevClose > 0 ? (price / prevClose - 1) * 100 : 0) });
  }
  return out;
}

export function parseSinaQuoteText(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/var\s+hq_str_([a-z]{2}\d{6})="([^"]*)"/gi)) {
    const symbol = m[1].toLowerCase(), q = m[2].split(","); if (q.length < 10) continue;
    const price = Number(q[3]), prevClose = Number(q[2]); if (!(price > 0)) continue;
    out.push({ code: symbol.slice(2), symbol, name: String(q[0] || ""), price, prevClose, open: Number(q[1]) || null, high: Number(q[4]) || null, low: Number(q[5]) || null, volume: Number(q[8]) || 0, amount: Number(q[9]) || 0, changeAmount: price - prevClose, changePercent: prevClose > 0 ? (price / prevClose - 1) * 100 : 0 });
  }
  return out;
}

export function parseEastmoneyBatchQuote(json) {
  const rows = json?.data?.diff || []; if (!Array.isArray(rows)) return [];
  return rows.map((d) => {
    const price = Number(d.f2), prevClose = Number(d.f18); if (!(price > 0)) return null;
    const code = String(d.f12 || "");
    const market = inferMarket(code, d.f13);
    return { code, symbol: `${market}${code}`, name: String(d.f14 || ""), price, changePercent: Number(d.f3) || 0, changeAmount: Number(d.f4) || (price - prevClose), volume: Number(d.f5) || 0, amount: Number(d.f6) || 0, high: Number(d.f15) || null, low: Number(d.f16) || null, open: Number(d.f17) || null, prevClose };
  }).filter(Boolean);
}

export function parseEastmoneySuggestions(json) {
  const rows = json?.QuotationCodeTable?.Data;
  if (!Array.isArray(rows)) return [];
  const seen = new Set(), out = [];
  for (const item of rows) {
    let code = String(item?.Code || "").trim();
    const quoteId = String(item?.QuoteID || "").trim();
    const match = quoteId.match(/^([01])\.(\d{6})$/);
    if (match) code = match[2];
    if (!/^\d{6}$/.test(code)) continue;
    const market = match ? inferMarket(code, Number(match[1])) : inferMarket(code, item?.MktNum);
    const symbol = `${market}${code}`;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      code,
      symbol,
      name: String(item?.Name || code).trim(),
      market,
      securityType: String(item?.SecurityTypeName || item?.SecurityType || "").trim(),
      source: "eastmoney",
    });
  }
  return out;
}

/** Parse one page of Eastmoney's security directory into StockDesk symbols. */
export function parseEastmoneySecurityDirectory(json, marketFilter = null) {
  const rows = json?.data?.diff;
  if (!Array.isArray(rows)) return [];
  const wanted = marketFilter ? String(marketFilter).toLowerCase() : null;
  const seen = new Set(), out = [];
  for (const item of rows) {
    const code = String(item?.f12 || "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    const market = inferMarket(code, item?.f13);
    if (wanted && market !== wanted) continue;
    const symbol = `${market}${code}`;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ code, symbol, market, name: String(item?.f14 || code).trim(), source: "eastmoney-directory" });
  }
  return out;
}

async function bridgeCall(id, capability, payload) {
  const { spawn } = await import("node:child_process");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bridge = join(moduleDir, "..", "python-ai", "data_provider_bridge.py")
    .replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  const body = JSON.stringify({ provider:id, capability, ...payload });
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python", [bridge], {
      stdio:["pipe","pipe","pipe"],
      windowsHide:true,
      env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"},
    });
    let out="", err=""; const timer=setTimeout(()=>{try{child.kill()}catch{};reject(new ProviderError(`${id}桥接超时`));}, 20000);
    child.stdout.on("data",d=>out+=d); child.stderr.on("data",d=>err+=d);
    child.on("error",e=>{clearTimeout(timer);reject(new ProviderError(`${id}桥接不可用：${e.message}`));});
    child.on("close",code=>{clearTimeout(timer); if(code!==0){reject(new ProviderError(`${id}桥接失败：${err.slice(0,240)}`));return;} try{const j=JSON.parse(out||"{}"); if(j.error) throw new ProviderError(j.error); resolve(j.data ?? j);}catch(e){reject(e instanceof ProviderError?e:new ProviderError(`${id}桥接返回无法解析`));}});
    child.stdin.end(body);
  });
}

async function tushareKline(code, period, count) {
  const token=String(secrets.tushare||"").trim(); if(!token) throw new ProviderError("Tushare 未配置 Token");
  const pc=normalizeStockCode(code); const tsCode=`${pc.code}.${pc.market.toUpperCase()}`;
  const start=new Date(Date.now()-Math.max(30,count*2)*86400000).toISOString().slice(0,10).replaceAll("-","");
  const apiName="daily"; const r=await fetchChecked("http://api.tushare.pro",{method:"POST",headers:{"Content-Type":"application/json","User-Agent":UA},body:JSON.stringify({api_name:apiName,token,params:{ts_code:tsCode,start_date:start},fields:"ts_code,trade_date,open,high,low,close,vol,amount"})},15000);
  const rows=Array.isArray(r?.data?.items)?r.data.items:[]; const fields=r?.data?.fields||[]; const ix=Object.fromEntries(fields.map((f,i)=>[f,i]));
  return rows.map(a=>({time:String(a[ix.trade_date]||""),open:Number(a[ix.open]),close:Number(a[ix.close]),high:Number(a[ix.high]),low:Number(a[ix.low]),volume:Number(a[ix.vol])||0,amount:Number(a[ix.amount])||0})).filter(x=>x.time&&x.close>0).reverse().slice(-Math.min(1000,Number(count)||160));
}

async function builtinQuotes(id, codes) {
  const norm = codes.map(normalizeStockCode).filter(Boolean); if (!norm.length) return [];
  if (id === "tencent") {
    const url = `https://qt.gtimg.cn/q=${norm.map((x) => x.symbol).join(",")}`;
    // qt.gtimg.cn 明确返回 GBK；Response.text() 会按 UTF-8 解码并把中文名变成 U+FFFD。
    const raw = await fetchChecked(url, { headers: { "User-Agent": UA, Referer: "https://stockapp.finance.qq.com/" }, responseType: "arrayBuffer", responseEncoding: "gbk" }, 10000);
    const text = new TextDecoder("gbk").decode(raw);
    return parseTencentQuoteText(text);
  }
  if (id === "sina") {
    const url = `https://hq.sinajs.cn/rn=${Date.now()}&list=${norm.map((x) => x.symbol).join(",")}`;
    const bytes = await fetchChecked(url, { headers: { "User-Agent": UA, Referer: SINA_REFERER }, responseType: "arrayBuffer", responseEncoding: "gbk" }, 10000);
    return parseSinaQuoteText(new TextDecoder("gbk").decode(bytes));
  }
  if (id === "eastmoney") {
    const secids = norm.map((x) => x.secid).join(",");
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${encodeURIComponent(secids)}&fields=f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18`;
    const json = await fetchChecked(url, { headers: { "User-Agent": UA, Referer: EM_REFERER } }, 12000);
    return parseEastmoneyBatchQuote(json);
  }
  if (["tdx", "baostock", "akshare"].includes(id)) return bridgeCall(id, "quote", { codes: norm.map(x=>x.symbol) });
  return customQuotes(id, norm);
}

export function parseEastmoneyKline(json) {
  const rows = json?.data?.klines || [];
  return Array.isArray(rows) ? rows.map((line) => { const p = String(line).split(","); return { time: String(p[0]), open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]) || 0 }; }).filter((x) => x.time && x.close > 0) : [];
}

export function parseSinaKline(json) {
  return (Array.isArray(json) ? json : []).map((r) => ({
    time: String(r?.day || r?.date || ""), open: Number(r?.open), close: Number(r?.close),
    high: Number(r?.high), low: Number(r?.low), volume: Number(r?.volume) || 0,
  })).filter((x) => x.time && x.close > 0);
}

async function builtinKline(id, code, period = "day", count = 160) {
  const pc = normalizeStockCode(code); if (!pc) return [];
  if (id === "tencent") {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${pc.symbol},${period},,,${Math.min(1000, Math.max(1, Number(count) || 160))},qfq`;
    const j = await fetchChecked(url, { headers: { "User-Agent": UA, Referer: "https://gu.qq.com/" } }, 15000);
    const sd = j?.data?.[pc.symbol]; const keys = period === "day" ? ["qfqday", "day", "hfqday"] : period === "week" ? ["qfqweek", "week", "hfqweek"] : ["qfqmonth", "month", "hfqmonth"];
    let rows = []; for (const k of keys) if (Array.isArray(sd?.[k])) { rows = sd[k]; break; }
    return rows.map((r) => ({ time: String(r[0]), open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]), volume: Number(r[5]) || 0 })).filter((x) => x.time && x.close > 0);
  }
  if (id === "eastmoney") {
    const klt = period === "week" ? 102 : period === "month" ? 103 : 101;
    const path = `/api/qt/stock/kline/get?secid=${pc.secid}&klt=${klt}&fqt=1&lmt=${Math.min(1000, Math.max(1, Number(count) || 160))}&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56`;
    let lastError;
    let best = [];
    // push2delay 对沪深较稳定，但会对部分新北交所代码返回 data:null；
    // 北交所必须优先历史主域名，并对瞬时 socket reset 做短退避重试。
    const hosts = pc.market === "bj"
      ? ["push2his.eastmoney.com", "push2delay.eastmoney.com"]
      : ["push2delay.eastmoney.com", "push2his.eastmoney.com"];
    for (let attempt = 0; attempt < (pc.market === "bj" ? 3 : 1); attempt++) {
      for (const host of hosts) {
        try {
          const rows = parseEastmoneyKline(await fetchChecked(`https://${host}${path}`, { headers: { "User-Agent": UA, Referer: EM_REFERER } }, 15000));
          if (rows.length > best.length) best = rows;
          if (rows.length && (pc.market !== "bj" || rows.length >= 2)) return rows;
        } catch (error) { lastError = error; }
      }
      if (attempt < 2) await sleep(300 * (attempt + 1));
    }
    if (best.length) return best;
    if (lastError) throw lastError;
    return [];
  }
  if (id === "sina") {
    // 新浪该接口提供日线，可作为东财历史域名不可达时的独立容灾源；
    // 周/月线继续交给其他原生周期数据源，避免前端得到伪周期数据。
    if (period !== "day") return [];
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${pc.symbol}&scale=240&ma=no&datalen=${Math.min(1023, Math.max(2, Number(count) || 160))}`;
    return parseSinaKline(await fetchChecked(url, { headers: { "User-Agent": UA, Referer: SINA_REFERER } }, 15000));
  }
  if (id === "tushare") return tushareKline(code, period, count);
  if (["tdx","baostock","akshare"].includes(id)) return bridgeCall(id, "kline", { code, period, count });
  return customKline(id, pc, period, count);
}

export function parseEastmoneyMinute(json) {
  const d = json?.data; const rows = d?.trends || [];
  const points = Array.isArray(rows) ? rows.map((line) => { const p = String(line).split(","); const hm = String(p[0] || "").slice(-5).replace(":", ""); const price = Number(p[1]); if (!/^\d{4}$/.test(hm) || !(price > 0)) return null; return { t: Number(hm.slice(0,2))*60+Number(hm.slice(2,4)), p: price, v: Number(p[5]) || 0, amount: Number(p[6]) || 0, avgPrice: Number(p[2]) || null }; }).filter(Boolean) : [];
  const price = points.at(-1)?.p ?? null, prevClose = Number(d?.prePrice) || null;
  return { prevClose, points, name: d?.name || null, price, changePercent: price && prevClose ? (price / prevClose - 1) * 100 : null };
}

async function builtinMinute(id, code) {
  const pc = normalizeStockCode(code); if (!pc) return { prevClose:null,points:[],name:null,price:null,changePercent:null };
  if (id === "tencent") {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${pc.symbol}&r=${Math.random()}`;
    const j = await fetchChecked(url, { headers: { "User-Agent": UA, Referer: "https://gu.qq.com/" } }, 12000);
    const sd = j?.data?.[pc.symbol], raw = sd?.data?.data || [], points = [];
    let prevCumVol=0, prevCumAmount=0;
    for (const line of Array.isArray(raw)?raw:[]) { const p=String(line).split(" "); if(p.length<2)continue; const hm=p[0],price=Number(p[1]),cumVol=Number(p[2])||0,cumAmount=Number(p[3])||0;if(!/^\d{4}$/.test(hm)||!(price>0))continue;const v=cumVol>=prevCumVol?cumVol-prevCumVol:cumVol,amount=cumAmount>=prevCumAmount?cumAmount-prevCumAmount:cumAmount;points.push({t:Number(hm.slice(0,2))*60+Number(hm.slice(2,4)),p:price,v:Math.max(0,v),amount:Math.max(0,amount),cumVol,cumAmount});prevCumVol=cumVol;prevCumAmount=cumAmount; }
    const qt=sd?.qt?.[pc.symbol]; let price=null,prevClose=null,changePercent=null,name=null; if(Array.isArray(qt)){price=Number(qt[3])||null;prevClose=Number(qt[4])||null;changePercent=Number(qt[32]);name=String(qt[1]||"");}
    return { prevClose, points, name, price, changePercent:Number.isFinite(changePercent)?changePercent:(price&&prevClose?(price/prevClose-1)*100:null) };
  }
  if (id === "eastmoney") {
    const path = `/api/qt/stock/trends2/get?secid=${pc.secid}&fields1=f1,f2,f3,f4,f5,f6,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&iscca=0&_=${Date.now()}`;
    let lastError;
    const hosts = pc.market === "bj"
      ? ["push2his.eastmoney.com", "push2delay.eastmoney.com"]
      : ["push2delay.eastmoney.com", "push2his.eastmoney.com"];
    for (const host of hosts) {
      try {
        const minute = parseEastmoneyMinute(await fetchChecked(`https://${host}${path}`, { headers: { "User-Agent": UA, Referer: EM_REFERER } }, 12000));
        if (minute.points.length) return minute;
      } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    return { prevClose:null,points:[],name:null,price:null,changePercent:null };
  }
  if (["tdx","akshare"].includes(id)) return bridgeCall(id, "minute", { code });
  return customMinute(id, pc);
}

function replaceVars(value, vars, encode = true) {
  if (typeof value === "string") return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m,k) => encode ? encodeURIComponent(vars[k] ?? "") : String(vars[k] ?? ""));
  if (Array.isArray(value)) return value.map((x)=>replaceVars(x,vars,encode));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replaceVars(v,vars,encode)]));
  return value;
}
function getPath(obj, path) { if (!path) return obj; return String(path).split(".").filter(Boolean).reduce((a,k)=>a==null?undefined:a[k],obj); }
function mappedObject(row, map) {
  const out={}; for(const [to,spec] of Object.entries(map||{})){ if(typeof spec==="string")out[to]=getPath(row,spec);else if(spec&&typeof spec==="object"){const v=getPath(row,spec.path);const n=Number(v);out[to]=Number.isFinite(n)&&spec.multiplier!=null?n*Number(spec.multiplier):v;} }
  return out;
}
function validateCustomUrl(raw, allowPrivateHost=false) {
  let u; try { u=new URL(raw); } catch { throw new ProviderError("自定义数据源 URL 无效"); }
  if(!["https:","http:"].includes(u.protocol)) throw new ProviderError("自定义数据源只允许 HTTP/HTTPS");
  const h=u.hostname.toLowerCase(); const privateHost = h==="localhost" || h==="::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if(privateHost && !allowPrivateHost) throw new ProviderError("自定义数据源指向本机/内网；如确需本地付费网关，请在该 endpoint 显式设置 allowPrivateHost=true");
  return u.toString();
}
async function customCall(id, capability, vars) {
  const p=config.customProviders.find((x)=>x.id===id), ep=p?.[capability]; if(!p||!ep)throw new ProviderError("自定义数据源未配置该能力");
  const secret=secrets[id]||"", allVars={...vars,secret};
  const url=validateCustomUrl(replaceVars(ep.url,allVars,true),ep.allowPrivateHost), headers=replaceVars(ep.headers||{},allVars,false), body=ep.body?JSON.stringify(replaceVars(ep.body,allVars,false)):undefined;
  const init={method:ep.method,headers:{"User-Agent":UA,...headers},responseType:ep.responseType};if(body){init.body=body;if(!Object.keys(init.headers).some((k)=>k.toLowerCase()==="content-type"))init.headers["Content-Type"]="application/json";}
  const raw=await fetchChecked(url,init,15000);return getPath(raw,ep.root);
}
async function customQuotes(id,norm){
  const p=config.customProviders.find((x)=>x.id===id);
  if(p?.quote?.batch){
    const root=await customCall(id,"quote",{symbols:norm.map(x=>x.symbol).join(","),codes:norm.map(x=>x.code).join(",")});
    const rows=Array.isArray(root)?root:[root];
    return rows.map((x,i)=>{const row=mappedObject(x,p.quote.map);const fallback=norm[i]||norm[0];const code=String(row.code||fallback?.code||"").replace(/^(sh|sz|bj)/i,"");const market=String(row.market||"").toLowerCase();const symbol=String(row.symbol||((market&&code)?`${market}${code}`:fallback?.symbol||""));return Number(row.price)>0?{...row,code,symbol,price:Number(row.price),prevClose:Number(row.prevClose)||null,high:Number(row.high)||null,low:Number(row.low)||null,open:Number(row.open)||null,volume:Number(row.volume)||0,amount:Number(row.amount)||0,changePercent:Number(row.changePercent)||0,changeAmount:Number(row.changeAmount)||0}:null;}).filter(Boolean);
  }
  const out=[];
  for(let i=0;i<norm.length;i++){
    if(i>0) await sleep(Number(p?.minIntervalMs)||5000);
    const pc=norm[i],root=await customCall(id,"quote",pc),row=mappedObject(Array.isArray(root)?root[0]:root,p.quote.map);
    if(Number(row?.price)>0)out.push({code:pc.code,symbol:pc.symbol,...row,price:Number(row.price)});
  }
  return out;
}
async function customKline(id,pc,period,count){const root=await customCall(id,"kline",{...pc,period,count});const p=config.customProviders.find((x)=>x.id===id);return (Array.isArray(root)?root:[]).map((x)=>mappedObject(x,p.kline.map)).filter((x)=>x.time&&Number(x.close)>0);}
async function customMinute(id,pc){const root=await customCall(id,"minute",pc);const p=config.customProviders.find((x)=>x.id===id);const rows=Array.isArray(root)?root:[];const points=rows.map((x)=>mappedObject(x,p.minute.map)).map((x)=>({t:Number(x.t),p:Number(x.p),v:Number(x.v)||0,amount:Number(x.amount)||0})).filter((x)=>Number.isFinite(x.t)&&x.p>0);return {prevClose:null,points,name:null,price:points.at(-1)?.p??null,changePercent:null};}

async function executeWithProvider(id, capability, fn) {
  await respectRate(id, capability);
  const started = now();
  try { const value = await fn(); noteSuccess(id, now()-started); return value; }
  catch (e) { noteFailure(id, e); throw e; }
}

async function routed(capability, key, providerCall, valid, opts={}) {
  // A cache entry is only reusable while it still satisfies the caller's
  // completeness rule. This evicts legacy one-candle BSE responses instead of
  // allowing them to mask a healthy fallback provider for the entire TTL.
  const fresh=getCache(capability,key,false); if(fresh&&!opts.force&&valid(fresh.data))return {...fresh,fromCache:true};
  const ik=ckey(capability,key); if(inflight.has(ik))return inflight.get(ik);
  const task=(async()=>{
    const errors=[];
    const excluded = new Set(Array.isArray(opts.excludeProviders) ? opts.excludeProviders.map(String) : []);
    let candidates = orderedCandidates(capability, opts.preferredProviders).filter((x) => !excluded.has(x));
    if (capability === 'minute') {
      // Only two built-in sources race. Coalescing and per-source rate limits
      // still apply; a stalled endpoint no longer blocks the healthy source.
      const parallel = candidates.filter(id => ['tencent','eastmoney'].includes(id));
      if (parallel.length) {
        try {
          const result = await Promise.any(parallel.map(async id => {
            const data = await executeWithProvider(id, capability, () => providerCall(id));
            if (!valid(data)) throw new Error(`${id}:empty`);
            return {data,provider:id,stale:false,fromCache:false};
          }));
          setCache(capability,key,result.data,result.provider);
          return result;
        } catch (error) { errors.push(...(error.errors || [error]).map(e => String(e.message || e))); }
        candidates = candidates.filter(id => !parallel.includes(id));
      }
    }
    for(const id of candidates){
      try{const data=await executeWithProvider(id,capability,()=>providerCall(id));if(valid(data)){setCache(capability,key,data,id);return{data,provider:id,stale:false,fromCache:false};}errors.push(`${id}:empty`);}catch(e){errors.push(`${id}:${e?.message||e}`);}
    }
    const stale=config.staleFallback!==false?getCache(capability,key,true):null;if(stale&&valid(stale.data))return{...stale,fromCache:true,error:errors.join(" | ")};
    return{data:null,provider:null,stale:false,fromCache:false,error:errors.join(" | ")||"无可用数据源"};
  })().finally(()=>inflight.delete(ik)); inflight.set(ik,task); return task;
}

/** Batch quotes; returns one normalized row per successfully returned symbol plus route metadata. */
export async function getQuotes(codes, opts={}) {
  const unique=[...new Set((codes||[]).map((x)=>normalizeStockCode(x)?.symbol).filter(Boolean))];
  if(!unique.length)return{rows:[],provider:null,stale:false};
  const key=unique.slice().sort().join(",");
  const r=await routed("quote",key,(id)=>builtinQuotes(id,unique),(x)=>Array.isArray(x)&&x.length>0,opts);
  const requested=new Set(unique), bySymbol=new Map(), providers=[];
  const mergeRows=(items,provider,stale=false)=>{
    if(provider&&!providers.includes(provider))providers.push(provider);
    for(const row of Array.isArray(items)?items:[]){
      const symbol=normalizeStockCode(row?.symbol||row?.code)?.symbol;
      if(!symbol||!requested.has(symbol)||bySymbol.has(symbol))continue;
      bySymbol.set(symbol,{...row,symbol,_provider:provider,_stale:!!stale,_fetchedAt:now()});
    }
  };
  mergeRows(r.data,r.provider,r.stale);
  const excluded=[r.provider].filter(Boolean);
  // 某个批量源只返回部分证券时（典型是旧源尚不支持新北交所代码），
  // 只让其他健康源补齐缺口，避免“整批有一条就算成功”造成静默缺失。
  for(let pass=0;pass<3;pass++){
    const missing=unique.filter((symbol)=>!bySymbol.has(symbol));if(!missing.length)break;
    const repair=await routed("quote",`repair:${missing.slice().sort().join(",")}:${excluded.join(",")}`,(id)=>builtinQuotes(id,missing),(x)=>Array.isArray(x)&&x.length>0,{...opts,force:opts.force===true,excludeProviders:excluded});
    if(!repair.provider||!Array.isArray(repair.data)||!repair.data.length)break;
    mergeRows(repair.data,repair.provider,repair.stale);
    if(!excluded.includes(repair.provider))excluded.push(repair.provider);
  }
  const rows=unique.map((symbol)=>bySymbol.get(symbol)).filter(Boolean);
  return{...r,data:undefined,rows,providers,partial:rows.length<unique.length,missing:unique.filter((symbol)=>!bySymbol.has(symbol))};
}
export async function getQuote(code,opts={}){const r=await getQuotes([code],opts);return{quote:r.rows[0]||null,provider:r.rows[0]?._provider||r.provider,stale:r.rows[0]?._stale??r.stale,error:r.error};}
export async function getKline(code,period="day",count=160,opts={}){
  const pc=normalizeStockCode(code);
  const key=`${pc?.symbol||code}:${period}:${count}`;
  const routeOpts=pc?.market==="bj"?{...opts,preferredProviders:["eastmoney","sina",...(opts.preferredProviders||[])]}:opts;
  // Tencent currently answers some new BSE symbols with only the current-day
  // candle. One bar is not a usable history and also makes every indicator fail.
  const minBars=pc?.market==="bj"?2:1;
  const r=await routed("kline",key,(id)=>builtinKline(id,code,period,count),(x)=>Array.isArray(x)&&x.length>=minBars,routeOpts);
  return{candles:(r.data||[]).map((x)=>({...x,_provider:r.provider})),provider:r.provider,stale:r.stale,error:r.error};
}
export async function getMinute(code,opts={}){const pc=normalizeStockCode(code);const key=pc?.symbol||String(code);const routeOpts=pc?.market==="bj"?{...opts,preferredProviders:["eastmoney",...(opts.preferredProviders||[])]}:opts;const r=await routed("minute",key,(id)=>builtinMinute(id,code),(x)=>x&&Array.isArray(x.points)&&x.points.length>0,routeOpts);return{...(r.data||{prevClose:null,points:[],name:null,price:null,changePercent:null}),provider:r.provider,stale:r.stale,error:r.error};}

export function resetProviderBreaker(id=null){if(id){const h=providerHealth(id);h.blockedUntil=0;h.consecutiveFailures=0;h.lastError="";h.wafBlocks=0;}else for(const h of health.values()){h.blockedUntil=0;h.consecutiveFailures=0;h.lastError="";h.wafBlocks=0;}persistHealthSoon();return getDataSourceStatus();}
export function getDataSourceStatus(){
  const ids=["tencent","eastmoney","sina","tdx","tushare","baostock","akshare","exchange",...config.customProviders.map((x)=>x.id)];
  return {config:getDataSourceConfig(),providers:ids.map((id)=>{const m=providerMeta(id),p=providerCfg(id),h=providerHealth(id);return{id,label:m?.label||id,kind:m?.kind||"unknown",enabled:p?.enabled!==false,capabilities:m?.capabilities||[],priority:p?.priority||50,blocked:h.blockedUntil>now(),blockedUntil:h.blockedUntil||0,requests:h.requests,successes:h.successes,failures:h.failures,successRate:h.requests?Math.round(h.successes/h.requests*100):null,latencyMs:h.latencyMs,lastSuccessAt:h.lastSuccessAt,lastFailureAt:h.lastFailureAt,lastError:h.lastError,wafBlocks:h.wafBlocks};})};
}

/**
 * Govern a provider-specific request that has no interchangeable schema (F10, capital flow,
 * sector constituents, etc.). It still shares enable/limit/circuit/health state with quote data.
 * No WAF bypass is attempted; a blocked provider fails fast until cooldown expires.
 */
export async function providerRequest(id, url, init = {}, opts = {}) {
  id = String(id || "");
  const p = providerCfg(id);
  if (!p || config.enabled === false || p.enabled === false) throw new ProviderError(`${id || "数据源"}已关闭`);
  const h = providerHealth(id);
  if (h.blockedUntil > now()) throw new ProviderError(`${providerMeta(id)?.label || id}处于熔断冷却`, { blockedUntil: h.blockedUntil });
  const capability = String(opts.capability || "aux");
  return executeWithProvider(id, capability, () => fetchChecked(url, init, Number(opts.timeoutMs) || 12000));
}

/** 仅在本地静态证券名单不足时调用；缓存和 aux 限速防止输入联想形成高频请求。 */
export async function searchMarketSymbols(needle, limit = 20) {
  const q = String(needle || "").trim();
  if (!q || config.enabled === false || !isProviderEnabled("eastmoney")) return [];
  limit = Math.max(1, Math.min(50, Number(limit) || 20));
  const key = q.toLowerCase();
  const cached = symbolSearchCache.get(key);
  if (cached && now() - cached.at < 10 * 60 * 1000) return cached.rows.slice(0, limit);
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&token=D43BF722C8E33DDF0D2D59BB3204E9&count=${limit}`;
  const json = await providerRequest("eastmoney", url, { headers: { "User-Agent": UA, Referer: EM_REFERER } }, { capability: "aux", timeoutMs: 12000 });
  const rows = parseEastmoneySuggestions(json).slice(0, limit);
  symbolSearchCache.set(key, { at: now(), rows });
  if (symbolSearchCache.size > 100) symbolSearchCache.delete(symbolSearchCache.keys().next().value);
  return rows;
}

/**
 * Complete exchange directory used to fill gaps in the bundled A-share list.
 * Beijing Stock Exchange is intentionally fetched separately: its 4/8/92 code
 * families are absent from older local lists and the suggest API only returns a
 * small relevance-ranked subset, not the complete exchange universe.
 */
export async function getMarketStockDirectory(market = "bj", opts = {}) {
  const key = String(market || "bj").toLowerCase();
  if (key !== "bj") return [];
  const cached = marketDirectoryCache.get(key);
  if (!opts.force && cached && now() - cached.at < 12 * 3600000) return cached.rows;
  if (marketDirectoryInflight.has(key)) return marketDirectoryInflight.get(key);
  const task = (async () => {
    const pageSize = 100, rows = [], seen = new Set();
    let total = Infinity;
    for (let page = 1; page <= 20 && rows.length < total; page++) {
      const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent("m:0+t:81+s:2048")}&fields=f12,f13,f14`;
      const json = await providerRequest("eastmoney", url, { headers: { "User-Agent": UA, Referer: EM_REFERER } }, { capability: "aux", timeoutMs: 12000 });
      const reportedTotal = Number(json?.data?.total);
      if (Number.isFinite(reportedTotal) && reportedTotal > 0) total = reportedTotal;
      const raw = Array.isArray(json?.data?.diff) ? json.data.diff : [];
      for (const item of parseEastmoneySecurityDirectory(json, "bj")) {
        if (seen.has(item.symbol)) continue;
        seen.add(item.symbol); rows.push(item);
      }
      if (!raw.length || raw.length < pageSize) break;
    }
    if (rows.length) marketDirectoryCache.set(key, { at: now(), rows });
    return rows;
  })().finally(() => marketDirectoryInflight.delete(key));
  marketDirectoryInflight.set(key, task);
  return task;
}

export async function testDataSources(sampleCode="sh600519"){
  const results=[];
  for(const id of ["tencent","eastmoney","sina","tdx","tushare","baostock","akshare","exchange",...config.customProviders.map((x)=>x.id)]){
    const m=providerMeta(id),p=providerCfg(id);if(!m||!p||p.enabled===false)continue;
    for(const cap of m.capabilities){const started=now();try{let ok=false,detail="";if(cap==="quote"){const x=await executeWithProvider(id,cap,()=>builtinQuotes(id,[sampleCode]));ok=x.length>0;detail=ok?`${x[0].name||sampleCode} ${x[0].price}`:"empty";}else if(cap==="kline"){const x=await executeWithProvider(id,cap,()=>builtinKline(id,sampleCode,"day",30));ok=x.length>=10;detail=`${x.length} bars`;}else if(cap==="minute"){const x=await executeWithProvider(id,cap,()=>builtinMinute(id,sampleCode));ok=x.points.length>0;detail=`${x.points.length} points`;}else if(cap==="aux"){ if(id==="exchange"){ok=true;detail="权威辅助源：已注册（不主动高频抓取）";} else if(id==="tushare"){const token=String(secrets.tushare||"").trim();ok=!!token;detail=ok?"Token 已配置":"未配置 Token";} else {ok=true;detail="辅助能力已注册；按需调用";} }results.push({id,capability:cap,ok,latencyMs:now()-started,detail});}catch(e){results.push({id,capability:cap,ok:false,latencyMs:now()-started,error:e?.message||String(e),status:e?.status||null,waf:!!e?.waf});}}
  }
  return{testedAt:now(),sampleCode,results,status:getDataSourceStatus()};
}
