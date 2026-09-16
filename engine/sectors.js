// 可选数据源：选股用的行业板块列表 / 成分股。
//  - eastmoney（东财，默认）：全行业 496 + 板块指数 K 线（景气度）
//  - sina（新浪，备选）：行业约 90 + 成分接口（无板块 K 线，景气度置 0）
// 个股行情 / K 线 / 信号由 data-provider-hub 统一调度；行业列表仍在东财/新浪之间按启用状态回退。
import { emBoardConst, emBoardKline, emBoardList } from "./market-fetchers.js";
import * as dataHub from "./data-provider-hub.js";

/** 可选数据源清单（给设置 UI 用），id 对应下方函数与客户端） */
export const DATA_SOURCES = [
  { id: "eastmoney", label: "东财（全行业 496）", boards: true, constituents: true, momentum: true },
  { id: "sina", label: "新浪（行业 ~90）", boards: true, constituents: true, momentum: false },
];

const SINA_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Referer: "https://finance.sina.com.cn/",
};

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function sinaFetch(url, timeoutMs = 12000) {
  if (!dataHub.isProviderEnabled("sina")) throw new Error("新浪数据源已在设置中关闭");
  return dataHub.providerRequest("sina", url, { headers: SINA_HEADERS, responseType: "text" }, { capability: "aux", timeoutMs });
}

// ---------------------------------------------------------------------------
// 东财
// ---------------------------------------------------------------------------
export async function emIndustries() {
  return emBoardList();
}

export async function emBoardConstSource(boardCode, n = 80) {
  return emBoardConst(boardCode, n);
}

export async function emBoardKlineSource(boardCode, bars = 300) {
  return emBoardKline(boardCode, bars);
}

// ---------------------------------------------------------------------------
// 新浪
// ---------------------------------------------------------------------------
/**
 * 新浪行业板块列表：解析 newSinaHy.php 的
 * S_Finance_bankuai_sinaindustry（代码 → "代码,名称,家数,..."）。
 */
export async function sinaIndustries() {
  if (!dataHub.isProviderEnabled("sina")) throw new Error("新浪数据源已在设置中关闭");
  const raw = await dataHub.providerRequest("sina", "https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php", {
    headers: SINA_HEADERS, responseType: "arrayBuffer"
  }, { capability: "aux", timeoutMs: 12000 });
  // newSinaHy.php 是 GBK 页面，须显式解码。
  const text = new TextDecoder("gbk").decode(raw);
  const m = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error("新浪行业表解析失败（无匹配）");
  let obj;
  try {
    obj = JSON.parse(m[1]);
  } catch {
    throw new Error("新浪行业表 JSON 解析失败");
  }
  return Object.entries(obj)
    .map(([code, row]) => {
      const parts = String(row).split(",");
      return { code, name: (parts[1] || "").trim(), count: num(parts[2]) || 0 };
    })
    .filter((x) => x.name);
}

/**
 * 新浪行业成分股（富字段版 getHQNodeData）：PE/PB/市值/换手，翻页取全。
 * 字段统一到与东财一致（mcap 元；turnover 使用百分数值，3.3=3.3%；peTtm 取原值）。
 */
export async function sinaBoardConst(nodeCode, n = 240) {
  const pageSize = 80;
  const rows = [];
  for (let page = 1; page * pageSize < n + pageSize; page++) {
    const url =
      "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/" +
      `Market_Center.getHQNodeData?page=${page}&num=${pageSize}&sort=changepercent&asc=0&node=${encodeURIComponent(nodeCode)}`;
    const text = await sinaFetch(url);
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      break;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const r of arr) {
      rows.push({
        code: String(r.code ?? ""),
        name: String(r.name ?? ""),
        price: num(r.trade),
        changePct: num(r.changepercent),
        turnover: num(r.turnoverratio),
        peTtm: num(r.per),
        pb: num(r.pb),
        mcap: num(r.mktcap) != null ? num(r.mktcap) * 1e4 : null, // 万元 → 元
      });
    }
    if (arr.length < pageSize) break;
  }
  return rows.filter((r) => r.code && r.name);
}
