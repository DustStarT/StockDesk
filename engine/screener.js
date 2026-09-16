/**
 * StockDesk 选股器 — 行业板块 → 成分股 → 基本面快筛 → 量化信号 → 综合排序
 * 逻辑与原 dsh-stock-watch 插件的 screenSector 一致，独立成模块供桌面应用使用。
 */
import { emBoardConst, emBoardKline, dedupeIndustryBoards } from "./market-fetchers.js";
import { sinaBoardConst, sinaIndustries, emIndustries } from "./sectors.js";
import { analyzeDaily, analyzeSignals } from "./indicators.js";
import * as dataHub from "./data-provider-hub.js";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ---- 行业列表缓存（内存 + 磁盘回退，与原插件一致） ----
const boardListCache = new Map();
const BOARD_LIST_TTL = 60 * 1000;
const BOARDS_CACHE_PATH = join(homedir(), ".stockdesk", "boards-cache.json");

function readBoardsCacheFor(source) {
  try {
    const j = JSON.parse(readFileSync(BOARDS_CACHE_PATH, "utf8"));
    const list = source === "eastmoney" && Array.isArray(j.boards) ? j.boards : j[source];
    if (Array.isArray(list) && list.length > 0) {
      return dedupeIndustryBoards(list);
    }
  } catch {}
  return [];
}
function writeBoardsCacheFor(source, boards) {
  try {
    let j = {};
    try { j = JSON.parse(readFileSync(BOARDS_CACHE_PATH, "utf8")); } catch { j = {}; }
    if (!j || typeof j !== "object") j = {};
    if (Array.isArray(j.boards)) delete j.boards;
    j[source] = boards.map((b) => ({ code: String(b.code), name: String(b.name ?? b.code), count: b.count }));
    mkdirSync(dirname(BOARDS_CACHE_PATH), { recursive: true });
    writeFileSync(BOARDS_CACHE_PATH, JSON.stringify({ cachedAt: Date.now(), ...j }, null, 2), "utf8");
  } catch {}
}

async function fetchIndustries(source) {
  const hit = boardListCache.get(source);
  if (hit && hit.expireAt > Date.now()) return { boards: hit.boards, source, fromCache: false };
  let boards = null;
  for (let attempt = 0; attempt < 2 && !boards; attempt++) {
    try {
      const rows = source === "sina" ? await sinaIndustries() : await emIndustries();
      if (Array.isArray(rows) && rows.length > 0) boards = rows;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (boards) {
    const normalized = dedupeIndustryBoards(boards);
    boardListCache.set(source, { expireAt: Date.now() + BOARD_LIST_TTL, boards: normalized });
    writeBoardsCacheFor(source, normalized);
    return { boards: normalized, source, fromCache: false };
  }
  const cached = readBoardsCacheFor(source);
  if (cached.length > 0) return { boards: cached, source, fromCache: true };
  return { boards: [], source, fromCache: true };
}

export async function loadIndustries(preferredSource = "auto") {
  const requested = preferredSource === "eastmoney" || preferredSource === "sina" ? [preferredSource] : ["eastmoney", "sina"];
  const order = requested.filter((src) => dataHub.isProviderEnabled(src));
  if (!order.length) return { boards: [], source: preferredSource === "sina" ? "sina" : "eastmoney", fromCache: true };
  for (const src of order) {
    const res = await fetchIndustries(src);
    if (res.boards.length > 0 && !res.fromCache) return { boards: res.boards, source: src, fromCache: false };
  }
  for (const src of order) {
    const res = await fetchIndustries(src);
    if (res.boards.length > 0) return { boards: res.boards, source: src, fromCache: true };
  }
  return { boards: [], source: preferredSource === "sina" ? "sina" : "eastmoney", fromCache: true };
}

// ---- 腾讯 K 线（信号计算用） ----
async function fetchKlineCached(code) {
  const key = code;
  const hit = klineLocalCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  try {
    const routed = await dataHub.getKline(code, "day", 160);
    const candles = routed.candles || [];
    if (candles.length) { klineLocalCache.set(key, { exp: Date.now() + 5 * 60 * 1000, data: candles }); while (klineLocalCache.size > 30) klineLocalCache.delete(klineLocalCache.keys().next().value); }
    return candles;
  } catch { return []; }
}
const klineLocalCache = new Map();
const TECHNICAL_SCAN_BUDGET = 6;

const num = (v, d = 0) => { const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? n : d; };

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/** 板块动量（近 20/60 日涨幅，-12..12） */
function boardMomentum(klines) {
  if (!Array.isArray(klines) || klines.length < 61) return 0;
  const closes = klines.map((c) => c.close).filter((x) => Number.isFinite(x));
  const last = closes[closes.length - 1];
  const c20 = closes[closes.length - 20];
  const c60 = closes[closes.length - 61];
  let boost = 0;
  if (c20 > 0) boost += Math.max(-8, Math.min(8, ((last - c20) / c20) * 100));
  if (c60 > 0) boost += Math.max(-4, Math.min(4, ((last - c60) / c60) * 100));
  return Math.round(boost);
}

/** 板块内相对分位（0..100，值越小排名越靠前） */
function rankPercentile(values) {
  const pairs = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v) && v > 0) pairs.push({ v, i });
  }
  const rank = new Array(values.length).fill(null);
  pairs.sort((a, b) => a.v - b.v);
  const n = pairs.length;
  pairs.forEach((p, idx) => { rank[p.i] = n > 1 ? Math.round(((idx + 1) / n) * 100) : 50; });
  return rank;
}

/** 基本面快筛分（0..100） */
function quickValueScore(s, peRank, pbRank, boost) {
  let score = 50;
  // v1.1：分位越低代表板块内相对估值越低，应加分而不是扣分。
  if (peRank != null) score += (50 - peRank) * 0.6;
  if (pbRank != null) score += (50 - pbRank) * 0.4;
  const mcap = s.mcap, turnover = s.turnover;
  if (mcap != null && Number.isFinite(mcap) && mcap > 0) {
    const yi = mcap / 1e8;
    if (yi >= 50 && yi <= 800) score += 8;
    else if (yi < 30) score -= 10;
    else if (yi > 3000) score -= 6;
  }
  if (turnover != null && Number.isFinite(turnover)) {
    // 统一按“百分数值”处理：3.3 表示 3.3%，与东财 fltt=2 / 实时行情口径一致。
    if (turnover >= 0.8 && turnover <= 8) score += 6;
    else if (turnover > 15) score -= 6;
    else if (turnover < 0.3) score -= 3;
  }
  if (s.changePct != null && Number.isFinite(s.changePct)) {
    if (s.changePct > 0 && s.changePct <= 5) score += 6;
    else if (s.changePct > 8) score -= 8;
    else if (s.changePct < -8) score -= 6;
  }
  score += (boost ?? 0) * 1.2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

const verdictOf = (score) => (score >= 20 ? "buy" : score <= -20 ? "sell" : "hold");
const normalizeApiCode = (code) => dataHub.normalizeStockCode(code)?.symbol || String(code || "");

/** 行业选股主流程。
 * maxResults <= 0 表示返回全部；为保护免费行情接口，单行业安全上限 500 只。
 * 技术信号以小并发批量计算，失败的个股保留在列表中并标记为“技术数据不足”。
 */
export async function screenSector(source, boardCode, method = "hybrid", maxResults = 0) {
  let stocks = [], boardKlines = [];
  try {
    [stocks, boardKlines] = await Promise.all([
      source === "sina" ? sinaBoardConst(boardCode, 500) : emBoardConst(boardCode, 0),
      source === "sina" ? Promise.resolve([]) : emBoardKline(boardCode, 300).catch(() => []),
    ]);
  } catch {
    return { board: boardCode, source, method, error: "行业板块数据暂不可用（行情接口繁忙），请稍后再试", rows: [] };
  }
  const pool = (stocks || []).filter((s) => s.name && !/^(ST|\*ST)/.test(s.name)).slice(0, 500);
  if (pool.length === 0) {
    return { board: boardCode, source, method, error: "该板块暂无可用成分股（或行情接口繁忙），请稍后再试", rows: [] };
  }
  let momentum = 0;
  if (source !== "sina") {
    momentum = boardMomentum(boardKlines);
  }
  const peRank = rankPercentile(pool.map((s) => s.peTtm));
  const pbRank = rankPercentile(pool.map((s) => s.pb));
  const ranked = pool
    .map((s, i) => ({ ...s, quick: quickValueScore(s, peRank[i], pbRank[i], momentum), apiCode: normalizeApiCode(String(s.code)) }))
    .sort((a, b) => b.quick - a.quick);

  // 先用板块快照给全量股票排序，只为最强候选补充 K 线，避免数百只股票排队请求。
  const technicalCandidates = ranked.slice(0, Math.min(TECHNICAL_SCAN_BUDGET, ranked.length));
  const techs = await mapLimit(technicalCandidates, 4, async (s) => {
    try {
      const candles = await fetchKlineCached(s.code);
      return { code: String(s.code), sig: candles.length ? analyzeSignals(analyzeDaily(candles)) : null };
    } catch { return { code: String(s.code), sig: null }; }
  });
  const techMap = new Map(techs.map((t) => [t.code, t.sig]));
  const scannedCodes = new Set(technicalCandidates.map((s) => String(s.code)));

  const rows = ranked.map((s) => {
    const sig = techMap.get(String(s.code)) || null;
    const techScore = sig ? sig.score : 0;
    const valueScore = Math.round((s.quick - 50) * 2);
    let final = techScore;
    if (method === "value") final = Math.round(techScore * 0.3 + valueScore * 0.7);
    else if (method === "hybrid") final = Math.round(techScore * 0.6 + valueScore * 0.4);
    const reasons = [];
    if (sig && Array.isArray(sig.signals)) for (const sgn of sig.signals.slice(0, 3)) reasons.push(sgn.label);
    if (s.quick >= 70) reasons.push("板块内相对估值/流动性较优");
    else if (s.quick <= 35) reasons.push("板块内相对估值/交易质量偏弱");
    if (momentum >= 6 && final > 0) reasons.push("板块景气强");
    if (!sig) reasons.push(scannedCodes.has(String(s.code)) ? "技术K线暂不可用，技术分按中性处理" : "快速扫描预算外，技术分按中性处理");
    return {
      code: String(s.code), apiCode: s.apiCode, name: s.name, price: s.price, changePct: s.changePct,
      mcap: s.mcap, peTtm: s.peTtm, pb: s.pb, turnover: s.turnover,
      tech: sig ? { score: sig.score, verdict: sig.verdict, confidence: sig.confidence, summary: sig.summary } : null,
      value: s.quick, final, verdict: verdictOf(final), reasons, boardMomentum: momentum,
    };
  });
  rows.sort((a, b) => b.final - a.final || b.value - a.value);
  const requested = Number(maxResults);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.floor(requested)) : 0;
  const visibleRows = limit ? rows.slice(0, limit) : rows;
  const technicalCoverage = rows.filter((r) => !!r.tech).length;
  return {
    board: boardCode, source, method, boardMomentum: momentum, constituents: pool.length,
    eligible: rows.length, returned: visibleRows.length, technicalCoverage, technicalScanBudget: TECHNICAL_SCAN_BUDGET, rows: visibleRows,
  };
}
