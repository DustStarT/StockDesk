/**
 * company-search.js — 免费网页搜索（Bing 为主，百度兜底）
 * 用途：企业公告 / 公司新闻 / 外部研究
 * DuckDuckGo 在本机不可达（已实测），故用 cn.bing.com + baidu.com。
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const stripTags = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();

/** 从 Bing HTML 解析结果：[{title, url, body}] */
function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const a = h2[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const body = stripTags(p ? p[1] : "");
    out.push({ title: stripTags(a[2]).slice(0, 100), url: a[1].slice(0, 300), body: body.slice(0, 240) });
    if (out.length >= 6) break;
  }
  return out;
}

/** 从百度 HTML 解析结果（宽松解析） */
function parseBaidu(html) {
  const out = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*c-container[^"]*"[^>]*>/);
  for (const block of blocks.slice(1)) {
    const h3 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const a = h3 ? h3[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) : null;
    const title = a ? stripTags(a[2]) : stripTags(h3 ? h3[1] : "").slice(0, 60);
    const body = stripTags(block).slice(0, 240);
    if (!title || body.length < 8) continue;
    out.push({ title: title.slice(0, 100), url: a ? a[1].slice(0, 300) : "", body });
    if (out.length >= 6) break;
  }
  return out;
}

let lastCall = 0;
const MIN_INTERVAL = 700; // 限速：两次搜索间隔 ≥ 700ms（避免被封）
const searchCache = new Map();
const searchInflight = new Map();
let searchStartChain = Promise.resolve();

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, timeoutMs)), headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", "Accept": "text/html,application/xhtml+xml" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function reserveSearchStart(deadlineAt) {
  const scheduled = searchStartChain.catch(() => {}).then(async () => {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (Date.now() >= deadlineAt) return false;
    lastCall = Date.now();
    return true;
  });
  searchStartChain = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

/**
 * 搜索一次，返回 [{title, url, body}]（失败 → []）。
 * 优先级：cn.bing.com → www.bing.com → www.baidu.com
 */
export async function search(query, maxResults = 5, options = {}) {
  const key = `${query}:${maxResults}`;
  const hit = searchCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.rows;
  if (searchInflight.has(key)) return searchInflight.get(key);
  const deadlineAt = Number(options.deadlineAt) || Date.now() + 7000;
  const task = (async () => {
  if (!await reserveSearchStart(deadlineAt)) return [];
  const q = encodeURIComponent(query);
  const engines = [
    ["bing-cn", `https://cn.bing.com/search?q=${q}&count=10`, parseBing],
    ["bing", `https://www.bing.com/search?q=${q}&count=10`, parseBing],
    ["baidu", `https://www.baidu.com/s?wd=${q}&rn=10`, parseBaidu],
  ];
  for (const [name, url, parser] of engines) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 250) break;
    try {
      const html = await fetchText(url, Math.min(4000, remaining));
      if (!html || html.length < 3000) continue;
      const results = parser(html);
      if (results.length > 0) {
        const rows = results.slice(0, maxResults);
        searchCache.set(key, { expiresAt: Date.now() + 10 * 60 * 1000, rows });
        while (searchCache.size > 160) searchCache.delete(searchCache.keys().next().value);
        return rows;
      }
    } catch {
      /* 换下一个引擎 */
    }
  }
  searchCache.set(key, { expiresAt: Date.now() + 2 * 60 * 1000, rows: [] });
  return [];
  })().finally(() => searchInflight.delete(key));
  searchInflight.set(key, task);
  return task;
}

/**
 * 多查询聚合：把多组查询的结果合并为 { text, snippets }
 * 用于情绪/护城河/杀猪盘的多关键词扫描。
 */
export async function searchBlob(queries, maxPerQuery = 3, options = {}) {
  const snippets = [];
  const texts = [];
  const deadlineAt = Number(options.deadlineAt) || Date.now() + 8000;
  for (const q of queries) {
    if (Date.now() >= deadlineAt) break;
    try {
      const results = await search(q, maxPerQuery, { deadlineAt });
      for (const r of results) {
        snippets.push({ title: r.title.slice(0, 80), body: r.body.slice(0, 200), url: r.url });
        texts.push(r.title + " " + r.body);
      }
    } catch {
      /* 单查询失败不影响整体 */
    }
  }
  return { text: texts.join(" ").toLowerCase(), snippets };
}
