import * as dataHub from "./data-provider-hub.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/**
 * market-fetchers.js — 东方财富免费 HTTP 接口（本机已验证连通）
 * 提供：快照/F10 财务历史/龙虎榜+席位/行业板块+成分/研报/分红
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REFERER = "https://data.eastmoney.com/";
// 东财行情主域名。部分网络环境下 push2 / push2his 的 /api/* 路径会被链路重置
// （UND_ERR_SOCKET）而根路径/其它东财域名正常；官方备用域名 push2delay
// 提供同一套接口（含历史 K 线），getJson 在失败时自动降级过去。
const EM_QUOTE_HOSTS = ["push2.eastmoney.com", "push2his.eastmoney.com"];
const EM_QUOTE_FALLBACK_HOST = "push2delay.eastmoney.com";
const jsonCache = new Map();
const jsonInflight = new Map();
const JSON_CACHE_MAX = 320;
const BOARD_DIRECTORY_PATH = join(homedir(), ".stockdesk", "em-board-directory.json");
const LEGACY_BOARDS_CACHE_PATH = join(homedir(), ".stockdesk", "boards-cache.json");
const BOARD_DIRECTORY_TTL = 24 * 60 * 60 * 1000;
let boardDirectoryCache = null;
let boardDirectoryInflight = null;
let boardDirectoryRetryAt = 0;

function jsonCacheTtl(url) {
  const s = String(url);
  if (/\/api\/qt\/stock\/get\?/.test(s)) return 8000;
  if (/\/api\/qt\/ulist\.np\/get\?/.test(s)) return 8000;
  if (/fflow\/daykline/.test(s)) return 60 * 1000;
  if (/fs=m:90\+t:2/.test(s)) return 30 * 60 * 1000;
  if (/\/api\/qt\/clist\/get/.test(s)) return 60 * 1000;
  if (/FINANCE_MAINFINADATA|SHAREBONUS|report\/list|\/api\/security\/ann/i.test(s)) return 30 * 60 * 1000;
  if (/BILLBOARD/i.test(s)) return 5 * 60 * 1000;
  if (/\/kline\/get/.test(s)) return 10 * 60 * 1000;
  return 2 * 60 * 1000;
}

/** 归一化代码：sh600519 / sz000858 / 600519 → {market, code, secid} */
export function parseCode(input) {
  const raw = String(input || "").trim().toLowerCase();
  let market;
  let code;
  if (raw.startsWith("sh")) { market = "sh"; code = raw.slice(2); }
  else if (raw.startsWith("sz")) { market = "sz"; code = raw.slice(2); }
  else if (raw.startsWith("bj")) { market = "bj"; code = raw.slice(2); }
  else {
    code = raw;
    market = /^(92|8|4)/.test(code) ? "bj" : /^(60|68|51|50|90)/.test(code) ? "sh" : /^(00|30|20)/.test(code) ? "sz" : "sh";
  }
  if (!/^\d{6}$/.test(code)) return null;
  if (/^92/.test(code)) market = "bj";
  return { market, code, secid: `${market === "sh" ? 1 : 0}.${code}`, secucode: `${code}.${market.toUpperCase()}` };
}

/** 带重试的 GET JSON（东财偶发限流断连，2 次退避重试；push2/push2his API 路径被重置时降级到 push2delay 备用域名） */
async function getJson(url, timeoutMs = 12000, retries = 2) {
  if (/eastmoney\.com/i.test(String(url)) && !dataHub.isProviderEnabled("eastmoney")) throw new Error("东方财富数据源已在设置中关闭");
  const cached = jsonCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (jsonInflight.has(url)) return jsonInflight.get(url);
  const task = (async () => {
  // push2delay 在部分网络中明显更稳定，优先使用并保留主域名回退。
  const isCapitalFlow = /\/fflow\/daykline\/get\?/.test(url);
  const candidates = isCapitalFlow ? [url, url.replace("push2his.eastmoney.com", EM_QUOTE_FALLBACK_HOST)] : EM_QUOTE_HOSTS.some((host) => url.includes(host))
    ? [url.replace(new RegExp(EM_QUOTE_HOSTS.join("|")), EM_QUOTE_FALLBACK_HOST), url]
    : [url];
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    for (const candidate of candidates) {
      try {
        const data = await dataHub.providerRequest("eastmoney", candidate, { headers: { "User-Agent": UA, "Referer": REFERER } }, { capability: "aux", timeoutMs });
        if (isCapitalFlow && (Number(data?.rc ?? 0) !== 0 || !Array.isArray(data?.data?.klines) || !data.data.klines.some((line) => parseCapitalFlowLine(line)?.mainNet != null))) {
          throw new Error(`资金流接口未返回有效数据（rc=${data?.rc ?? "未知"}）`);
        }
        jsonCache.set(url, { expiresAt: Date.now() + jsonCacheTtl(url), data });
        while (jsonCache.size > JSON_CACHE_MAX) jsonCache.delete(jsonCache.keys().next().value);
        return data;
      } catch (e) {
        lastErr = e;
        if (e?.waf || e?.blockedUntil || /熔断|已关闭/.test(String(e?.message || ""))) throw e;
      }
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw lastErr;
  })().finally(() => jsonInflight.delete(url));
  jsonInflight.set(url, task);
  return task;
}

const num = (v, d = 0) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

/** 解析东财实时快照 data。纯函数便于回归测试字段映射。 */
export function parseEmQuoteData(d) {
  if (!d) return null;
  return {
    code: d.f57,
    name: String(d.f58 || "").replace(/\s+/g, ""),
    price: num(d.f43) / 100,
    open: num(d.f46) / 100,
    high: num(d.f44) / 100,
    low: num(d.f45) / 100,
    volumeShou: num(d.f47),
    amount: num(d.f48),
    prevClose: num(d.f60) / 100,
    avgPrice: num(d.f71) / 100,
    volumeRatio: num(d.f50) / 100,
    limitUp: num(d.f51) / 100,
    limitDown: num(d.f52) / 100,
    totalShares: num(d.f84),
    floatShares: num(d.f85),
    netProfit: num(d.f105),
    marketCap: num(d.f116),
    floatMarketCap: num(d.f117),
    industry: d.f127,
    region: d.f128,
    peDyn: num(d.f162) / 100,
    peStatic: num(d.f163) / 100,
    peTtm: num(d.f164) / 100,
    pb: num(d.f167) / 100,
    turnover: num(d.f168) / 100,
    changeAmount: num(d.f169) / 100,
    changePct: num(d.f170) / 100,
    amplitude: num(d.f171) / 100,
    roe: num(d.f173),
    dividendYieldTtm: num(d.f177) / 100,
    revenue: num(d.f183),
    revenueYoy: num(d.f184),
    netProfitYoy: num(d.f185),
    grossMargin: num(d.f186),
    netMargin: num(d.f187),
    debtRatio: num(d.f188),
  };
}

/** 实时快照（含估值字段） */
export async function emQuote(codeInput) {
  const pc = parseCode(codeInput);
  if (!pc) return null;
  let detailed = null;
  try {
    const j = await getJson(`https://push2.eastmoney.com/api/qt/stock/get?secid=${pc.secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f57,f58,f60,f71,f84,f85,f105,f116,f117,f127,f128,f162,f163,f164,f167,f168,f169,f170,f171,f173,f177,f183,f184,f185,f186,f187,f188`);
    detailed = parseEmQuoteData(j?.data);
    if (Number(detailed?.price) > 0) return detailed;
  } catch {}

  // 深度分析和研报不能因单个 F10 快照域名失败而整体失败。先回退到
  // Provider Hub；停牌等无实时价场景再用最新日线收盘构造最小行情。
  const routed = await dataHub.getQuote(`${pc.market}${pc.code}`).catch(() => ({ quote: null }));
  const q = routed?.quote;
  if (Number(q?.price) > 0) {
    return {
      ...(detailed || {}), code: pc.code, name: q.name || detailed?.name || pc.code,
      price: Number(q.price), open: num(q.open, null), high: num(q.high, null), low: num(q.low, null),
      amount: num(q.amount, 0), prevClose: num(q.prevClose, null), changeAmount: num(q.changeAmount, null),
      changePct: num(q.changePercent, null), volumeShou: num(q.volume, 0),
    };
  }
  const history = await dataHub.getKline(`${pc.market}${pc.code}`, "day", 5).then((r) => r.candles || []).catch(() => []);
  const last = history.at(-1), prev = history.at(-2);
  if (Number(last?.close) > 0) {
    return {
      ...(detailed || {}), code: pc.code, name: detailed?.name || pc.code,
      price: Number(last.close), open: num(last.open, null), high: num(last.high, null), low: num(last.low, null),
      prevClose: num(prev?.close, null), changeAmount: prev?.close ? Number(last.close) - Number(prev.close) : null,
      changePct: prev?.close ? (Number(last.close) / Number(prev.close) - 1) * 100 : null,
      volumeShou: num(last.volume, 0), amount: num(detailed?.amount, 0),
    };
  }
  return null;
}

/** F10 主要财务指标历史（报告期降序，最多 n 期） */
export async function emF10Finance(codeInput, n = 8) {
  const pc = parseCode(codeInput);
  if (!pc) return [];
  const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&quoteColumns=&filter=(SECUCODE%3D%22${pc.secucode}%22)&pageNumber=1&pageSize=${n}&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  const j = await getJson(url);
  const rows = j?.result?.data || [];
  return rows.map((r) => ({
    reportDate: String(r.REPORT_DATE || "").slice(0, 10),
    reportName: r.REPORT_DATE_NAME,
    eps: num(r.EPSJB),
    bps: num(r.BPS),
    revenue: num(r.TOTALOPERATEREVE),
    revenueYoy: num(r.TOTALOPERATEREVETZ),
    netProfit: num(r.PARENTNETPROFIT),
    netProfitYoy: num(r.PARENTNETPROFITTZ),
    roe: num(r.ROEJQ),
    roeDeducted: num(r.ROEKCJQ),
    roic: num(r.ROIC),
    grossMargin: num(r.XSMLL),
    netMargin: num(r.XSJLL),
    debtRatio: num(r.ZCFZL),
    currentRatio: num(r.LD),
    quickRatio: num(r.SD),
    cashFlowRatio: num(r.XJLLB),
    ocf: num(r.NETCASH_OPERATE_PK),
    fcffForward: num(r.FCFF_FORWARD),
    fcffBack: num(r.FCFF_BACK),
    liability: num(r.LIABILITY),
    equity: num(r.TOTAL_EQUITY_PK),
    rdExpend: num(r.RDEXPEND),
    totalShares: num(r.TOTAL_SHARE),
  }));
}

/** 个股龙虎榜上榜明细（近 n 条） */
export async function emLhbList(codeInput, n = 10) {
  const pc = parseCode(codeInput);
  if (!pc) return [];
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&quoteColumns=&filter=(SECURITY_CODE%3D%22${pc.code}%22)&pageNumber=1&pageSize=${n}&sortTypes=-1&sortColumns=TRADE_DATE&source=WEB&client=WEB`;
  const j = await getJson(url);
  return (j?.result?.data || []).map((r) => ({
    tradeDate: String(r.TRADE_DATE || "").slice(0, 10),
    closePrice: num(r.CLOSE_PRICE),
    changeRate: num(r.CHANGE_RATE),
    turnoverRate: num(r.TURNOVERRATE),
    explanation: r.EXPLANATION,
    explain: r.EXPLAIN,
    buyAmt: num(r.BILLBOARD_BUY_AMT),
    sellAmt: num(r.BILLBOARD_SELL_AMT),
    netAmt: num(r.BILLBOARD_NET_AMT),
    dealAmtRatio: num(r.DEAL_AMOUNT_RATIO),
    sumBuyAmt: num(r.SUM_BUY_AMT),
    sumSellAmt: num(r.SUM_SELL_AMT),
    netBsAmt: num(r.NET_BS_AMT),
    d1: r.D1_CLOSE_ADJCHRATE == null ? null : num(r.D1_CLOSE_ADJCHRATE),
    d5: r.D5_CLOSE_ADJCHRATE === null ? null : num(r.D5_CLOSE_ADJCHRATE),
    d10: r.D10_CLOSE_ADJCHRATE === null ? null : num(r.D10_CLOSE_ADJCHRATE),
    tradeId: r.TRADE_ID,
  }));
}

/** 某次上榜（TRADE_ID）的买卖营业部明细 */
export async function emLhbSeats(tradeId) {
  const [buy, sell] = await Promise.all([
    getJson(`https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BILLBOARD_DAILYDETAILSBUY&columns=ALL&quoteColumns=&filter=(TRADE_ID%3D%22${tradeId}%22)&pageNumber=1&pageSize=20&sortTypes=-1&sortColumns=BUY&source=WEB&client=WEB`).catch(() => null),
    getJson(`https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BILLBOARD_DAILYDETAILSSELL&columns=ALL&quoteColumns=&filter=(TRADE_ID%3D%22${tradeId}%22)&pageNumber=1&pageSize=20&sortTypes=-1&sortColumns=SELL&source=WEB&client=WEB`).catch(() => null),
  ]);
  const rows = [];
  for (const r of buy?.result?.data || []) {
    rows.push({ side: "buy", dept: r.OPERATEDEPT_NAME, buy: num(r.BUY), sell: num(r.SELL), net: num(r.NET), explanation: r.EXPLANATION });
  }
  for (const r of sell?.result?.data || []) {
    if (!rows.some((x) => x.side === "buy" && x.dept === r.OPERATEDEPT_NAME)) {
      rows.push({ side: "sell", dept: r.OPERATEDEPT_NAME, buy: num(r.BUY), sell: num(r.SELL), net: num(r.NET), explanation: r.EXPLANATION });
    }
  }
  return rows;
}

function normalizeCachedBoard(row) {
  const parsed = row?.f12 ? parseBoardListRow(row) : row;
  if (!parsed?.code || !parsed?.name) return null;
  return {
    code: String(parsed.code), name: String(parsed.name),
    count: parsed.count != null && Number.isFinite(Number(parsed.count)) ? Number(parsed.count) : undefined,
  };
}

/** Remove duplicate board options from unstable paginated responses and legacy caches. */
export function dedupeIndustryBoards(input = []) {
  const rows = [], codes = new Set(), names = new Map(), levels = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const row = normalizeCachedBoard(raw);
    if (!row) continue;
    const codeKey = String(row.code).trim().toUpperCase();
    const compactName = String(row.name).normalize("NFKC").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "");
    const levelMatch = compactName.match(/([\u3400-\u9fff])((?:IV|III|II|I))$/i);
    const level = levelMatch ? ({ I:1, II:2, III:3, IV:4 }[levelMatch[2].toUpperCase()] || 0) : 0;
    const baseName = levelMatch ? compactName.slice(0, -levelMatch[2].length) : compactName;
    const nameKey = baseName.toLocaleLowerCase("zh-CN");
    if (!codeKey || !nameKey || codes.has(codeKey)) continue;
    const existing = names.get(nameKey);
    if (existing != null) {
      // 同一行业同时出现在东财/申万二级/三级目录时只留一个；优先更细的
      // 三级分类，避免 UI 出现“动物保健Ⅱ / 动物保健Ⅲ”这类重复领域。
      if (level > levels[existing]) {
        codes.delete(String(rows[existing].code).trim().toUpperCase());
        rows[existing] = row; levels[existing] = level; codes.add(codeKey);
      }
      continue;
    }
    codes.add(codeKey); names.set(nameKey, rows.length); levels.push(level); rows.push(row);
  }
  return rows;
}

function normalizedIndustryName(value) {
  return String(value || "").normalize("NFKC")
    .replace(/[ⅠⅡⅢⅣ一二三]/g, "")
    .replace(/申万|行业/g, "")
    .replace(/[\s·・()（）-]/g, "")
    .trim();
}

/** 将个股行情中的行业名稳定映射到行业板块；供深度分析和综合研报共用。 */
export function matchIndustryBoard(industry, list = []) {
  const target = normalizedIndustryName(industry);
  if (!target || !Array.isArray(list)) return null;
  let best = null;
  let bestScore = -1;
  for (const row of list) {
    const name = normalizedIndustryName(row?.name);
    if (!name) continue;
    let score = -1;
    if (name === target) score = 10000;
    else if (name.startsWith(target)) score = 9000 - (name.length - target.length);
    else if (target.startsWith(name)) score = 8000 - (target.length - name.length);
    else if (name.includes(target)) score = 7000 - (name.length - target.length);
    else if (target.includes(name)) score = 6000 - (target.length - name.length);
    else {
      let common = 0;
      while (common < name.length && common < target.length && name[common] === target[common]) common++;
      if (common >= 2) score = 1000 + common * 10 - Math.abs(name.length - target.length);
    }
    if (score > bestScore) { best = row; bestScore = score; }
  }
  return best;
}

/** 行业板块目录；实时字段由 emBoardQuote 单独刷新。 */
function readBoardDirectoryCache() {
  if (boardDirectoryCache) return boardDirectoryCache;
  for (const [path, primary] of [[BOARD_DIRECTORY_PATH, true], [LEGACY_BOARDS_CACHE_PATH, false]]) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      const source = primary ? saved?.rows : (Array.isArray(saved?.eastmoney) ? saved.eastmoney : saved?.boards);
      const rows = dedupeIndustryBoards(source);
      if (rows.length) {
        // 旧选股缓存只在断网时兜底，不继承时间戳，避免被选股模块永久续期。
        boardDirectoryCache = { rows, cachedAt: primary ? num(saved.cachedAt, 0) : 0 };
        return boardDirectoryCache;
      }
    } catch {}
  }
  return { rows: [], cachedAt: 0 };
}

function writeBoardDirectoryCache(rows) {
  boardDirectoryCache = { rows, cachedAt: Date.now() };
  try {
    mkdirSync(dirname(BOARD_DIRECTORY_PATH), { recursive: true });
    writeFileSync(BOARD_DIRECTORY_PATH, JSON.stringify({ version: 1, cachedAt: Date.now(), rows }, null, 2), "utf8");
  } catch {}
}

export async function emBoardList({ force = false } = {}) {
  const cached = readBoardDirectoryCache();
  if (!force && cached.rows.length && Date.now() - cached.cachedAt < BOARD_DIRECTORY_TTL) return cached.rows;
  if (!force && Date.now() < boardDirectoryRetryAt) return cached.rows;
  if (boardDirectoryInflight) return boardDirectoryInflight;
  boardDirectoryInflight = (async () => {
    const out = [];
    for (let pn = 1; pn <= 5; pn++) {
      // Use the immutable board code as the page sort key. Sorting by live change
      // percentage lets rows move between pages while they are being fetched,
      // which previously produced duplicate options and omitted other boards.
      const j = await getJson(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:90+t:2&fields=f3,f12,f14,f20,f62,f104,f105,f106`).catch(() => null);
      const diff = j?.data?.diff;
      if (!Array.isArray(diff) || diff.length === 0) break;
      out.push(...diff);
      if (diff.length < 100) break;
    }
    const rows = dedupeIndustryBoards(out.map(parseBoardListRow).filter(Boolean));
    if (rows.length) {
      boardDirectoryRetryAt = 0;
      writeBoardDirectoryCache(rows);
      return rows;
    }
    // 过期目录仍比关联完全丢失更有价值；实时字段会单独刷新。
    boardDirectoryRetryAt = Date.now() + 5 * 60 * 1000;
    return cached.rows;
  })().finally(() => { boardDirectoryInflight = null; });
  return boardDirectoryInflight;
}

/** 解析行业板块列表行。count 仅在涨/跌/平家数齐全时生成，避免 UI 出现 undefined。 */
export function parseBoardListRow(d) {
  if (!d || !d.f12 || !d.f14) return null;
  const up = num(d.f104, null), down = num(d.f105, null), flat = num(d.f106, null);
  return {
    code: String(d.f12),
    name: String(d.f14),
    changePct: num(d.f3, null),
    mcap: num(d.f20, null),
    mainFlow: num(d.f62, null),
    upCount: up,
    downCount: down,
    flatCount: flat,
    count: [up, down, flat].every((x) => Number.isFinite(x)) ? up + down + flat : undefined,
  };
}

/** 单个行业板块的实时行情，避免为一只股票刷新整个目录。 */
export async function emBoardQuote(boardCode) {
  const code = String(boardCode || "").trim().toUpperCase();
  if (!/^BK\d{4}$/.test(code)) return null;
  const j = await getJson(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=90.${code}&fields=f2,f3,f12,f14,f20,f62,f104,f105,f106`);
  const row = Array.isArray(j?.data?.diff) ? j.data.diff[0] : null;
  return parseBoardListRow(row);
}

/** 解析 fltt=2 板块成分股行；PE/PB/换手率已是格式化数值，不能再次 /100。 */
export function parseBoardConstRow(d) {
  if (!d) return null;
  return {
    code: d.f12,
    name: d.f14,
    price: num(d.f2),
    changePct: num(d.f3),
    turnover: num(d.f8),
    peDyn: num(d.f9),
    mcap: num(d.f20),
    pb: num(d.f23),
    peTtm: num(d.f115),
  };
}

/** 行业板块成分股（含估值，按市值降序）。
 * n <= 0 表示尽量拉取全部（安全上限 500）；大于 100 时自动翻页。
 */
export async function emBoardConst(boardCode, n = 40) {
  const requested = Number(n);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(500, Math.max(1, Math.floor(requested))) : 500;
  const pageSize = Math.min(100, limit);
  const out = [];
  for (let pn = 1; pn <= Math.ceil(limit / pageSize); pn++) {
    const remain = limit - out.length;
    if (remain <= 0) break;
    const pz = Math.min(pageSize, remain);
    const j = await getJson(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:${boardCode}&fields=f2,f3,f8,f9,f12,f14,f20,f23,f115,f162,f167`);
    const diff = j?.data?.diff || [];
    if (!Array.isArray(diff) || diff.length === 0) break;
    out.push(...diff.map(parseBoardConstRow).filter(Boolean));
    if (diff.length < pz) break;
  }
  return out.slice(0, limit);
}

/** 研报列表（近 2 年，最多 n 条） */
export async function emResearch(codeInput, n = 30) {
  const pc = parseCode(codeInput);
  if (!pc) return { rows: [], total: 0 };
  const url = `https://reportapi.eastmoney.com/report/list?cb=&industryCode=*&pageSize=${n}&industry=*&rating=*&ratingChange=*&beginTime=2024-01-01&endTime=2030-12-31&pageNo=1&fields=&qType=0&orgCode=&rcode=&code=${pc.code}&p=1&pageNum=1&_=1`;
  const j = await getJson(url);
  const rows = (j?.data || []).map((r) => ({
    title: r.title,
    org: r.orgSName,
    publishDate: String(r.publishDate || "").slice(0, 10),
    emRating: r.emRatingName,
    sRating: r.sRatingName,
    predictThisYearEps: num(r.predictThisYearEps),
    predictNextYearEps: num(r.predictNextYearEps),
    predictNextTwoYearEps: num(r.predictNextTwoYearEps),
    aimPriceT: num(r.indvAimPriceT),
    aimPriceL: num(r.indvAimPriceL),
    industry: r.indvInduName,
  }));
  return { rows, total: num(j?.hits ?? j?.count) };
}

/** 按证券代码精确解析法定披露公告；额外校验响应中的证券代码。 */
export function parseAnnouncementList(json, codeInput, n = 40) {
  const pc = parseCode(codeInput);
  if (!pc) return { rows: [], total: 0 };
  const limit = Math.min(100, Math.max(1, Math.floor(Number(n) || 40)));
  const seen = new Set(), rows = [];
  for (const r of Array.isArray(json?.data?.list) ? json.data.list : []) {
    const artCode = String(r?.art_code || "").trim();
    const title = String(r?.title_ch || r?.title || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const belongsToStock = !Array.isArray(r?.codes) || !r.codes.length || r.codes.some((x) => String(x?.stock_code || "") === pc.code);
    const key = artCode || title;
    if (!belongsToStock || !key || !title || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      artCode, title,
      noticeDate: String(r?.notice_date || r?.display_time || "").slice(0, 10),
      columns: (Array.isArray(r?.columns) ? r.columns : []).map((x) => String(x?.column_name || "").trim()).filter(Boolean),
      url: artCode ? `https://data.eastmoney.com/notices/detail/${pc.code}/${artCode}.html` : "",
      source: "上市公司公告",
    });
  }
  return { rows: rows.slice(0, limit), total: num(json?.data?.total_hits, rows.length) };
}

/** 按证券代码精确获取法定披露公告；比开放网页搜索更完整且不会串入同名词条。 */
export async function emAnnouncements(codeInput, n = 40) {
  const pc = parseCode(codeInput);
  if (!pc) return { rows: [], total: 0 };
  const limit = Math.min(100, Math.max(1, Math.floor(Number(n) || 40)));
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${pc.code}`;
  return parseAnnouncementList(await getJson(url, 15000), pc.code, limit);
}

/** 分红送配历史（除权日降序） */
export async function emDividends(codeInput, n = 8) {
  const pc = parseCode(codeInput);
  if (!pc) return [];
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&quoteColumns=&filter=(SECURITY_CODE%3D%22${pc.code}%22)&pageNumber=1&pageSize=${n}&sortTypes=-1&sortColumns=EX_DIVIDEND_DATE&source=WEB&client=WEB`;
  const j = await getJson(url);
  return (j?.result?.data || []).map((r) => ({
    exDate: String(r.EX_DIVIDEND_DATE || "").slice(0, 10),
    plan: r.IMPL_PLAN_PROFILE,
    pretaxBonusRmb: num(r.PRETAX_BONUS_RMB), // 每 10 股派息（元）
    reportDate: String(r.REPORT_DATE || "").slice(0, 10),
  }));
}

/** 行业板块指数日 K（用于行业景气度：近 250/60 日涨幅） */
export async function emBoardKline(boardCode, bars = 300) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.${boardCode}&klt=101&fqt=1&lmt=${bars}&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56`;
  const j = await getJson(url);
  const klines = j?.data?.klines || [];
  return klines.map((line) => {
    const p = String(line).split(",");
    return { date: p[0], open: num(p[1]), close: num(p[2]), high: num(p[3]), low: num(p[4]), volume: num(p[5]) };
  });
}

/** 兼容旧调用：日 K 已统一进入 Data Provider Hub，不再固定访问腾讯。 */
export async function tencentKline(codeInput, count = 750) {
  const r = await dataHub.getKline(codeInput, "day", count);
  return r.candles || [];
}

/** 解析资金流日线字符串。fields2: f51=date,f52..f56=净额,f57..f61=占比,f62=收盘价,f63=涨跌幅。 */
export function parseCapitalFlowLine(line) {
  const parts = String(line || "").split(",");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) return null;
  return {
    date: parts[0],
    mainNet: num(parts[1], null),
    smallNet: num(parts[2], null),
    midNet: num(parts[3], null),
    largeNet: num(parts[4], null),
    superNet: num(parts[5], null),
    mainPct: num(parts[6], null),
    price: num(parts[11], null),
    changePct: num(parts[12], null),
  };
}

/** 主力资金流（日线，近 n 日） */
export async function emCapitalFlow(codeInput, n = 10) {
  const pc = parseCode(codeInput);
  if (!pc) return [];
  n = Math.max(1, Math.min(120, Math.trunc(Number(n)) || 10));
  const j = await getJson(`https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=${n}&klt=101&secid=${pc.secid}&ut=b2884a393a59ad64002292a3e90d46a5&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`);
  const klines = j?.data?.klines || [];
  return klines.slice(-n).map(parseCapitalFlowLine).filter(Boolean);
}
