/**
 * StockDesk 渲染进程主逻辑
 * 状态管理 + 面板渲染 + 用户交互，图表由 chart.js 负责。
 */
import { ChartRenderer } from "./chart.js";
import { IndicatorPaneManager } from "./indicator-chart.js";
import { initLayout } from "./layout.js";

const api = window.stockdesk;
const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "--");

// ================= 全局状态 =================
const state = {
  watchlist: { groups: [] },
  settings: { pollMs: 5000, alerts: true, priceAlerts: true, strategyAlerts: true, monitorEnabled: true, monitorPollMs: 15000, monitorCooldownMin: 30, monitorOnlyMarketHours: true, theme: "dark", closeToTray: true, pauseWhenHidden: true },
  quotes: [],           // 最新行情行
  activeCode: null,     // 当前选中股票
  activeGroup: 0,
  chartMode: "day",     // day|week|month|minute
  panel: "signal",      // signal|screen|strategy|report
  screenBoards: [],
  screenResult: null,
  screenSource: null,
  screenBoardCode: null,
  screenBoardQuery: "",
  screenResultQuery: "",
  screenMethod: "hybrid",
  screenMaxResults: 0,       // 0 = 全部（后端安全上限 500）
  screenPage: 1,
  screenPageSize: 20,
  strategyResult: null,
  strategyMode: "smart",
  strategyProfile: "balanced",
  strategyPreset: "trend_breakout",
  strategyPresets: [],
  localAi: null,
  localAiHistory: [],
  localAiEvent: null,
  monitorState: { items: [], unreadCount: 0, activeCount: 0 },
  alertHistory: [],
  positionCode: null,
  marketRegime: null,
  indicatorCatalog: [],
  indicatorLayout: 1,
  indicatorIds: ["MACD", "RSI", "VOL"],
  indicatorParamMap: {},
  researchResult: null,
  reportTab: "overview",
  aiReport: null,
  aiArchive: null,
  aiHistory: [],
  aiEstimate: null,
  llmState: null,
  searchRows: [],
  dataSourceState: null,
  addPick: null,        // 添加弹窗选中的股票
};

// ================= 工具 =================
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const pctCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
function normalizeUiCode(value){
  const raw=String(value||"").trim().toLowerCase();
  const prefixed=raw.match(/^(sh|sz|bj)(\d{6})$/),digits=raw.match(/^\d{6}$/);
  if(!prefixed&&!digits)return null;
  const code=prefixed?.[2]||digits[0];
  let market=prefixed?.[1]||(/^(92|8|4)/.test(code)?"bj":/^(60|68|51|50|90)/.test(code)?"sh":"sz");
  if(/^92/.test(code))market="bj";
  return market+code;
}
function toast(type, message) {
  let stack = $(".toast-stack");
  if (!stack) { stack = document.createElement("div"); stack.className = "toast-stack"; document.body.appendChild(stack); }
  const el = document.createElement("div");
  el.className = "toast " + (type || "");
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ================= 侧栏 =================
function renderGroupTabs() {
  const el = $("#group-tabs");
  el.innerHTML = "";
  state.watchlist.groups.forEach((g, i) => {
    const wrap = document.createElement("div");
    wrap.className = "group-tab-wrap" + (i === state.activeGroup ? " active" : "");
    const b = document.createElement("button");
    b.className = "group-tab" + (i === state.activeGroup ? " active" : "");
    b.textContent = g.name;
    b.onclick = () => { state.activeGroup = i; renderGroupTabs(); renderWatchList(); };
    const del = document.createElement("button");
    del.className = "group-tab-del";
    del.textContent = "×";
    del.title = state.watchlist.groups.length > 1 ? `删除分组“${g.name}”` : "至少保留一个分组";
    del.setAttribute("aria-label", del.title);
    del.disabled = state.watchlist.groups.length <= 1;
    del.onclick = (e) => { e.stopPropagation(); removeGroup(i); };
    wrap.append(b, del);
    el.appendChild(wrap);
  });
}

function removeGroup(index) {
  if (state.watchlist.groups.length <= 1) { toast("", "至少需要保留一个分组"); return; }
  const group = state.watchlist.groups[index];
  if (!group || !window.confirm(`确定删除分组“${group.name}”吗？\n分组内的自选股也会从该分组移除。`)) return;
  state.watchlist.groups.splice(index, 1);
  if (state.activeGroup > index) state.activeGroup--;
  else if (state.activeGroup === index) state.activeGroup = Math.min(index, state.watchlist.groups.length - 1);
  const activeStillExists = allSymbols().some((s) => s.code === state.activeCode);
  api.setWatchlist(state.watchlist.groups);
  renderGroupTabs();
  if (!activeStillExists) {
    const nextCode = state.watchlist.groups[state.activeGroup]?.symbols?.[0]?.code || null;
    if (nextCode) selectStock(nextCode);
    else { state.activeCode = null; renderWatchList(); renderDetail(); loadChart(); loadSignal(); }
  } else renderWatchList();
  api.pollNow();
}

function renderWatchList() {
  const el = $("#watch-list");
  el.innerHTML = "";
  const group = state.watchlist.groups[state.activeGroup];
  if (!group || !group.symbols.length) {
    el.innerHTML = '<div class="empty-tip">点击左上角 ＋ 添加股票</div>';
    return;
  }
  for (const sym of group.symbols) {
    const row = state.quotes.find((q) => q.code === sym.code);
    const div = document.createElement("div");
    div.className = "watch-item" + (sym.code === state.activeCode ? " active" : "");
    const price = row && row.live ? row.price : null;
    const chg = row && row.live ? row.changePercent : null;
    const badge = row && row.trigger && row.trigger !== "none"
      ? (row.trigger === "buy" ? ["B", "down"] : ["S", "up"])
      : null;
    div.innerHTML = `
      <div class="watch-item-top">
        <span class="watch-item-name">${esc(row && row.live ? row.name : sym.name || sym.code)}</span>
        <span class="watch-item-code">${esc(sym.code)}</span>
        <span class="watch-item-price ${cls(chg)}">${price != null ? price.toFixed(2) : "--"}</span>
      </div>
      <div class="watch-item-bottom">
        <span class="watch-item-chg ${cls(chg)}">${chg != null ? (chg > 0 ? "+" : "") + chg.toFixed(2) + "%" : "—"}</span>
        ${sym.buyPrice ? `<span class="watch-item-badge down">买${sym.buyPrice}</span>` : ""}
        ${sym.sellPrice ? `<span class="watch-item-badge up">卖${sym.sellPrice}</span>` : ""}
        ${currentMonitor(sym.code)?.enabled!==false && currentMonitor(sym.code) ? `<span class="watch-item-badge">🔔</span>` : ""}
        ${badge ? `<span class="watch-item-badge ${badge[1]}">${badge[0]}</span>` : ""}
        ${row?.provider ? `<span class="quote-source-tag ${row?.stale?"stale":""}">${esc(({tencent:"腾讯",eastmoney:"东财",sina:"新浪"})[row.provider]||row.provider)}${row?.stale?"·缓存":""}</span>` : ""}
        <span class="watch-item-del" title="删除">×</span>
      </div>`;
    div.onclick = () => selectStock(sym.code);
    div.querySelector(".watch-item-del").onclick = (e) => {
      e.stopPropagation();
      group.symbols = group.symbols.filter((s) => s.code !== sym.code);
      api.setWatchlist(state.watchlist.groups);
      if (state.activeCode === sym.code) { state.activeCode = null; renderDetail(); }
      renderWatchList();
    };
    el.appendChild(div);
  }
}

function selectStock(code) {
  state.activeCode = code;
  api.setSettings({ lastCode: code });
  state.strategyResult = null;
  state.researchResult = null; state.aiReport = null; state.aiArchive = null; state.aiHistory = []; state.aiEstimate = null;
  renderWatchList();
  renderDetail();
  loadChart();
  loadSignal();
  // Every stock-specific panel must replace the previous stock immediately.
  // Each async renderer owns a request token, so a slower old response cannot
  // overwrite the newly selected stock.
  if (state.panel === "strategy") renderStrategy();
  else if (state.panel === "report") renderReport();
}

// ================= 详情头 =================
function renderDetail() {
  if (!state.activeCode) {
    $("#detail-name").textContent = "—";
    $("#detail-code").textContent = "";
    $("#detail-price").textContent = "--";
    $("#detail-price").className = "stock-price";
    $("#detail-chg").textContent = "--";
    $("#detail-chg").className = "stock-chg";
    const t = $("#detail-trigger");
    t.textContent = "";
    t.className = "stock-trigger";
    return;
  }
  const sym = allSymbols().find((s) => s.code === state.activeCode);
  const row = state.quotes.find((q) => q.code === state.activeCode);
  $("#detail-code").textContent = state.activeCode;
  if (row && row.live) {
    $("#detail-name").textContent = row.name;
    $("#detail-price").textContent = row.price.toFixed(2);
    $("#detail-price").className = "stock-price " + cls(row.changePercent);
    $("#detail-chg").textContent = (row.changePercent > 0 ? "+" : "") + row.changePercent.toFixed(2) + "%  " + (row.changeAmount > 0 ? "+" : "") + row.changeAmount.toFixed(2);
    $("#detail-chg").className = "stock-chg " + cls(row.changePercent);
    const t = $("#detail-trigger");
    const map = { none: "", buy: "买点触发", sell: "卖点触发", wait: "等待触发" };
    t.textContent = map[row.trigger] || "";
    t.className = "stock-trigger " + row.trigger;
  } else {
    $("#detail-name").textContent = sym ? (sym.name || sym.code) : state.activeCode;
    $("#detail-price").textContent = "--";
    $("#detail-chg").textContent = "无数据";
  }
}

function allSymbols() {
  const seen = new Set(), out = [];
  for (const g of state.watchlist.groups) for (const s of g.symbols) {
    if (seen.has(s.code)) continue;
    seen.add(s.code); out.push(s);
  }
  return out;
}

// ================= 图表 =================
const chart = new ChartRenderer($("#chart"));
const indicatorPanes = new IndicatorPaneManager($("#indicator-grid"));
initLayout();
chart.onRange = (times, kind) => { if (kind === 'kline') indicatorPanes.setRange(times); };
let resizeFrame;
const chartObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { chart.resize(); indicatorPanes.resize(); });
});
chartObserver.observe($("#main-chart-wrap"));
chartObserver.observe($("#indicator-grid"));
for (const [label, title, action] of [['＋','放大走势',()=>chart.zoom(.8)],['−','缩小走势',()=>chart.zoom(1.25)],['复位','恢复范围（也可双击图表）',()=>chart.resetView()]]) {
  const button = document.createElement('button');
  button.className = 'mini-btn'; button.textContent = label; button.title = title; button.onclick = action;
  let controls = document.querySelector('.chart-view-controls');
  if (!controls) { controls = document.createElement('div'); controls.className='chart-view-controls'; $("#chart-tabs").after(controls); }
  controls.append(button);
}
document.querySelector('.chart-view-controls').append(Object.assign(document.createElement('span'), {textContent:'滚轮缩放 · 拖动平移'}));
let chartLoadToken = 0;
let chartIdentity = '';
let chartPendingIdentity = '';

async function loadChart() {
  const code = state.activeCode;
  const mode = state.chartMode;
  if (chartPendingIdentity === `${code}:${mode}`) return;
  const token = ++chartLoadToken;
  const identity = `${code}:${mode}`;
  chartPendingIdentity = identity;
  if (identity !== chartIdentity) { chart.clear(); indicatorPanes.clear(); chartIdentity = identity; }
  if (!code) { chartPendingIdentity = ''; chart.clear(); indicatorPanes.clear(); $("#chart-empty").textContent = '选择一只股票查看走势'; $("#chart-empty").hidden = false; return; }
  $("#chart-empty").hidden = true;
  try {
  if (mode === "minute") {
    const m = await api.getMinute(code);
    if (token !== chartLoadToken || code !== state.activeCode || mode !== state.chartMode) return;
    if (!m.points?.length) throw new Error(m.error || '暂无分时数据');
    chart.setMinute(m.points, m.prevClose);
    indicatorPanes.clear();
    $("#indicator-grid").style.display = "none";
    $("#chart-stack").dataset.layout = "0";
    $("#indicator-note").textContent = "分时模式暂不计算日线技术副图";
  } else {
    const k = await api.getKline(code, mode);
    if (token !== chartLoadToken || code !== state.activeCode || mode !== state.chartMode) return;
    if (!k.candles.length) { chart.clear(); indicatorPanes.clear(); return; }
    chart.setKline(k.candles, mode);
    $("#indicator-note").textContent = "指标按当前K线周期计算";
    await loadIndicators();
  }
  } catch (error) {
    if (token !== chartLoadToken || code !== state.activeCode) return;
    $("#chart-empty").textContent = `加载失败：${error.message || error}，可切换周期重试`;
    $("#chart-empty").hidden = false;
  } finally {
    if (token === chartLoadToken) chartPendingIdentity = '';
  }
}

let indicatorLoadToken = 0;
async function loadIndicators() {
  const token = ++indicatorLoadToken, code = state.activeCode, mode = state.chartMode;
  const layout = Math.max(0, Math.min(3, Number(state.indicatorLayout) || 0));
  const grid = $("#indicator-grid"), stack = $("#chart-stack");
  stack.dataset.layout = String(layout);
  if (!state.activeCode || state.chartMode === "minute" || layout === 0) {
    grid.style.display = "none"; indicatorPanes.clear(); chart.resize(); return;
  }
  grid.style.display = "grid";
  grid.style.gridTemplateRows = `repeat(${layout}, minmax(0, 1fr))`;
  const ids = state.indicatorIds.slice(0, layout);
  const r = await api.getIndicators(state.activeCode, state.chartMode, ids);
  if (token !== indicatorLoadToken || code !== state.activeCode || mode !== state.chartMode) return;
  indicatorPanes.setRange(chart.data?.visible?.map(x => x.time) || []);
  indicatorPanes.setData(r.times || [], r.rows || []);
  requestAnimationFrame(() => { chart.resize(); indicatorPanes.resize(); });
}

async function initIndicatorUi() {
  const r = await api.getIndicatorCatalog();
  state.indicatorCatalog = r.rows || [];
  state.indicatorParamMap = Object.fromEntries(state.indicatorCatalog.map((x) => [x.id, { ...(x.currentParams || x.defaultParams || {}) }]));
  const selects = [$("#indicator-a"), $("#indicator-b"), $("#indicator-c")];
  selects.forEach((sel, idx) => {
    sel.innerHTML = state.indicatorCatalog.map((x) => `<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.name.replace(/^\w+\s*/, ""))}</option>`).join("");
    sel.value = state.indicatorIds[idx] || ["MACD", "RSI", "VOL"][idx];
    sel.onchange = () => { state.indicatorIds[idx] = sel.value; loadIndicators(); };
  });
  $("#indicator-layout").value = String(state.indicatorLayout);
  $("#indicator-layout").onchange = (e) => {
    state.indicatorLayout = Number(e.target.value) || 0;
    $(".slot-b").hidden = state.indicatorLayout < 2;
    $(".slot-c").hidden = state.indicatorLayout < 3;
    loadIndicators();
  };
  $(".slot-b").hidden = state.indicatorLayout < 2;
  $(".slot-c").hidden = state.indicatorLayout < 3;
}


function indicatorMeta(id) { return state.indicatorCatalog.find((x) => x.id === String(id || "").toUpperCase()); }
function renderIndicatorParamForm() {
  const id = $("#indicator-param-id").value; const meta = indicatorMeta(id); if (!meta) return;
  $("#indicator-param-group").textContent = `${meta.group || ""} · ${meta.name || id}`;
  const cur = state.indicatorParamMap[id] || meta.currentParams || meta.defaultParams || {};
  $("#indicator-param-form").innerHTML = (meta.params || []).map((p) => `<label><span>${esc(p.label)} <small>${esc(p.key)}</small></span><input data-ind-param="${esc(p.key)}" type="number" min="${p.min}" max="${p.max}" step="${p.step || 1}" value="${cur[p.key] ?? p.default}"><em>默认 ${p.default} · 范围 ${p.min}–${p.max}</em></label>`).join("") || '<div class="note">该指标没有可配置参数。</div>';
}
async function openIndicatorParamModal() {
  if (!state.indicatorCatalog.length) await initIndicatorUi();
  const modal=$("#indicator-param-modal"), sel=$("#indicator-param-id");
  sel.innerHTML=state.indicatorCatalog.map((x)=>`<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.name.replace(/^\w+\s*/,""))}</option>`).join("");
  sel.value=state.indicatorIds[0] || state.indicatorCatalog[0]?.id || "MACD";
  sel.onchange=renderIndicatorParamForm; renderIndicatorParamForm(); modal.hidden=false;
}
function readIndicatorParamForm() {
  const out={}; $("#indicator-param-form").querySelectorAll("[data-ind-param]").forEach((el)=>{ out[el.dataset.indParam]=Number(el.value); }); return out;
}
async function saveIndicatorParams() {
  const id=$("#indicator-param-id").value; const r=await api.setIndicatorParams(id,readIndicatorParamForm());
  if(r?.error){toast("error",r.error);return;} state.indicatorParamMap[id]={...(r.params||{})};
  const meta=indicatorMeta(id); if(meta) meta.currentParams={...(r.params||{})};
  state.researchResult=null; state.aiEstimate=null; state.strategyResult=null;
  await loadIndicators(); if(state.activeCode) await loadSignal();
  toast("success",`${id} 参数已保存并用于综合分析`);
}
async function resetIndicatorParams(all=false) {
  const id=all?null:$("#indicator-param-id").value; const r=await api.resetIndicatorParams(id);
  if(r?.error){toast("error",r.error);return;} state.indicatorCatalog=r.rows||state.indicatorCatalog; state.indicatorParamMap=Object.fromEntries(state.indicatorCatalog.map((x)=>[x.id,{...(x.currentParams||x.defaultParams||{})}]));
  renderIndicatorParamForm(); state.researchResult=null; state.aiEstimate=null;
  await loadIndicators(); if(state.activeCode) await loadSignal(); toast("success",all?"全部技术指标已恢复默认参数":`${id} 已恢复默认参数`);
}

// ================= 信号面板 =================
let signalLoadToken = 0;
let signalRefreshAt = 0;
let signalPendingCode = null;
async function loadSignal(force = false, quiet = false) {
  const strip = $("#signal-strip");
  const body = $("#panel-body");
  const code = state.activeCode;
  if (quiet && signalPendingCode === code) return;
  const token = ++signalLoadToken;
  signalPendingCode = code;
  signalRefreshAt = Date.now();
  if (!code) {
    strip.innerHTML = ""; if (state.panel === "signal") body.innerHTML = '<div class="empty-tip">在左侧选择一只股票</div>';
    return;
  }
  if (!quiet && state.panel === "signal") body.innerHTML = '<div class="loading">⏳ 计算因子信号与历史验证…</div>';
  try {
    const sig = await api.getSignal(code, force);
    if (token !== signalLoadToken || code !== state.activeCode) return;
    renderSignalStrip(sig);
    updateConnectionStatus();
    if (state.panel === "signal") renderSignalPanel(sig);
  } catch (e) {
    if (token !== signalLoadToken || code !== state.activeCode) return;
    strip.innerHTML = "";
    const message = e?.message || "信号计算失败";
    if (state.panel === "signal") body.innerHTML = `<div class="error-box">信号计算失败：${esc(message)}</div>`;
  } finally {
    if (token === signalLoadToken) signalPendingCode = null;
  }
}

function renderSignalStrip(sig) {
  const strip = $("#signal-strip");
  const d = sig.daily;
  if (!d) { strip.innerHTML = ""; return; }
  const vCls = d.verdict === "buy" ? "up" : d.verdict === "sell" ? "down" : "dim";
  const rel = d.reliability != null ? `${d.reliability}%` : "待积累";
  strip.innerHTML = `
    <span class="sig-chip">基础因子 <b class="${vCls}">${d.score}</b> <span class="${vCls}">${d.verdict === "buy" ? "偏多" : d.verdict === "sell" ? "偏空" : "观望"}</span></span>
    ${d.compositeScore!=null?`<span class="sig-chip">扩展技术综合 <b>${d.compositeScore>0?"+":""}${d.compositeScore}</b></span>`:""}
    <span class="sig-chip">数据完整度 <b>${d.dataQuality ?? d.confidence ?? "—"}%</b></span>
    <span class="sig-chip">历史可靠度 <b>${rel}</b></span>
    <span class="sig-chip">${esc(d.summary || "")}</span>
    ${sig.timing && sig.timing.hint ? `<span class="sig-chip">择时 <b>${esc(sig.timing.hint)}</b></span>` : ""}`;
}

function renderSignalPanel(sig) {
  const body = $("#panel-body");
  const d = sig.daily || { horizons: sig.horizons || [], verdict: "unknown" };
  const factors = d.factors || [];
  const horizonHtml = (d.horizons || []).map((h) => {
    const label = h.direction === "bullish" ? "偏多" : h.direction === "bearish" ? "偏空" : h.direction === "neutral" ? "中性" : "数据不足";
    const cls = h.direction === "bullish" ? "up" : h.direction === "bearish" ? "down" : "dim";
    return `<div class="card"><span class="card-title">${esc(h.label)}趋势 · ${esc(h.period)}</span><div class="kv-row"><span>独立周期评分</span><b class="${cls}">${label}${h.score == null ? "" : ` · ${h.score}`}</b></div>${h.returnPct == null ? "" : `<div class="kv-row"><span>${h.slow}日累计涨跌</span><b class="${pctCls(h.returnPct)}">${h.returnPct.toFixed(2)}%</b></div>`}<div class="note">${esc(h.reason)}</div></div>`;
  }).join("");
  const factorRows = factors.map((f) => {
    const isRisk = f.key === "risk" || f.directional === false;
    const score = Number(f.score) || 0;
    const clsName = isRisk ? (score >= 70 ? "up" : score <= 40 ? "down" : "dim") : (score >= 20 ? "up" : score <= -20 ? "down" : "dim");
    const text = isRisk ? `${score}/100` : `${score > 0 ? "+" : ""}${score}`;
    return `<div class="kv-row"><span>${esc(f.label)}</span><b class="${clsName}">${text}</b></div>`;
  }).join("");
  const items = (d.signals || []).map((x) => `
    <div class="kv-row"><span>${esc(x.label)} · ${esc(x.reason)}</span><b class="${x.type === "buy" ? "up" : x.type === "sell" ? "down" : "dim"}">${x.weight > 0 ? "+" : ""}${x.weight}</b></div>`).join("");

  const vr = sig.validation || {};
  const histRows = [1, 5, 20].map((h) => {
    const x = vr.horizons?.[h];
    if (!x) return "";
    return `<div class="kv-row"><span>${h}日后 · 样本${x.n}</span><b>${x.hitRate}% 胜率 / ${x.avgReturn >= 0 ? "+" : ""}${x.avgReturn.toFixed(2)}%均值</b></div>`;
  }).join("");
  const validationNote = vr.status === "ok"
    ? `相似信号 ${vr.sampleSize} 次 · 历史可靠度 ${vr.reliability ?? "—"}%（仅当前K线样本内）`
    : vr.status === "low_sample" ? `仅匹配 ${vr.sampleSize} 次，样本不足，暂不输出可靠度`
    : vr.status === "neutral" ? "当前为中性信号，不做方向胜率统计"
    : "历史K线不足，暂无法验证";

  const events = (sig.events || []).map((e) => `<div class="event-row event-${esc(e.level)}"><b>${esc(e.title)}</b><span>${esc(e.detail)}</span></div>`).join("");
  const adv=d.advancedIndicators;
  const advancedHtml=adv?`<div class="card"><span class="card-title">22类扩展指标 · 去重复聚合</span><div class="kv-row"><span>高级指标方向分</span><b>${adv.compositeScore>0?"+":""}${adv.compositeScore}</b></div><div class="kv-row"><span>过热/波动风险</span><b>${adv.risk}/100</b></div><div class="advanced-family-grid">${Object.values(adv.families||{}).filter(x=>x.count).map(x=>`<div><span>${esc(x.label)} · ${x.count}项</span><b class="${x.score>=20?"up":x.score<=-20?"down":"dim"}">${x.score>0?"+":""}${x.score}</b></div>`).join("")}</div><div class="note">${esc(adv.methodology||"")}</div>${(adv.strongest||[]).slice(0,5).map(x=>`<div class="note">• ${esc(x.id)} ${x.score>0?"+":""}${x.score} · ${esc(x.summary||x.state||"")}</div>`).join("")}</div>`:"";

  const m = state.marketRegime;
  const marketHtml = m ? `
    <div class="card">
      <span class="card-title">市场状态 · ${esc(m.label || "—")}</span>
      <div class="kv-row"><span>指数合成强度</span><b>${m.score ?? "—"}/100</b></div>
      <div class="kv-row"><span>市场风险</span><b>${m.risk ?? "—"}/100</b></div>
      <div class="kv-row"><span>多/空指数</span><b>${m.bullCount ?? 0} / ${m.bearCount ?? 0}</b></div>
      ${(m.strategy || []).slice(0, 2).map((x) => `<div class="note">• ${esc(x)}</div>`).join("")}
    </div>` : "";

  body.innerHTML = `
    <div class="panel-title">量化信号 · 多周期 <button class="mini-btn" id="sig-refresh">刷新</button></div>
    ${marketHtml}
    <div class="card">
      <span class="card-title">基础因子综合方向（非当日涨跌）</span>
      <div class="verdict-big ${d.verdict === "buy" ? "up" : d.verdict === "sell" ? "down" : ""}">${!sig.daily ? "数据不足（基础因子需30根日K）" : d.verdict === "buy" ? "🔴 偏多" : d.verdict === "sell" ? "🟢 偏空" : "🟡 中性"}</div>
      <div class="kv-row"><span>基础因子评分</span><b>${d.score ?? "—"}</b></div>${d.compositeScore!=null?`<div class="kv-row"><span>扩展融合参考分（不决定上方方向）</span><b>${d.compositeScore}</b></div>`:""}
      <div class="kv-row"><span>采集时当日涨跌（独立口径）</span><b class="${pctCls(sig.changePercent)}">${sig.changePercent == null ? "—" : `${Number(sig.changePercent).toFixed(2)}%`}</b></div>
      <div class="note">日K截至 ${esc(sig.asOf || "未知")} · 计算于 ${sig.calculatedAt ? esc(new Date(sig.calculatedAt).toLocaleTimeString("zh-CN", {hour12:false})) : "未知"}。当日日K可能尚未收盘；日K未包含今日时，趋势仅代表历史数据。</div>
      ${sig.dataWarning ? `<div class="note">⚠ ${esc(sig.dataWarning)}</div>` : ""}
      <div class="note">多空阈值统一为 ±25；风险仅降低强度。下方长中短期独立计算，不是未来涨跌预测。</div>
      <div class="kv-row"><span>数据完整度</span><b>${d.dataQuality ?? d.confidence ?? "—"}%</b></div>
      <div class="kv-row"><span>历史可靠度</span><b>${d.reliability != null ? d.reliability + "%" : "样本不足/待验证"}</b></div>
      <div class="note">${esc(d.summary || "")}</div>
    </div>
    ${horizonHtml}
    <div class="card">
      <span class="card-title">基础因子族（同源指标只投一票）</span>
      ${factorRows || '<div class="note">暂无因子数据</div>'}
    </div>
    ${advancedHtml}
    <div class="card">
      <span class="card-title">历史信号验证</span>
      ${histRows || '<div class="note">暂无可用统计</div>'}
      <div class="note">${esc(validationNote)}</div>
    </div>
    ${events ? `<div class="card"><span class="card-title">当前事件</span>${events}</div>` : ""}
    <div class="card">
      <span class="card-title">证据明细</span>
      ${items || '<div class="note">暂无信号</div>'}
    </div>
    <div class="card">
      <span class="card-title">分时择时</span>
      <div class="kv-row"><span>VWAP关系</span><b>${esc(sig.timing?.hint || "—")}</b></div>
      <div class="note">v1.1 已按分钟增量成交量计算 VWAP。</div>
    </div>
    <div class="note">历史统计只描述样本内表现，不代表未来收益；本工具不构成投资建议。</div>`;
  $("#sig-refresh").onclick = () => loadSignal(true);
}

// ================= 选股面板 =================
function screenBoardLabel(b) {
  const name = String(b?.name || b?.code || "未知行业");
  const count = Number(b?.count);
  const suffix = Number.isFinite(count) && count >= 0 ? `（${Math.round(count)}）` : "";
  return `${name}${suffix}`;
}
function uniqueScreenBoards(input = []) {
  const rows = [], codes = new Set(), names = new Set();
  for (const raw of Array.isArray(input) ? input : []) {
    const code = String(raw?.code || "").trim().toUpperCase();
    const name = String(raw?.name || "").normalize("NFKC").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "").trim();
    const nameKey = name.replace(/([\u3400-\u9fff])(?:IV|III|II|I)$/i, "$1").toLocaleLowerCase("zh-CN");
    if (!code || !nameKey || codes.has(code) || names.has(nameKey)) continue;
    codes.add(code); names.add(nameKey); rows.push({ ...raw, code, name });
  }
  return rows;
}
function filteredScreenBoards() {
  const q = String(state.screenBoardQuery || "").trim().toLowerCase();
  const rows = uniqueScreenBoards(state.screenBoards);
  if (!q) return rows;
  return rows.filter((b) => String(b.name || "").toLowerCase().includes(q) || String(b.code || "").toLowerCase().includes(q));
}
function renderScreenBoardOptions() {
  const sel = $("#screen-select");
  if (!sel) return;
  const rows = filteredScreenBoards();
  const current = state.screenBoardCode || sel.value;
  if (!rows.length) {
    sel.innerHTML = '<option value="">没有匹配的行业</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = rows.map((b) => `<option value="${esc(b.code)}" ${String(b.code) === String(current) ? "selected" : ""}>${esc(screenBoardLabel(b))}</option>`).join("");
  if (!sel.value || !rows.some((b) => String(b.code) === String(sel.value))) sel.value = String(rows[0].code);
  state.screenBoardCode = sel.value;
}
function getScreenVisibleRows() {
  const all = state.screenResult?.rows || [];
  const q = String(state.screenResultQuery || "").trim().toLowerCase();
  if (!q) return all.map((row, i) => ({ ...row, __rank: i + 1 }));
  return all.map((row, i) => ({ ...row, __rank: i + 1 })).filter((row) =>
    String(row.name || "").toLowerCase().includes(q) || String(row.code || "").toLowerCase().includes(q) || String(row.apiCode || "").toLowerCase().includes(q));
}
function renderScreenResults() {
  const el = $("#screen-result");
  const r = state.screenResult;
  if (!el) return;
  if (!r) { el.innerHTML = '<div class="empty-tip">选择行业板块开始选股</div>'; return; }
  const rows = getScreenVisibleRows();
  const size = Math.max(10, Number(state.screenPageSize) || 20);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  state.screenPage = Math.min(pages, Math.max(1, Number(state.screenPage) || 1));
  const start = (state.screenPage - 1) * size;
  const pageRows = rows.slice(start, start + size);
  const board = (state.screenBoards || []).find((b) => String(b.code) === String(r.board));
  const techCoverage = Number(r.technicalCoverage);
  let html = `<div class="screen-result-head">
    <div class="note"><b>${esc(board?.name || r.board || "行业")}</b> · 板块景气 ${Number(r.boardMomentum) > 0 ? "+" : ""}${Number(r.boardMomentum) || 0} · 成分股 ${Number(r.constituents) || 0} 只 · 返回 ${Number(r.returned ?? r.rows?.length) || 0} 只${Number.isFinite(techCoverage) ? ` · 技术数据 ${techCoverage}/${Number(r.eligible || r.rows?.length || 0)}` : ""}</div>
    <input id="screen-stock-search" class="screen-search" type="search" value="${esc(state.screenResultQuery)}" placeholder="搜索备选股票名称 / 代码">
  </div>`;
  if (!pageRows.length) html += '<div class="empty-tip">没有匹配的备选股票</div>';
  else pageRows.forEach((row) => {
    html += `<div class="screen-row" data-code="${esc(row.apiCode)}" title="点击加入自选股">
      <span class="rank">${row.__rank}</span>
      <span class="sname"><b>${esc(row.name)}</b><small>${esc(row.code || "")}</small></span>
      <span class="sval">${fmt(row.price)} · ${Number(row.changePct) > 0 ? "+" : ""}${fmt(row.changePct)}%</span>
      <span class="sscore ${row.final >= 20 ? "up" : row.final <= -20 ? "down" : ""}">${Number.isFinite(Number(row.final)) ? Math.round(Number(row.final)) : "—"}</span>
    </div>`;
  });
  html += `<div class="screen-pagination">
    <span>共 ${rows.length} 条 · 第 ${state.screenPage}/${pages} 页</span>
    <div>
      <button class="screen-page-btn" data-page="1" ${state.screenPage <= 1 ? "disabled" : ""}>首页</button>
      <button class="screen-page-btn" data-page="${state.screenPage - 1}" ${state.screenPage <= 1 ? "disabled" : ""}>上一页</button>
      <button class="screen-page-btn" data-page="${state.screenPage + 1}" ${state.screenPage >= pages ? "disabled" : ""}>下一页</button>
      <button class="screen-page-btn" data-page="${pages}" ${state.screenPage >= pages ? "disabled" : ""}>末页</button>
    </div>
  </div>`;
  el.innerHTML = html;
  $("#screen-stock-search")?.addEventListener("input", (e) => {
    state.screenResultQuery = e.target.value; state.screenPage = 1;
    const caret = String(state.screenResultQuery).length;
    renderScreenResults();
    const next = $("#screen-stock-search");
    if (next) { next.focus(); try { next.setSelectionRange(caret, caret); } catch {} }
  });
  el.querySelectorAll(".screen-row").forEach((rowEl) => { rowEl.onclick = () => addToWatch(rowEl.dataset.code); });
  el.querySelectorAll(".screen-page-btn").forEach((btn) => { btn.onclick = () => { state.screenPage = Number(btn.dataset.page) || 1; renderScreenResults(); }; });
}

async function renderScreen() {
  const body = $("#panel-body");
  // 同一会话内保留行业搜索、筛选结果与分页位置，切走再回来不会重置。
  if (state.screenBoards.length) { renderScreenUI(); return; }
  body.innerHTML = '<div class="loading">⏳ 加载行业列表…</div>';
  const r = await api.getScreen(null, state.screenMethod, state.screenMaxResults).catch((e) => ({ error: e?.message || String(e) }));
  if (state.panel !== 'screen') return;
  if (r.error) { body.innerHTML = `<div class="error-box">${esc(r.error)}</div><button class="btn" id="screen-retry">重试</button>`; $("#screen-retry").onclick = renderScreen; return; }
  state.screenBoards = uniqueScreenBoards(r.boards || []);
  state.screenSource = r.source || state.screenSource;
  if (!state.screenBoardCode || !state.screenBoards.some((b) => String(b.code) === String(state.screenBoardCode))) state.screenBoardCode = state.screenBoards[0]?.code || null;
  state.screenPage = 1;
  renderScreenUI();
}

function renderScreenUI() {
  const body = $("#panel-body");
  body.innerHTML = `
    <div class="panel-title">行业选股 <span class="note">数据源 ${esc(state.screenSource || "—")}</span></div>
    <div class="screen-controls">
      <div class="screen-industry-search-row">
        <input id="screen-industry-search" class="screen-search" type="search" value="${esc(state.screenBoardQuery)}" placeholder="搜索行业名称 / 板块代码，例如：计算机、BK0737">
      </div>
      <div class="screen-board">
        <select id="screen-select"></select>
        <select id="screen-method">
          <option value="hybrid" ${state.screenMethod === "hybrid" ? "selected" : ""}>综合</option>
          <option value="tech" ${state.screenMethod === "tech" ? "selected" : ""}>技术</option>
          <option value="value" ${state.screenMethod === "value" ? "selected" : ""}>价值</option>
        </select>
        <button class="btn" id="screen-run">选股</button>
      </div>
      <div class="screen-display-options">
        <label>最大结果 <input id="screen-max-results" type="number" min="0" max="500" step="10" value="${state.screenMaxResults || ""}" placeholder="全部"></label>
        <label>每页 <select id="screen-page-size"><option value="10" ${state.screenPageSize===10?"selected":""}>10</option><option value="20" ${state.screenPageSize===20?"selected":""}>20</option><option value="50" ${state.screenPageSize===50?"selected":""}>50</option><option value="100" ${state.screenPageSize===100?"selected":""}>100</option></select></label>
        <span class="note">最大结果留空或填 0 = 全部（安全上限 500）；全量股票先快速排序，前 6 名候选补充技术信号。</span>
      </div>
    </div>
    <div id="screen-result"></div>`;
  renderScreenBoardOptions();
  renderScreenResults();

  const search = $("#screen-industry-search");
  search.oninput = () => { state.screenBoardQuery = search.value; renderScreenBoardOptions(); };
  search.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#screen-run")?.click(); } };
  $("#screen-select").onchange = (e) => { state.screenBoardCode = e.target.value; };
  $("#screen-method").onchange = (e) => { state.screenMethod = e.target.value; };
  $("#screen-page-size").onchange = (e) => { state.screenPageSize = Number(e.target.value) || 20; state.screenPage = 1; renderScreenResults(); };
  $("#screen-max-results").onchange = (e) => {
    const n = Number(e.target.value); state.screenMaxResults = Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : 0;
  };
  $("#screen-run").onclick = async () => {
    const board = $("#screen-select").value;
    if (!board) { toast("", "请先选择一个行业"); return; }
    state.screenBoardCode = board;
    state.screenMethod = $("#screen-method").value;
    const n = Number($("#screen-max-results").value); state.screenMaxResults = Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : 0;
    state.screenResultQuery = ""; state.screenPage = 1;
    const runBtn = $("#screen-run"); runBtn.disabled = true;
    $("#screen-result").innerHTML = `<div class="loading">⏳ 全量快筛成分股并计算候选信号…<div class="note">${state.screenMaxResults ? `最多返回 ${state.screenMaxResults} 只` : "返回全部符合条件的成分股"}；仅为排名靠前的 6 只候选补充 K 线技术评分。</div></div>`;
    const res = await api.getScreen(board, state.screenMethod, state.screenMaxResults).catch((e) => ({ error: e?.message || String(e) }));
    runBtn.disabled = false;
    if (res.error) { $("#screen-result").innerHTML = `<div class="error-box">${esc(res.error)}</div>`; return; }
    state.screenResult = res;
    renderScreenResults();
  };
}

function addToWatch(code) {
  const group = state.watchlist.groups[state.activeGroup];
  if (!group) return;
  if (group.symbols.some((s) => s.code === code)) { toast("", "已在自选股中"); return; }
  group.symbols.push({ code });
  api.setWatchlist(state.watchlist.groups);
  renderWatchList();
  toast("", "已加入自选股");
}


// ================= v1.2 策略实验室 =================
const STRATEGY_FALLBACK_PRESETS = [
  { id: "trend_breakout", name: "趋势突破" },
  { id: "trend_pullback", name: "趋势回踩" },
  { id: "momentum", name: "动量强化" },
  { id: "defensive", name: "稳健趋势" },
];

let strategyLoadToken = 0;
async function renderStrategy(config = null) {
  const body = $("#panel-body");
  const code = state.activeCode;
  const token = ++strategyLoadToken;
  if (!state.activeCode) { body.innerHTML = '<div class="empty-tip">先选择一只股票，再运行策略实验室</div>'; return; }
  const viewMode = ["smart","manual","ai"].includes(state.strategyMode) ? state.strategyMode : "smart";
  const smart = viewMode !== "manual";
  const loadingTitle = viewMode === "ai" ? "正在加载AI决策工作台" : smart ? "正在计算稳健推荐参数" : "拉取长历史并回放策略";
  const loadingNote = viewMode === "ai" ? "规则策略作为安全基线，Kronos预测、时机判断和动态调整独立展示" : smart ? "会比较策略类型、样本外表现和参数稳定性，首次运行可能需要数秒" : "首次运行会比普通信号慢一些";
  body.innerHTML = `<div class="loading">⏳ ${loadingTitle}…<div class="note">${loadingNote}</div></div>`;
  const request = config || (smart ? { mode: "smart", profile: state.strategyProfile } : { mode: "manual", presetId: state.strategyPreset });
  const r = await api.getStrategyLab(state.activeCode, request).catch((e) => ({ error: e?.message || String(e) }));
  if (token !== strategyLoadToken || code !== state.activeCode || state.panel !== 'strategy') return;
  if (r.error) { body.innerHTML = `<div class="error-box">${esc(r.error)}</div><button class="btn" id="strategy-retry">重试</button>`; $("#strategy-retry").onclick = () => renderStrategy(request); return; }
  state.strategyResult = r;
  state.strategyMode = viewMode === "ai" ? "ai" : (r.mode || request.mode || state.strategyMode);
  state.strategyProfile = r.selectedProfile || request.profile || state.strategyProfile;
  state.strategyPreset = r.config?.presetId || request.presetId || state.strategyPreset;
  state.strategyPresets = r.presets || state.strategyPresets || [];
  const [monitorResult, aiResult, historyResult] = await Promise.allSettled([
    api.getMonitorState(), api.getLocalAiState(false), api.getLocalAiHistory(100),
  ]);
  if (token !== strategyLoadToken || code !== state.activeCode || state.panel !== 'strategy') return;
  if (monitorResult.status === "fulfilled") state.monitorState = monitorResult.value;
  if (aiResult.status === "fulfilled") state.localAi = aiResult.value;
  if (historyResult.status === "fulfilled") state.localAiHistory = historyResult.value?.items || [];
  renderStrategyResult(r);
}

function strategyPresetOptions(r) {
  const ps = (r.presets && r.presets.length ? r.presets : STRATEGY_FALLBACK_PRESETS);
  return ps.map((p) => `<option value="${esc(p.id)}" ${p.id === r.config?.presetId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
}

function strategyNum(v, d = 0) { return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v).toFixed(d) : "—"; }
function strategyPct(v, signed = false) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "—";
  const n = Number(v); return `${signed && n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function strategyMetricClass(v, inverse = false) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "dim";
  const n = Number(v);
  if (inverse) return n <= 8 ? "down" : n >= 18 ? "up" : "dim";
  return n > 0 ? "up" : n < 0 ? "down" : "dim";
}
function strategyScoreClass(v) {
  const n=Number(v); if(!Number.isFinite(n))return "dim";
  return n>=65?"down":n<45?"up":"dim";
}

function currentMonitor(code=state.activeCode) {
  return (state.monitorState?.items || []).find((x) => x.code === code) || null;
}
function monitorStageLabel(stage) {
  return ({idle:"观察中",near_entry:"接近买点",entry_ready:"待分时确认",entry:"买点触发",holding:"持仓跟踪",risk:"风险预警",exit:"退出触发"})[stage] || "等待检查";
}
function strategyMonitorHtml(r) {
  const mon=currentMonitor(); const rt=mon?.runtime||{};
  const cfg=r.config||{};
  const aiMode=state.strategyMode==="ai";
  if(!mon) return `<div class="card strategy-monitor-card">
    <div class="strategy-monitor-head"><b>🔔 ${aiMode?"AI动态监控":"策略实时监控"}</b><span class="note">未启用</span></div>
    <div class="note">把当前${aiMode?"AI安全基线":(r.mode||state.strategyMode)!=="manual"?"智能推荐":"手动"}参数保存为监控快照。后台会持续判断接近买点、正式触发、风险变化和退出条件；窗口隐藏不影响监控。${aiMode?" AI预测只有同代码、未过期且达到可信阈值时才会参与。":""}</div>
    <div class="strategy-monitor-options"><label><input id="st-mon-near" type="checkbox" checked> 接近买点</label><label><input id="st-mon-entry" type="checkbox" checked> 正式买点</label><label><input id="st-mon-risk" type="checkbox" checked> 风险变化</label><label><input id="st-mon-exit" type="checkbox" checked> 卖出/退出</label><label><input id="st-mon-event" type="checkbox"> 量能/突破异动</label><label><input id="st-mon-ai" type="checkbox" ${aiMode?"checked":""}> AI决策变化</label><label><input id="st-mon-paper" type="checkbox" checked> 买点后模拟跟踪</label><label><input id="st-mon-intraday" type="checkbox" checked> 要求分时确认</label></div>
    ${aiMode?'<div class="note">请使用上方“启用AI动态监控”，系统会先生成或校验当前股票预测。</div>':'<button class="btn" id="strategy-monitor-enable">启用当前策略监控</button>'}
  </div>`;
  const pos=mon.position; const checked=rt.checkedAt?new Date(rt.checkedAt).toLocaleTimeString("zh-CN",{hour12:false}):"—";
  const lv=rt.levels||{};
  const ai=rt.ai||{};
  return `<div class="card strategy-monitor-card">
    <div class="strategy-monitor-head"><b>🔔 ${mon.aiAssist?"AI动态监控":"策略实时监控"}</b><span class="monitor-stage ${esc(rt.stage||"idle")}">${mon.enabled===false?"已暂停":esc(monitorStageLabel(rt.stage))}</span></div>
    <div class="strategy-monitor-status">
      <div><span>策略</span><b>${esc(mon.strategyName||cfg.presetId||"—")}</b></div><div><span>最近检查</span><b>${esc(checked)}</b></div>
      <div><span>入场完成度</span><b>${rt.completion==null?"—":strategyNum(rt.completion)+"%"}</b></div><div><span>当前风险</span><b>${rt.risk==null?"—":strategyNum(rt.risk)}</b></div>
      ${pos?`<div><span>${pos.kind==="actual"?"实际":"模拟"}成本</span><b>${strategyNum(pos.entryPrice,2)}</b></div><div><span>动态止损</span><b>${strategyNum(lv.effectiveStop,2)}</b></div>`:""}
      ${mon.aiAssist?`<div><span>AI决策</span><b>${ai.usable?esc(aiActionLabel(ai.action)):ai.fresh===false?"等待新预测":"可信不足"}</b></div><div><span>AI临时调整</span><b>${ai.applied?`${ai.changes?.length||0}项生效`:"未生效"}</b></div>`:""}
    </div>
    <div class="note">${esc(rt.reason||"已启用，等待后台检查")}${rt.timing?.hint?` · ${esc(rt.timing.hint)}`:""}</div>
    <div class="strategy-monitor-actions"><button class="btn" id="strategy-monitor-check">立即检查</button><button class="btn secondary" id="strategy-monitor-position">${pos?"修改持仓":"记录持仓"}</button><button class="btn ghost" id="strategy-monitor-sync">用当前参数更新监控</button><button class="btn ghost" id="strategy-monitor-disable">${mon.enabled===false?"恢复监控":"暂停监控"}</button></div>
  </div>`;
}

function smartStrategyHtml(r) {
  const rec=r.recommendation||{};
  if(rec.status!=="ok") return `<div class="card"><span class="card-title">智能推荐</span><div class="note">${esc(rec.message||"历史数据不足，暂时无法形成智能推荐。")}</div><button class="btn strategy-switch-manual">改用手动高级模式</button></div>`;
  const profileId=r.selectedProfile||rec.selectedProfile||state.strategyProfile||"balanced";
  const p=rec.profiles?.[profileId]||rec.profiles?.balanced||{};
  const c=r.config||p.config||{};
  const profileOrder=["conservative","balanced","aggressive"];
  const profileButtons=profileOrder.map(id=>{
    const x=rec.profiles?.[id]; if(!x)return "";
    const active=id===profileId?" active":"";
    return `<button class="strategy-profile${active}" data-strategy-profile="${id}">
      <b>${esc(x.name||id)}${id==="balanced"?" · 推荐":""}</b>
      <span>综合 ${strategyNum(x.score)} · 可信 ${strategyNum(x.confidence)}</span>
      <em>止损 ${strategyNum(x.config?.stopLossPct,1)}% · 止盈 ${strategyNum(x.config?.takeProfitPct,1)}%</em>
    </button>`;
  }).join("");
  const rankings=(rec.rankings||[]).map((x,i)=>`<div class="strategy-rank-row"><span>${i+1}. ${esc(x.name)}</span><b class="${strategyScoreClass(x.score)}">${strategyNum(x.score)}/100</b><em>形态 ${strategyNum(x.styleFit)} · 市场 ${strategyNum(x.marketFit)}</em></div>`).join("");
  const reasons=(p.reasons||[]).map(x=>`<li>${esc(x)}</li>`).join("");
  const conf=Number(p.confidence??rec.confidence);
  const action=p.action||"研究候选";
  const warning=conf<45?`<div class="strategy-reco-warning">⚠ 推荐可信度较低：样本量、样本外交易或参数稳定性不足。不要把当前参数当作“自动最优”。</div>`:"";
  return `
    <div class="card strategy-reco-hero">
      <div class="strategy-reco-head"><div><span class="card-title">智能策略推荐</span><strong>${esc(rec.headline||"—")}</strong></div><div class="strategy-reco-score ${strategyScoreClass(p.score)}"><small>策略适配</small><b>${strategyNum(p.score)}/100</b></div></div>
      <div class="strategy-reco-status"><span>${esc(action)}</span><b>可信度 ${strategyNum(conf)}/100</b></div>
      <div class="note">${esc(rec.summary||"")}</div>${warning}
      <div class="strategy-profile-grid">${profileButtons}</div>
      <div class="strategy-reco-params">
        <div><span>策略</span><b>${esc((r.presets||[]).find(x=>x.id===c.presetId)?.name||c.presetId||"—")}</b></div>
        <div><span>入场分</span><b>≥ ${strategyNum(c.entryScore)}</b></div>
        <div><span>最大风险</span><b>≤ ${strategyNum(c.maxRisk)}</b></div>
        <div><span>止损</span><b>${strategyNum(c.stopLossPct,1)}%</b></div>
        <div><span>止盈</span><b>${strategyNum(c.takeProfitPct,1)}%</b></div>
        <div><span>移动止损</span><b>${strategyNum(c.trailingStopPct,1)}%</b></div>
        <div><span>最长持有</span><b>${strategyNum(c.maxHoldDays)}日</b></div>
        <div><span>近期ATR</span><b>${strategyNum(rec.sample?.atrRecent,1)}%</b></div>
      </div>
      <div class="strategy-reco-actions"><button class="btn" id="strategy-smart-refresh">重新智能计算</button><button class="btn secondary" id="strategy-to-manual">微调高级参数</button></div>
    </div>
    <details class="card strategy-reco-details">
      <summary>为什么推荐这组参数</summary>
      <ul>${reasons||"<li>暂无足够解释数据</li>"}</ul>
      <div class="strategy-diagnostics">
        <div><span>策略适配度</span><b>${p.diagnostics?.strategyFit??p.score??"—"}/100</b></div>
        <div><span>历史可靠度</span><b>${p.diagnostics?.historicalReliability??"—"}/100</b></div>
        <div><span>参数稳定度</span><b>${p.diagnostics?.parameterStability??"—"}/100</b></div>
        <div><span>市场匹配度</span><b>${p.finalRegimeFit??p.diagnostics?.marketFit??rec.marketFit??"—"}/100</b></div>
        <div><span>样本充分度</span><b>${p.diagnostics?.sampleAdequacy??"—"}/100</b></div>
        <div><span>保留检验收益</span><b class="${strategyMetricClass(p.metrics?.oosReturn)}">${strategyPct(p.metrics?.oosReturn,true)}</b></div>
        <div><span>保留检验交易</span><b>${p.metrics?.oosTrades??"—"}</b></div>
        <div><span>滚动盈利段</span><b>${p.metrics?.rollingPositivePct==null?"—":strategyNum(p.metrics.rollingPositivePct,1)+"%"}</b></div>
        <div><span>最终邻域盈利</span><b>${p.finalNeighborhoodPositivePct==null?(p.stability?.positivePct==null?"—":strategyNum(p.stability.positivePct,1)+"%"):strategyNum(p.finalNeighborhoodPositivePct,1)+"%"}</b></div>
        <div><span>历史K线</span><b>${rec.sample?.historyBars??"—"}根</b></div>
      </div>
      <div class="note">${esc(rec.notice||"")}</div>
    </details>
    <details class="card strategy-reco-details">
      <summary>候选策略比较</summary>${rankings||'<div class="note">暂无候选排名</div>'}
    </details>`;
}


function aiPct01(v) { const n=Number(v); return v!=null&&v!==""&&Number.isFinite(n)?`${(n*100).toFixed(1)}%`:'—'; }
function aiEngineStatusLabel(v){return ({not_installed:"未安装",installing:"安装中",stopped:"已安装·未运行",running:"运行中",error:"异常"})[v]||String(v||"未知");}
function aiActionLabel(v){return ({BUY:"买入时机增强",HOLD:"持有并跟踪",WATCH:"等待确认",REDUCE:"减仓/防守",EXIT:"退出优先"})[v]||String(v||"等待预测");}
function aiChangeMeaning(x){
  const from=Number(x?.from),to=Number(x?.to),up=to>from;
  return ({entryScore:up?"提高门槛 · 更谨慎":"降低门槛 · 更积极",maxRisk:up?"放宽风险容忍":"收紧风险容忍",stopLossPct:up?"放宽止损":"收紧止损",takeProfitPct:up?"提高止盈目标":"降低止盈目标",trailingStopPct:up?"放宽移动止损":"收紧移动止损",maxHoldDays:up?"延长观察期":"缩短持有期"})[x?.key]||"临时参数变化";
}
function aiDecisionHtml(last, ai) {
  if(!last) return `<div class="ai-empty-state"><b>尚无当前股票的AI预测</b><span>运行一次预测后，这里会展示未来路径、买卖时机、自适应参数和风险失效条件。其他股票的历史结果不会在这里串用。</span></div>`;
  const d=last.decision||{},pr=last.prediction||{},plan=last.adaptivePlan||{};
  const coldStart=pr.sourceMode==="cold_start"||pr.base==="ColdStart";
  const ageMs=Math.max(0,Date.now()-Number(last.generatedAt||0));
  const maxAgeMin=Math.max(15,Number(ai?.maxPredictionAgeMin)||120);
  const fresh=ageMs<=maxAgeMin*60000;
  const ageText=ageMs<60000?"刚刚":ageMs<3600000?`${Math.round(ageMs/60000)}分钟前`:`${(ageMs/3600000).toFixed(1)}小时前`;
  const actionClass=["BUY","HOLD"].includes(d.action)?"up":["REDUCE","EXIT"].includes(d.action)?"down":"dim";
  const prob=Number(pr.calibratedProbability??pr.positiveProbability);
  const direction=Number.isFinite(prob)?(prob>=.58?"偏多":prob<=.42?"偏空":"中性"):"未知";
  const directionClass=Number.isFinite(prob)?strategyMetricClass(prob-.5):"dim";
  const ruleMatched=last.strategy?.matched===true;
  const failed=(last.strategy?.current?.failed||[]).slice(0,3);
  const timingType=String(last.timing?.type||"wait");
  const timingLabel=({buy:"分时已确认",sell:"分时偏弱",wait:"等待分时确认",neutral:"暂无分时优势"})[timingType]||"等待分时确认";
  const timingClass=timingType==="buy"?"up":timingType==="sell"?"down":"dim";
  const sampleRuns=Number(pr.sampleRuns)||0,onlineUpdates=Number(pr.online?.updates)||0;
  const spread=pr.q90ReturnPct!=null&&pr.q10ReturnPct!=null?Number(pr.q90ReturnPct)-Number(pr.q10ReturnPct):null;
  const extremeProbability=!coldStart&&Number.isFinite(prob)&&(prob>=.95||prob<=.05)&&Number(d.confidence)<90;
  const confidenceExplain=coldStart?"短历史统计可信上限为35，不能作为正式AI信号":`${sampleRuns||"—"}次路径采样 · ${onlineUpdates}条在线校准${Number.isFinite(spread)?` · 情景跨度${spread.toFixed(2)}%`:""}；可信度不是上涨概率`;
  const why=coldStart
    ?"历史尚未达到Kronos的40根最低输入，当前只观察真实短样本。"
    :d.action==="WATCH"&&!ruleMatched
      ?`模型方向${direction}，但规则未共振${failed.length?`（仍缺：${failed.join("、")}）`:""}，因此不升级为买入信号。`
      :d.action==="BUY"
        ?"模型方向、规则入场条件与盘中确认共同增强，仍需在建议窗口内复核。"
        :["REDUCE","EXIT"].includes(d.action)
          ?"模型下行情景达到防守阈值，优先检查仓位、止损与预测是否仍在有效期。"
          :`当前结论为“${aiActionLabel(d.action)}”，由模型路径、规则条件和盘中时机联合产生。`;
  const path=(plan.path?.length?plan.path:(pr.trajectory||[]).map((close,i)=>({day:i+1,close,returnPct:Number(pr.lastClose)>0?(Number(close)/Number(pr.lastClose)-1)*100:null}))).slice(0,10);
  const pathHtml=path.map((x)=>`<div class="ai-path-point"><span>D${x.day}</span><b class="${strategyMetricClass(x.returnPct)}">${strategyPct(x.returnPct,true)}</b><em>${strategyNum(x.close,2)}</em></div>`).join("");
  const changes=(plan.changes||[]).map(x=>`<div><span>${esc(x.label)}<small>${esc(aiChangeMeaning(x))}</small></span><b>${strategyNum(x.from,1)} → ${strategyNum(x.to,1)}</b></div>`).join("");
  const reasons=(plan.reasons||[]).map(x=>`<li>${esc(x)}</li>`).join("");
  const risks=(plan.riskFlags||[]).map(x=>`<span>${esc(x)}</span>`).join("");
  return `<div class="ai-decision-board">
    <div class="ai-color-legend"><span><i class="up"></i>红色 = 上涨 / 偏多</span><span><i class="down"></i>绿色 = 下跌 / 偏空</span><em>灰色 = 中性或待确认</em></div>
    <div class="ai-decision-hero">
      <div><span>${coldStart?"新股冷启动 · 仅观察":`AI时机判断 · ${fresh?"有效":"已过期"}`}</span><strong class="${actionClass}">${esc(coldStart?"等待积累数据":aiActionLabel(d.action))}</strong><small>${esc(plan.label||"基于Kronos路径与规则策略联合判断")}</small></div>
      <div class="ai-confidence"><b>${strategyNum(d.confidence)}</b><span>/100 综合可信度</span><em>${ageText}</em></div>
    </div>
    <div class="ai-why"><b>为什么得到这个结论</b><p>${esc(why)}</p><small>${esc(confidenceExplain)}</small></div>
    <div class="ai-decision-chain">
      <div><span>① 模型方向</span><b class="${directionClass}">${esc(coldStart?"未运行":direction)}</b><small>${coldStart?`${pr.observed?.bars??0}/40根`:`上涨概率 ${aiPct01(pr.calibratedProbability??pr.positiveProbability)}`}</small></div>
      <div><span>② 规则确认</span><b class="${ruleMatched?"up":"dim"}">${ruleMatched?"已共振":"未共振"}</b><small>${ruleMatched?"入场条件满足":esc(failed.join("、")||"条件未满足")}</small></div>
      <div><span>③ 盘中时机</span><b class="${timingClass}">${esc(timingLabel)}</b><small>${esc(last.timing?.hint||"等待盘中价格和量能确认")}</small></div>
    </div>
    ${coldStart?`<div class="strategy-reco-warning">当前只有 ${pr.observed?.bars??0} 根有效日 K；Kronos 没有运行，也没有生成未来收益预测。该快照不会触发 AI 买卖提醒或动态参数。</div>`:!fresh?`<div class="strategy-reco-warning">该预测超过 ${maxAgeMin} 分钟有效期，只保留审计展示，不会用于动态参数或主动提醒。</div>`:""}
    ${extremeProbability?`<div class="strategy-reco-warning">模型方向概率接近极值，但综合可信度仅 ${strategyNum(d.confidence)}/100。概率不等于确定性；当前仍受采样次数、预测区间和在线校准样本限制。</div>`:""}
    <div class="ai-timing-window"><span>建议窗口</span><b>${esc(plan.window||last.timing?.hint||"等待下一次模型确认")}</b></div>
    ${coldStart?`<div class="strategy-diagnostics ai-prob-grid">
      <div><span>有效日 K</span><b>${pr.observed?.bars??0} / 40</b></div>
      <div><span>近5日表现</span><b class="${strategyMetricClass(pr.observed?.return5Pct)}">${strategyPct(pr.observed?.return5Pct,true)}</b></div>
      <div><span>上市以来</span><b class="${strategyMetricClass(pr.observed?.listingReturnPct)}">${strategyPct(pr.observed?.listingReturnPct,true)}</b></div>
      <div><span>样本最大回撤</span><b>${strategyPct(pr.observed?.maxDrawdownPct)}</b></div>
      <div><span>日波动率</span><b>${strategyPct(pr.observed?.dailyVolatilityPct)}</b></div>
      <div><span>近5日量比</span><b>${strategyNum(pr.observed?.volumeRatio,2)}</b></div>
    </div>`:`<div class="strategy-diagnostics ai-prob-grid">
      <div><span>模型上涨概率<small>不是可信度</small></span><b class="${directionClass}">${aiPct01(pr.calibratedProbability??pr.positiveProbability)}</b></div>
      <div><span>未来${pr.predLen||5}日收益中位数</span><b class="${strategyMetricClass(pr.medianReturnPct)}">${strategyPct(pr.medianReturnPct,true)}</b></div>
      <div><span>悲观情景 · Q10</span><b class="${strategyMetricClass(pr.q10ReturnPct)}">${strategyPct(pr.q10ReturnPct,true)}</b></div>
      <div><span>乐观情景 · Q90</span><b class="${strategyMetricClass(pr.q90ReturnPct)}">${strategyPct(pr.q90ReturnPct,true)}</b></div>
      <div><span>规则是否共振</span><b>${last.strategy?.matched?"是":"否"}</b></div>
      <div><span>在线学习样本</span><b>${pr.online?.updates??0}</b></div>
    </div>`}
    ${pathHtml?`<div class="ai-path"><div class="ai-section-label">未来价格路径中位数 <em>相对当前价的预测变化，并非目标价承诺</em></div><div class="ai-path-grid">${pathHtml}</div></div>`:""}
    <div class="ai-adaptive-plan">
      <div class="ai-section-label">${coldStart?"冷启动能力状态":"随机应变的策略调整"} <em>${coldStart?"达到门槛后自动解锁":"仅本次预测有效，不覆盖基准参数"}</em></div>
      ${changes?`<div class="ai-change-grid">${changes}</div>`:'<div class="note">当前没有必要调整基准参数；继续按原策略监控。</div>'}
      ${reasons?`<ul>${reasons}</ul>`:""}
      ${risks?`<div class="ai-risk-flags">${risks}</div>`:""}
    </div>
  </div>`;
}
function localAiCardHtml(r) {
  const ai=state.localAi;
  if(!ai) return `<div class="card local-ai-card"><div class="local-ai-head"><b>🧠 本地AI增强 · 实验</b><span class="note">正在读取状态…</span></div></div>`;
  const hw=ai.hardware||{},gpu=hw.gpu||{},rec=ai.recommendation||hw.recommendation||{};
  const models=Array.isArray(ai.models)?ai.models:[];
  const kronos=models.filter(x=>x.family==="Kronos"&&x.installable);
  const selected=kronos.find(x=>x.id===ai.modelId)||kronos[0]||{};
  const installed=(ai.installedModels||[]).includes(selected.id);
  const codeHistory=(state.localAiHistory||[]).filter(x=>String(x?.code||"")===String(state.activeCode||""));
  const last=codeHistory[0]||(String(ai.lastPrediction?.code||"")===String(state.activeCode||"")?ai.lastPrediction:null);
  const history=codeHistory.slice(0,8).map(x=>`<div class="local-ai-history-row"><span>${new Date(x.generatedAt).toLocaleString("zh-CN",{hour12:false})}</span><b>${esc(x.prediction?.sourceMode==="cold_start"?"冷启动观察":aiActionLabel(x.decision?.action))}</b><em>${x.prediction?.sourceMode==="cold_start"?`${x.prediction?.observed?.bars??0}根 / 40根`:`${x.prediction?.calibratedProbability==null?"—":aiPct01(x.prediction.calibratedProbability)} · 中位${strategyPct(x.prediction?.medianReturnPct,true)}`}</em></div>`).join("");
  const installables=models.map(m=>`<div class="local-ai-model-row ${m.id===ai.modelId?"active":""}"><div><b>${esc(m.name)}</b><span>${esc(m.params)} · ${esc(m.license)} · ${esc(m.authority)}</span><small>${esc(m.note||"")}</small></div><div class="local-ai-model-actions"><button class="btn ghost ai-model-source" data-ai-source="${esc(m.sourceUrl||"")}">官方</button>${m.installed?`<span class="local-ai-installed">已安装</span>`:m.installable?`<button class="btn ghost ai-install-model" data-ai-install="${esc(m.id)}">安装</button>`:`<span class="note">需训练</span>`}</div></div>`).join("");
  const progress=state.localAiEvent?.message?`<div class="local-ai-progress" id="local-ai-progress">${esc(state.localAiEvent.message)}</div>`:"";
  const lastHtml=aiDecisionHtml(last,ai);
  const aiMonitor=currentMonitor();
  return `<div class="card local-ai-card">
    <div class="local-ai-head"><div><span class="card-title">AI策略决策台</span><strong>${esc(aiEngineStatusLabel(ai.engineStatus))}</strong></div><label class="local-ai-toggle"><input type="checkbox" id="local-ai-enabled" ${ai.enabled?"checked":""} ${!installed?"disabled":""}> 启用AI</label></div>
    <div class="note">Kronos预测与规则策略共同给出买卖时机、临时参数调整和提醒；不会自动下单，也不会覆盖你保存的基准策略。30分钟标签仅用于本机在线校准。</div>
    ${progress}${lastHtml}
    <details class="local-ai-hardware"><summary>本机配置检查与运行建议 <span>${esc(({lite:"轻量",standard:"标准",advanced:"高级"})[rec.profile]||rec.profile||"—")}档</span></summary>
    <div class="local-ai-hw-grid"><div><span>CPU</span><b>${esc(hw.cpu?.model||"未检测")}</b><em>${hw.cpu?.logicalCores||"—"}线程</em></div><div><span>内存</span><b>${hw.ramGB??"—"} GB</b><em>空闲 ${hw.freeRamGB??"—"} GB</em></div><div><span>GPU</span><b>${esc(gpu.name||"未检测")}</b><em>${gpu.vramMB?`${(gpu.vramMB/1024).toFixed(1)} GB显存`:"无可用显存信息"}</em></div><div><span>Python</span><b>${esc(hw.python?.version||"未检测")}</b><em>${hw.python?.supported?"可安装":"需要3.10+"}</em></div><div><span>AI目录磁盘</span><b>${hw.diskFreeGB??"—"} GB</b><em>剩余空间</em></div></div>
    <div class="local-ai-recommend"><b>硬件建议：${esc(({lite:"轻量",standard:"标准",advanced:"高级"})[rec.profile]||rec.profile||"—")}</b><span>${esc(rec.reason||"")}</span>${rec.warning?`<em>⚠ ${esc(rec.warning)}</em>`:""}</div>
    <button class="btn secondary" id="local-ai-detect">重新检测硬件</button></details>
    <div class="strategy-form-grid local-ai-config">
      <label>运行档位<select id="local-ai-profile"><option value="lite" ${ai.profile==="lite"?"selected":""}>轻量</option><option value="standard" ${ai.profile==="standard"?"selected":""}>标准</option><option value="advanced" ${ai.profile==="advanced"?"selected":""}>高级</option></select></label>
      <label>主模型<select id="local-ai-model">${kronos.map(m=>`<option value="${esc(m.id)}" ${m.id===ai.modelId?"selected":""}>${esc(m.name)} · ${esc(m.params)}${m.installed?" · 已安装":""}</option>`).join("")}</select></label>
      <label>自动预测<select id="local-ai-auto"><option value="0" ${!ai.autoShadow?"selected":""}>关闭</option><option value="1" ${ai.autoShadow?"selected":""}>仅AI监控股票</option></select></label>
      <label>预测间隔<select id="local-ai-interval">${[5,15,30,60].map(n=>`<option value="${n}" ${Number(ai.autoIntervalMin||15)===n?"selected":""}>${n}分钟</option>`).join("")}</select></label>
      <label>决策变化提醒<select id="local-ai-alerts"><option value="1" ${ai.decisionAlerts!==false?"selected":""}>开启</option><option value="0" ${ai.decisionAlerts===false?"selected":""}>关闭</option></select></label>
      <label>动态策略调整<select id="local-ai-adaptive"><option value="1" ${ai.adaptiveStrategy!==false?"selected":""}>启用临时快照</option><option value="0" ${ai.adaptiveStrategy===false?"selected":""}>仅展示建议</option></select></label>
      <label>提醒最低可信<select id="local-ai-confidence">${[45,55,65,75].map(n=>`<option value="${n}" ${Number(ai.minDecisionConfidence||55)===n?"selected":""}>${n}/100</option>`).join("")}</select></label>
      <label>预测有效期<select id="local-ai-max-age">${[30,60,120,240].map(n=>`<option value="${n}" ${Number(ai.maxPredictionAgeMin||120)===n?"selected":""}>${n}分钟</option>`).join("")}</select></label>
    </div>
    <div class="local-ai-actions">${installed?`<button class="btn" id="local-ai-run">刷新当前股票AI决策</button><button class="btn secondary" id="local-ai-monitor">${aiMonitor?.aiAssist?"更新AI动态监控":"启用AI动态监控"}</button>`:`<button class="btn" id="local-ai-install">安装 ${esc(selected.name||"模型")}</button>`}${ai.engineStatus==="running"?`<button class="btn ghost" id="local-ai-stop">停止AI进程</button>`:installed?`<button class="btn ghost" id="local-ai-start">启动AI进程</button>`:""}</div>
    <details class="local-ai-models"><summary>公开模型与实验组件</summary>${installables}</details>
    ${history?`<details class="local-ai-history"><summary>当前股票最近AI决策</summary>${history}</details>`:""}
    <details class="local-ai-models"><summary>能力边界与实验组件说明</summary><div class="note">MASTER公开CSI300/800 checkpoint需要完整横截面222维输入，当前不会对单只股票伪造MASTER得分；TRA同样等待Feature Store训练后再启用。所有AI结果均为研究辅助，不构成自动交易。</div><button class="btn ghost" id="local-ai-uninstall" ${!ai.installed?"disabled":""}>卸载AI引擎</button></details>
  </div>`;
}

async function refreshLocalAiAndStrategy(r, detect=false){
  try{state.localAi=await api.getLocalAiState(detect);state.localAiHistory=(await api.getLocalAiHistory(100)).items||[];}catch(e){toast("risk",e?.message||String(e));}
  renderStrategyResult(r);
}
function bindLocalAiActions(r){
  const updateAiSetting=async(patch,{rerender=true}={})=>{try{state.localAi=await api.setLocalAiSettings(patch);if(rerender)renderStrategyResult(r);return true;}catch(e){toast("risk",e?.message||String(e));return false;}};
  const enabled=$("#local-ai-enabled"); if(enabled) enabled.onchange=async(e)=>{if(e.target.checked && !(state.localAi?.installedModels||[]).includes(state.localAi?.modelId)){e.target.checked=false;toast("risk","请先安装当前Kronos模型");return;}const ok=await updateAiSetting({enabled:!!e.target.checked});if(ok)toast("",e.target.checked?"AI决策支持已启用":"AI决策支持已关闭");};
  const profile=$("#local-ai-profile"); if(profile) profile.onchange=async(e)=>{const map={lite:"kronos-mini",standard:"kronos-small",advanced:"kronos-base"};await updateAiSetting({profile:e.target.value,modelId:map[e.target.value]});};
  const model=$("#local-ai-model"); if(model) model.onchange=async(e)=>{await updateAiSetting({modelId:e.target.value});};
  const auto=$("#local-ai-auto"); if(auto) auto.onchange=async(e)=>{await updateAiSetting({autoShadow:e.target.value==="1"});};
  const interval=$("#local-ai-interval"); if(interval) interval.onchange=async(e)=>{await updateAiSetting({autoIntervalMin:Number(e.target.value)},{rerender:false});};
  const alerts=$("#local-ai-alerts"); if(alerts) alerts.onchange=async(e)=>{await updateAiSetting({decisionAlerts:e.target.value==="1"},{rerender:false});};
  const adaptive=$("#local-ai-adaptive"); if(adaptive) adaptive.onchange=async(e)=>{await updateAiSetting({adaptiveStrategy:e.target.value==="1"},{rerender:false});};
  const confidence=$("#local-ai-confidence"); if(confidence) confidence.onchange=async(e)=>{await updateAiSetting({minDecisionConfidence:Number(e.target.value)},{rerender:false});};
  const maxAge=$("#local-ai-max-age"); if(maxAge) maxAge.onchange=async(e)=>{await updateAiSetting({maxPredictionAgeMin:Number(e.target.value)});};
  const detect=$("#local-ai-detect"); if(detect) detect.onclick=async()=>{detect.disabled=true;await refreshLocalAiAndStrategy(r,true);toast("","硬件检测已刷新");};
  const install=$("#local-ai-install"); if(install) install.onclick=async()=>{const x=await api.installLocalAi(state.localAi?.modelId);if(!x.ok){toast("risk",x.error||"安装无法启动");return;}state.localAi={...state.localAi,engineStatus:"installing"};state.localAiEvent={message:"安装已启动；可继续使用StockDesk，安装进度会在此更新。"};renderStrategyResult(r);};
  document.querySelectorAll(".ai-install-model").forEach(b=>b.onclick=async()=>{const x=await api.installLocalAi(b.dataset.aiInstall);if(!x.ok)toast("risk",x.error||"安装无法启动");else{state.localAi={...state.localAi,engineStatus:"installing"};state.localAiEvent={message:`正在安装 ${b.dataset.aiInstall}…`};renderStrategyResult(r);}});
  document.querySelectorAll(".ai-model-source").forEach(b=>b.onclick=()=>{if(b.dataset.aiSource)api.openExternal(b.dataset.aiSource);});
  const start=$("#local-ai-start"); if(start) start.onclick=async()=>{start.disabled=true;try{await api.startLocalAi();await refreshLocalAiAndStrategy(r);toast("","本地AI进程已启动");}catch(e){toast("risk",e?.message||String(e));start.disabled=false;}};
  const stop=$("#local-ai-stop"); if(stop) stop.onclick=async()=>{await api.stopLocalAi();await refreshLocalAiAndStrategy(r);toast("","本地AI进程已停止");};
  const run=$("#local-ai-run"); if(run) run.onclick=async()=>{const code=state.activeCode;run.disabled=true;run.textContent="AI预测中…";try{const row=await api.runLocalAiShadow(code,{...r.config,mode:"manual"});if(code!==state.activeCode)return;state.localAi={...state.localAi,lastPrediction:row};state.localAiHistory=(await api.getLocalAiHistory(100)).items||[];toast("",row.prediction?.sourceMode==="cold_start"?`冷启动观察：${row.prediction?.observed?.bars??0} / 40 根，未运行Kronos`:`AI决策：${aiActionLabel(row.decision?.action)}`);renderStrategyResult(r);}catch(e){toast("risk",e?.message||String(e));if(code===state.activeCode){run.disabled=false;run.textContent="刷新当前股票AI决策";}}};
  const monitor=$("#local-ai-monitor"); if(monitor) monitor.onclick=async()=>{
    const code=state.activeCode; monitor.disabled=true; monitor.textContent="正在接入AI监控…";
    try{
      if(!state.localAi?.enabled||!state.localAi?.autoShadow)state.localAi=await api.setLocalAiSettings({enabled:true,autoShadow:true});
      const payload=monitorPayloadFromStrategy(r,{mode:"ai",aiAssist:true,aiAdaptive:state.localAi?.adaptiveStrategy!==false,aiMinConfidence:Number(state.localAi?.minDecisionConfidence)||55,aiMaxAgeMin:Number(state.localAi?.maxPredictionAgeMin)||120,notifyTypes:{nearEntry:true,entry:true,risk:true,exit:true,event:false,ai:true}});
      const x=await api.setStrategyMonitor(code,payload);if(!x.ok)throw new Error(x.error||"AI监控启用失败");state.monitorState=x.state;
      const latest=(state.localAiHistory||[]).find(row=>String(row?.code||"")===String(code));
      const fresh=latest&&Date.now()-Number(latest.generatedAt||0)<(Number(state.localAi?.maxPredictionAgeMin)||120)*60000;
      let refreshed=null;if(!fresh){refreshed=await api.runLocalAiShadow(code,{...r.config,mode:"manual"});state.localAi={...state.localAi,lastPrediction:refreshed};state.localAiHistory=(await api.getLocalAiHistory(100)).items||[];}
      const latestRow=refreshed||(state.localAiHistory||[]).find(row=>String(row?.code||"")===String(code));
      await api.checkMonitorsNow();await updateMonitorState();toast(latestRow?.prediction?.sourceMode==="cold_start"?"":"buy",latestRow?.prediction?.sourceMode==="cold_start"?"监控已登记；达到40根日K前只观察，不触发AI提醒":"AI动态监控已启用：预测变化与临时策略调整会进入提醒中心");
      if(code===state.activeCode)renderStrategyResult(r);
    }catch(e){toast("risk",e?.message||String(e));if(code===state.activeCode){monitor.disabled=false;monitor.textContent="启用AI动态监控";}}
  };
  const un=$("#local-ai-uninstall"); if(un) un.onclick=async()=>{if(!confirm("确定卸载StockDesk本地AI环境、已下载模型和在线校准checkpoint？影子历史将一并删除。"))return;const x=await api.uninstallLocalAi();state.localAi=x.state;state.localAiHistory=[];state.localAiEvent=null;toast("","本地AI引擎已卸载");renderStrategyResult(r);};
}

function manualStrategyHtml(r) {
  const c=r.config||{};
  const preset=(r.presets||[]).find((p)=>p.id===c.presetId);
  return `<div class="card strategy-config-card">
      <span class="card-title">高级规则配置</span>
      <div class="strategy-form-row"><label>策略</label><select id="strategy-preset">${strategyPresetOptions(r)}</select></div>
      <div class="strategy-form-grid">
        <label>入场分 ≥ <input id="st-entry" type="number" min="-20" max="90" value="${strategyNum(c.entryScore)}"></label>
        <label>最大风险 ≤ <input id="st-risk" type="number" min="10" max="100" value="${strategyNum(c.maxRisk)}"></label>
        <label>止损 % <input id="st-stop" type="number" min="0" max="30" step="0.5" value="${strategyNum(c.stopLossPct,1)}"></label>
        <label>止盈 % <input id="st-take" type="number" min="0" max="80" step="0.5" value="${strategyNum(c.takeProfitPct,1)}"></label>
        <label>移动止损 % <input id="st-trail" type="number" min="0" max="40" step="0.5" value="${strategyNum(c.trailingStopPct,1)}"></label>
        <label>最长持有 <input id="st-hold" type="number" min="1" max="120" value="${strategyNum(c.maxHoldDays)}"></label>
      </div>
      <div class="note">${esc(preset?.description||"修改参数后可重新回放。")}</div>
      <button class="btn" id="strategy-run">重新回测 + 参数扫描</button>
    </div>`;
}

function limitedStrategyHtml(r) {
  const x=r.limitedAnalysis||{},bars=Number(x.bars)||0;
  const capabilities=(x.capabilities||[]).map((cap)=>{
    const pct=Math.max(0,Math.min(100,Math.round(bars/Math.max(1,Number(cap.required)||1)*100)));
    return `<div class="limited-capability ${cap.ready?"ready":"locked"}">
      <div><span>${esc(cap.label)}</span><b>${cap.ready?"已解锁":`${bars} / ${cap.required} 根`}</b></div>
      <i><em style="width:${pct}%"></em></i>
    </div>`;
  }).join("");
  const next=(x.capabilities||[]).find((cap)=>!cap.ready);
  return `<div class="card limited-strategy-card">
    <div class="strategy-reco-head"><div><span class="card-title">新股有限样本模式</span><strong>${bars} 根有效日 K</strong></div><div class="limited-badge">不做回测结论</div></div>
    <div class="note">不补造历史、不用短样本拟合买卖规则；先展示可验证的已发生统计，能力随真实交易日自动解锁。</div>
    <div class="strategy-diagnostics limited-metrics">
      <div><span>上市以来</span><b class="${strategyMetricClass(x.listingReturnPct)}">${strategyPct(x.listingReturnPct,true)}</b></div>
      <div><span>近5日</span><b class="${strategyMetricClass(x.return5Pct)}">${strategyPct(x.return5Pct,true)}</b></div>
      <div><span>近10日</span><b class="${strategyMetricClass(x.return10Pct)}">${strategyPct(x.return10Pct,true)}</b></div>
      <div><span>样本最大回撤</span><b>${strategyPct(x.maxDrawdownPct)}</b></div>
      <div><span>日波动率</span><b>${strategyPct(x.dailyVolatilityPct)}</b></div>
      <div><span>近5日量比</span><b>${strategyNum(x.volumeRatio,2)}</b></div>
    </div>
    <div class="limited-capabilities">${capabilities}</div>
    <div class="strategy-reco-warning">${next?`再积累 ${Math.max(0,Number(next.required)-bars)} 根日 K 可解锁“${esc(next.label)}”。`:"能力门槛已满足。"} 在 100 根之前不输出策略胜率、回测收益或正式买点。</div>
  </div>`;
}

function renderStrategyResult(r) {
  const body = $("#panel-body");
  if (r.status !== "ok" || !r.metrics) {
    const badMode=state.strategyMode==="ai"?"ai":state.strategyMode==="manual"?"manual":"smart";
    body.innerHTML = `<div class="panel-title">策略实验室 <span class="note">v1.9</span></div>
      <div class="strategy-mode-switch"><button class="${badMode==="smart"?"active":""}" data-strategy-mode="smart">智能推荐</button><button class="${badMode==="manual"?"active":""}" data-strategy-mode="manual">手动高级</button><button class="${badMode==="ai"?"active":""}" data-strategy-mode="ai">AI策略</button></div>
      ${badMode==="ai"?localAiCardHtml(r):r.status==="limited"?limitedStrategyHtml(r):`<div class="error-box">${esc(r.message || "历史数据不足，无法回测")}</div>`}`;
    body.querySelectorAll("[data-strategy-mode]").forEach((b)=>b.onclick=()=>{state.strategyMode=b.dataset.strategyMode||"smart";renderStrategyResult(r);});
    if(badMode==="ai")bindLocalAiActions(r);
    return;
  }
  const c = r.config || {};
  const m = r.metrics || {};
  const current = r.current || {};
  const scan = r.scan || {};
  const currentHtml = current.matched
    ? `<div class="strategy-match yes"><b>● 当前满足入场条件</b><span>综合 ${current.values?.score ?? "—"} · 趋势 ${current.values?.trend ?? "—"} · 动量 ${current.values?.momentum ?? "—"} · 风险 ${current.values?.risk ?? "—"}</span></div>`
    : `<div class="strategy-match no"><b>○ 当前未触发</b><span>${esc((current.failed || []).join(" · ") || "条件不足")}</span></div>`;

  const foldRows = (r.folds || []).map((x) => `<div class="strategy-fold">
    <span>${esc(x.label)}</span><b class="${strategyMetricClass(x.totalReturn)}">${strategyPct(x.totalReturn, true)}</b><em>${x.trades ?? 0}笔 · 回撤${strategyPct(x.maxDrawdown)}</em>
  </div>`).join("") || '<div class="note">历史长度不足，暂不能分段验证</div>';

  const scanRows = (scan.top || []).slice(0, 6).map((x, i) => `<div class="strategy-scan-row">
    <span class="rank">${i + 1}</span><span>S≥${x.entryScore} / 风险≤${x.maxRisk} / ${x.maxHoldDays}日</span>
    <b class="${strategyMetricClass(x.totalReturn)}">${strategyPct(x.totalReturn, true)}</b><em>DD ${strategyPct(x.maxDrawdown)}</em>
  </div>`).join("");

  const tradeRows = (r.trades || []).slice(-8).reverse().map((t) => `<tr>
    <td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td class="${strategyMetricClass(t.returnPct)}">${strategyPct(t.returnPct, true)}</td><td>${t.holdDays}</td><td>${esc(t.reason)}</td>
  </tr>`).join("") || '<tr><td colspan="5" class="note">样本内没有产生交易</td></tr>';

  const robustness = scan.neighborhoodPositivePct;
  const robustLabel = Number.isFinite(robustness) ? (robustness >= 70 ? "较稳健" : robustness >= 50 ? "一般" : "脆弱") : "未知";
  const robustClass = Number.isFinite(robustness) ? (robustness >= 70 ? "down" : robustness < 50 ? "up" : "dim") : "dim";
  const viewMode=state.strategyMode==="ai"?"ai":((r.mode||state.strategyMode)==="manual"?"manual":"smart");
  const aiMode=viewMode==="ai";
  const smartMode=viewMode==="smart";
  const modeSwitch=`<div class="strategy-mode-switch"><button class="${smartMode?"active":""}" data-strategy-mode="smart">智能推荐</button><button class="${viewMode==="manual"?"active":""}" data-strategy-mode="manual">手动高级</button><button class="${aiMode?"active":""}" data-strategy-mode="ai">AI策略</button></div>`;

  if(aiMode){
    const preset=(r.presets||[]).find(x=>x.id===c.presetId);
    body.innerHTML=`
      <div class="panel-title">策略实验室 <span class="note">v1.9 · AI决策支持</span></div>
      ${modeSwitch}
      ${localAiCardHtml(r)}
      ${strategyMonitorHtml(r)}
      <details class="card local-ai-baseline"><summary>AI使用的规则安全基线与历史验证</summary>
        ${currentHtml}
        <div class="strategy-diagnostics">
          <div><span>基线策略</span><b>${esc(preset?.name||c.presetId||"—")}</b></div>
          <div><span>历史收益</span><b class="${strategyMetricClass(m.totalReturn)}">${strategyPct(m.totalReturn,true)}</b></div>
          <div><span>最大回撤</span><b>${strategyPct(m.maxDrawdown)}</b></div>
          <div><span>历史交易</span><b>${m.trades??0}</b></div>
          <div><span>规则入场分</span><b>${strategyNum(c.entryScore)}</b></div>
          <div><span>规则风险上限</span><b>${strategyNum(c.maxRisk)}</b></div>
        </div>
        <div class="note">AI只能在这份基线之上生成有时效的临时快照；预测过期、可信度不足或AI关闭后，监控自动退回该基线。</div>
      </details>`;
    body.querySelectorAll("[data-strategy-mode]").forEach((b)=>b.onclick=()=>{
      const mode=b.dataset.strategyMode;
      if(mode==="smart"){state.strategyMode="smart";renderStrategy({mode:"smart",profile:state.strategyProfile});}
      else if(mode==="manual"){state.strategyMode="manual";renderStrategyResult({...r,mode:"manual"});}
      else{state.strategyMode="ai";renderStrategyResult(r);}
    });
    bindStrategyMonitorActions(r);
    bindLocalAiActions(r);
    return;
  }

  body.innerHTML = `
    <div class="panel-title">策略实验室 <span class="note">v1.9 · ${r.historyBars || r.range?.bars || "—"}根日K${r.cached ? " · 缓存" : ""}</span></div>
    ${modeSwitch}
    ${smartMode?smartStrategyHtml(r):manualStrategyHtml(r)}
    ${strategyMonitorHtml(r)}
    ${currentHtml}

    <div class="strategy-metrics">
      <div><span>策略收益</span><b class="${strategyMetricClass(m.totalReturn)}">${strategyPct(m.totalReturn, true)}</b></div>
      <div><span>超额收益</span><b class="${strategyMetricClass(m.excessReturn)}">${strategyPct(m.excessReturn, true)}</b></div>
      <div><span>最大回撤</span><b class="${strategyMetricClass(m.maxDrawdown, true)}">${strategyPct(m.maxDrawdown)}</b></div>
      <div><span>胜率</span><b>${m.winRate == null ? "—" : m.winRate.toFixed(1) + "%"}</b></div>
      <div><span>交易次数</span><b>${m.trades ?? 0}</b></div>
      <div><span>Sharpe</span><b>${strategyNum(m.sharpe,2)}</b></div>
      <div><span>盈亏比</span><b>${strategyNum(m.profitFactor,2)}</b></div>
      <div><span>仓位占用</span><b>${m.exposure == null ? "—" : m.exposure.toFixed(1) + "%"}</b></div>
    </div>

    <div class="card">
      <span class="card-title">权益曲线 · 起点=1.00</span>
      <canvas id="strategy-equity" class="strategy-equity"></canvas>
      <div class="kv-row"><span>买入并持有基准</span><b class="${strategyMetricClass(m.benchmarkReturn)}">${strategyPct(m.benchmarkReturn, true)}</b></div>
      <div class="kv-row"><span>样本范围</span><b>${esc(r.range?.start || "—")} → ${esc(r.range?.end || "—")}</b></div>
    </div>

    <div class="card">
      <span class="card-title">稳定性检查</span>
      <div class="kv-row"><span>邻近参数盈利比例</span><b class="${robustClass}">${robustness == null ? "—" : robustness.toFixed(1) + "%"} · ${robustLabel}</b></div>
      <div class="kv-row"><span>全部扫描盈利比例</span><b>${scan.positivePct == null ? "—" : scan.positivePct.toFixed(1) + "%"}</b></div>
      <div class="kv-row"><span>分段盈利一致性</span><b>${r.foldConsistency == null ? "—" : r.foldConsistency.toFixed(1) + "%"}</b></div>
      <div class="kv-row"><span>当前市场匹配度</span><b>${r.regimeFit?.score ?? "—"}/100</b></div>
      <div class="note">${esc(r.regimeFit?.note || "")}</div>
    </div>

    <div class="card"><span class="card-title">分段验证</span>${foldRows}</div>
    <div class="card"><span class="card-title">参数扫描 TOP</span>${scanRows || '<div class="note">暂无扫描结果</div>'}<div class="note">TOP 仅用于观察稳定区域；智能推荐额外使用样本外和样本量惩罚，不直接选择历史最高收益。</div></div>
    <div class="card"><span class="card-title">最近交易</span><div class="strategy-table-wrap"><table class="strategy-trades"><thead><tr><th>买入</th><th>卖出</th><th>收益</th><th>天</th><th>原因</th></tr></thead><tbody>${tradeRows}</tbody></table></div></div>
    <div class="note strategy-method">执行：${esc(r.methodology?.execution || "")} · ${esc(r.methodology?.costs || "")}。${smartMode?esc(r.methodology?.recommendation||""):""} 回测仅用于研究，不代表未来收益。</div>`;

  body.querySelectorAll("[data-strategy-mode]").forEach((b)=>b.onclick=()=>{
    const mode=b.dataset.strategyMode;
    if(mode==="smart") { state.strategyMode="smart"; renderStrategy({mode:"smart",profile:state.strategyProfile}); }
    else if(mode==="manual") { state.strategyMode="manual"; renderStrategyResult({...r,mode:"manual"}); }
    else { state.strategyMode="ai"; renderStrategyResult(r); }
  });
  body.querySelectorAll("[data-strategy-profile]").forEach((b)=>b.onclick=()=>{
    state.strategyMode="smart"; state.strategyProfile=b.dataset.strategyProfile||"balanced";
    renderStrategy({mode:"smart",profile:state.strategyProfile});
  });
  const refresh=$("#strategy-smart-refresh"); if(refresh) refresh.onclick=()=>renderStrategy({mode:"smart",profile:state.strategyProfile,refreshKey:Date.now()});
  const toManual=$("#strategy-to-manual"); if(toManual) toManual.onclick=()=>{state.strategyMode="manual";renderStrategyResult({...r,mode:"manual"});};
  const manualSwitch=body.querySelector(".strategy-switch-manual"); if(manualSwitch) manualSwitch.onclick=()=>{state.strategyMode="manual";renderStrategyResult({...r,mode:"manual"});};
  const presetSel=$("#strategy-preset"); if(presetSel) presetSel.onchange=(e)=>{state.strategyPreset=e.target.value;renderStrategy({mode:"manual",presetId:state.strategyPreset});};
  const run=$("#strategy-run"); if(run) run.onclick=()=>{
    const cfg={mode:"manual",presetId:$("#strategy-preset").value,entryScore:Number($("#st-entry").value),maxRisk:Number($("#st-risk").value),stopLossPct:Number($("#st-stop").value),takeProfitPct:Number($("#st-take").value),trailingStopPct:Number($("#st-trail").value),maxHoldDays:Number($("#st-hold").value)};
    state.strategyMode="manual";state.strategyPreset=cfg.presetId;renderStrategy(cfg);
  };
  bindStrategyMonitorActions(r);
  drawStrategyEquity(r.equityCurve || []);
}


async function updateMonitorState(renderModal=false) {
  try {
    state.monitorState=await api.getMonitorState();
    const h=await api.getAlertHistory(120); state.alertHistory=h.items||[]; state.monitorState.unreadCount=h.unreadCount??state.monitorState.unreadCount??0;
    updateMonitorBadge();
    if(renderModal) renderMonitorModal();
  } catch {}
}
function updateMonitorBadge(){
  const b=$("#monitor-badge"); if(!b)return;
  const n=Number(state.monitorState?.unreadCount)||0; b.hidden=n<=0; b.textContent=n>99?"99+":String(n);
}
function monitorPayloadFromStrategy(r, extra={}) {
  const preset=(r.presets||[]).find((x)=>x.id===r.config?.presetId);
  const viewMode=state.strategyMode==="ai"?"ai":((r.mode||state.strategyMode)==="manual"?"manual":"smart");
  return {
    enabled:true,
    name:$("#detail-name")?.textContent||state.activeCode,
    mode:viewMode,
    profile:r.selectedProfile||state.strategyProfile||"balanced",
    strategyName:`${viewMode==="ai"?"AI动态 · ":""}${preset?.name||r.config?.presetId||"策略"}${viewMode==="smart"?` · ${({conservative:"稳健",balanced:"均衡",aggressive:"积极"})[r.selectedProfile||state.strategyProfile]||"均衡"}`:""}`,
    config:r.config||{},
    aiAssist:viewMode==="ai",
    aiAdaptive:viewMode==="ai"&&state.localAi?.adaptiveStrategy!==false,
    aiMinConfidence:Number(state.localAi?.minDecisionConfidence)||55,
    aiMaxAgeMin:Number(state.localAi?.maxPredictionAgeMin)||120,
    ...extra,
  };
}
function bindStrategyMonitorActions(r){
  const enable=$("#strategy-monitor-enable"); if(enable) enable.onclick=async()=>{
    const payload=monitorPayloadFromStrategy(r,{notifyTypes:{nearEntry:$("#st-mon-near")?.checked!==false,entry:$("#st-mon-entry")?.checked!==false,risk:$("#st-mon-risk")?.checked!==false,exit:$("#st-mon-exit")?.checked!==false,event:$("#st-mon-event")?.checked===true,ai:$("#st-mon-ai")?.checked!==false},autoPaperPosition:$("#st-mon-paper")?.checked!==false,confirmIntraday:$("#st-mon-intraday")?.checked!==false,nearEntryPct:80});
    const x=await api.setStrategyMonitor(state.activeCode,payload); if(!x.ok){toast("risk",x.error||"启用失败");return;} state.monitorState=x.state; updateMonitorBadge(); toast("buy","策略监控已启用"); renderStrategyResult(r);
  };
  const check=$("#strategy-monitor-check"); if(check) check.onclick=async()=>{check.disabled=true;await api.checkMonitorsNow();await updateMonitorState();check.disabled=false;renderStrategyResult(r);};
  const pos=$("#strategy-monitor-position"); if(pos) pos.onclick=()=>openPositionModal(state.activeCode);
  const sync=$("#strategy-monitor-sync"); if(sync) sync.onclick=async()=>{const mon=currentMonitor();const x=await api.setStrategyMonitor(state.activeCode,monitorPayloadFromStrategy(r,{notifyTypes:mon?.notifyTypes,position:mon?.position,autoPaperPosition:mon?.autoPaperPosition,confirmIntraday:mon?.confirmIntraday,nearEntryPct:mon?.nearEntryPct}));state.monitorState=x.state||state.monitorState;toast("",state.strategyMode==="ai"?"监控已同步为AI动态模式":"监控参数已同步为当前策略");renderStrategyResult(r);};
  const disable=$("#strategy-monitor-disable"); if(disable) disable.onclick=async()=>{const mon=currentMonitor();const enable=mon?.enabled===false;const x=await api.setStrategyMonitor(state.activeCode,{enabled:enable});state.monitorState=x.state||state.monitorState;toast("",enable?"该股票策略监控已恢复":"该股票策略监控已暂停");renderStrategyResult(r);};
}
function monitorTime(t){try{return new Date(t).toLocaleString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});}catch{return "—";}}
function renderMonitorModal(){
  const ms=state.monitorState||{}; const items=ms.items||[]; const alerts=state.alertHistory||[];
  $("#monitor-summary").innerHTML=`<div><span>后台监控</span><b>${ms.enabled!==false?"运行中":"已关闭"}</b></div><div><span>监控股票</span><b>${ms.activeCount||0}</b></div><div><span>检查间隔</span><b>${Math.round((ms.intervalMs||15000)/1000)}秒</b></div><div><span>未读提醒</span><b>${ms.unreadCount||0}</b></div>`;
  $("#monitor-list").innerHTML=items.length?items.map((m)=>{const rt=m.runtime||{},pos=m.position;return `<div class="monitor-item" data-code="${esc(m.code)}"><div class="monitor-item-head"><strong>${esc(m.name||m.code)}</strong><code>${esc(m.code)}</code><span class="monitor-stage ${esc(rt.stage||"idle")}">${m.enabled===false?"已暂停":esc(monitorStageLabel(rt.stage))}</span></div><div class="monitor-item-body"><span>${esc(m.strategyName||"策略监控")}</span><em>${rt.checkedAt?`检查 ${esc(monitorTime(rt.checkedAt))}`:"尚未检查"}</em><span>${esc(rt.reason||"等待后台监控")}</span><em>${rt.completion==null?"":`完成 ${strategyNum(rt.completion)}%`}</em>${pos?`<span>${pos.kind==="actual"?"实际持仓":"模拟跟踪"} · 成本 ${strategyNum(pos.entryPrice,2)}</span><em>${rt.levels?.effectiveStop?`动态止损 ${strategyNum(rt.levels.effectiveStop,2)}`:""}</em>`:""}<div class="monitor-actions"><button class="btn mini" data-mon-action="open">查看股票</button><button class="btn mini secondary" data-mon-action="position">${pos?"修改持仓":"记录持仓"}</button><button class="btn mini ghost" data-mon-action="toggle">${m.enabled===false?"恢复":"暂停"}</button><button class="btn mini ghost" data-mon-action="remove">删除监控</button></div></div></div>`}).join(""):'<div class="note">还没有启用策略监控。进入“策略”页，把智能推荐或手动规则加入监控。</div>';
  $("#monitor-alert-list").innerHTML=alerts.length?alerts.slice(0,80).map((a)=>`<div class="monitor-alert-item ${a.read?"":"unread"}" data-alert-code="${esc(a.code)}"><div class="monitor-alert-head"><strong>${esc(a.title||"提醒")} · ${esc(a.name||a.code)}</strong><time>${esc(monitorTime(a.time))}</time></div><p>${esc(a.message||"")}</p>${a.details?.length?`<div class="monitor-alert-details">${a.details.map(esc).join(" · ")}</div>`:""}</div>`).join(""):'<div class="note">暂无提醒历史</div>';
  $("#monitor-list").querySelectorAll("[data-mon-action]").forEach((b)=>b.onclick=async(e)=>{e.stopPropagation();const code=b.closest(".monitor-item")?.dataset.code;const m=(state.monitorState.items||[]).find(x=>x.code===code);if(!code)return;const a=b.dataset.monAction;if(a==="open"){$("#monitor-modal").hidden=true;selectStock(code);}else if(a==="position")openPositionModal(code);else if(a==="toggle"){await api.setStrategyMonitor(code,{enabled:m?.enabled===false});await updateMonitorState(true);}else if(a==="remove"){await api.setStrategyMonitor(code,{remove:true});await updateMonitorState(true);}});
  $("#monitor-alert-list").querySelectorAll("[data-alert-code]").forEach((el)=>el.onclick=()=>{const code=el.dataset.alertCode;if(code){$("#monitor-modal").hidden=true;selectStock(code);}});
}
async function openMonitorModal(){
  $("#monitor-modal").hidden=false; await updateMonitorState(true);
}
function openPositionModal(code){
  state.positionCode=code; const m=currentMonitor(code); $("#position-stock").textContent=`${m?.name||code} · ${code}`; $("#position-price").value=m?.position?.entryPrice??state.quotes.find(x=>x.code===code)?.price??""; $("#position-date").value=m?.position?.entryDate||new Date().toISOString().slice(0,10); $("#position-modal").hidden=false;
}
async function savePositionModal(){
  const code=state.positionCode,price=Number($("#position-price").value),date=$("#position-date").value;if(!code||!(price>0)){toast("risk","请输入有效成本价");return;}const x=await api.setMonitorPosition(code,{kind:"actual",entryPrice:price,entryDate:date,highestPrice:price});if(!x.ok){toast("risk",x.error||"保存失败");return;}state.monitorState=x.state;$("#position-modal").hidden=true;toast("","持仓已记录，后续会监控止损/止盈/退出条件");if(state.panel==="strategy"&&code===state.activeCode&&state.strategyResult)renderStrategyResult(state.strategyResult);if(!$("#monitor-modal").hidden)await updateMonitorState(true);
}

function drawStrategyEquity(curve) {
  const canvas = $("#strategy-equity");
  if (!canvas || !curve.length) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height, pad = 8;
  const vals = curve.map((x) => Number(x.equity)).filter(Number.isFinite);
  if (vals.length < 2) return;
  let lo = Math.min(...vals, 1), hi = Math.max(...vals, 1);
  if (hi - lo < 0.02) { hi += 0.01; lo -= 0.01; }
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#6ea8ff";
  const grid = css.getPropertyValue("--glass-border").trim() || "rgba(255,255,255,.12)";
  ctx.clearRect(0, 0, w, h);
  const yOf = (v) => pad + (hi - v) / (hi - lo) * (h - pad * 2);
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  const y1 = yOf(1);
  ctx.beginPath(); ctx.moveTo(pad, y1); ctx.lineTo(w - pad, y1); ctx.stroke();
  ctx.strokeStyle = accent; ctx.lineWidth = 2;
  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = pad + i / Math.max(1, curve.length - 1) * (w - pad * 2);
    const y = yOf(Number(p.equity));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}


// ================= v1.3 综合研报 / AI =================
let reportLoadToken = 0;
async function renderReport(force = false) {
  const body = $("#panel-body");
  const code = state.activeCode;
  const token = ++reportLoadToken;
  if (!code) { body.innerHTML = '<div class="empty-tip">先选择一只股票</div>'; return; }
  body.innerHTML = '<div class="loading">⏳ 汇总关联报价、交易、资金、资讯、指标与回测…</div>';
  let r;
  try { r = await api.getResearchReport(code, force); }
  catch (e) {
    if (token === reportLoadToken && code === state.activeCode && state.panel === "report") body.innerHTML = `<div class="error-box">研报生成失败：${esc(e?.message || String(e))}</div>`;
    return;
  }
  if (token !== reportLoadToken || code !== state.activeCode) return;
  if (r.error) { if (state.panel === "report") body.innerHTML = `<div class="error-box">${esc(r.error)}</div>`; return; }
  state.researchResult = r;
  if (state.panel === "report") renderReportResult();
  hydrateReportExtras(code, token);
}

async function hydrateReportExtras(code, token) {
  const [estimateResult, historyResult] = await Promise.allSettled([
    api.estimateAiReport(code),
    api.getAiReportHistory(code, 30),
  ]);
  if (token !== reportLoadToken || code !== state.activeCode) return;
  if (estimateResult.status === "fulfilled") {
    const e = estimateResult.value;
    state.aiEstimate = e.estimate || null;
    state.llmState = e.llm || state.llmState;
  }
  // v1.3.1：研报自动持久化。刷新页面/重启后自动恢复当前股票最近一次 AI 报告，同时保留手动历史恢复入口。
  if (historyResult.status === "fulfilled") {
    const h = historyResult.value;
    state.aiHistory = h?.rows || [];
    if (!state.aiReport && state.aiHistory.length) {
      try {
        const saved = await api.getAiReportEntry(state.aiHistory[0].id);
        if (token !== reportLoadToken || code !== state.activeCode) return;
        if (saved?.archive) {
          state.aiArchive = saved.archive;
          state.aiReport = { ...saved.archive.result, archiveId: saved.archive.id, archiveMeta: state.aiHistory[0] };
        }
      } catch {}
    }
  }
  if (state.panel === "report") renderReportResult();
}

function reportSubTabs() {
  const tabs = [["overview","综合"],["quotes","关联"],["trade","交易"],["funds","资金"],["news","资讯"],["global","外部研究"],["ai","AI"]];
  return `<div class="report-tabs">${tabs.map(([k,v]) => `<button data-rpt="${k}" class="${state.reportTab===k?"active":""}">${v}</button>`).join("")}</div>`;
}
function fmtMoneyYi(v) {
  if (v == null || String(v).trim() === "" || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n !== 0 && Math.abs(n) < 0.005) return `${n > 0 ? "+" : "−"}<0.01亿`;
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}亿`;
}
function newsCards(rows) {
  if (!(rows || []).length) return '<div class="note">暂无可用资讯摘要</div>';
  return rows.map((n) => `<div class="news-card"><b>${esc(n.title || "资讯")}</b>${n.source||n.date||n.category?`<small>${esc([n.source,n.date,n.category].filter(Boolean).join(" · "))}</small>`:""}<p>${esc(n.body || "")}</p>${n.url ? `<button class="link-btn" data-url="${esc(n.url)}">打开来源</button>` : ""}</div>`).join("");
}
function researchModeLabel(v){return ({fast:"快速",standard:"标准",deep:"深度"})[v]||v||"标准";}
function researchStatusLabel(v){return ({completed:"已完成",budget_exhausted:"达到预算",no_new_evidence:"无新增证据",planner_error:"规划异常",error:"研究失败"})[v]||v||"待运行";}
function currentResearchAgent(){
  const snap=state.aiArchive?.inputSnapshot?.externalResearch;
  const code=state.aiArchive?.code||state.aiArchive?.stock?.code;
  return snap?.agentVersion && (!code || code===state.activeCode) ? snap : null;
}
function researchAgentHtml(agent,{compact=false}={}){
  if(!agent)return `<div class="card research-agent-empty"><span class="card-title">LLM 自主外部研究 Agent</span><p>开放式资讯不再由 StockDesk 预设关键词采集。生成 AI 研报后，模型会根据当前股票与证据缺口自主决定查什么、用什么语言、是否继续追查和何时停止。</p><div class="note">结构化海外行情仍由程序采集；新闻、政策、海外公司经营变化和产业链事件由 Agent 按需研究。</div></div>`;
  const u=agent.usage||{}, rounds=agent.rounds||[], sources=agent.sources||[];
  const head=`<div class="research-agent-head"><div><span>模式</span><b>${esc(researchModeLabel(agent.mode))}</b></div><div><span>轮次</span><b>${u.rounds??rounds.length}</b></div><div><span>查询</span><b>${u.queries??"—"}</b></div><div><span>资料</span><b>${u.sources??sources.length}</b></div><div><span>网页</span><b>${u.pages??"—"}</b></div><div><span>状态</span><b>${esc(researchStatusLabel(agent.status))}</b></div></div>`;
  const roundHtml=rounds.map(r=>`<div class="research-round"><div class="research-round-head"><b>第 ${r.round} 轮 · ${esc(r.plan?.focus||"自主研究")}</b><span>${r.newSources??r.sourceIds?.length??0} 条新资料</span></div>${r.plan?.reason?`<p>${esc(r.plan.reason)}</p>`:""}<div class="research-query-list">${(r.plan?.queries||[]).map(q=>`<div class="research-query"><b>${esc(q.query||q)}</b>${q.purpose?`<small>${esc(q.purpose)}</small>`:""}${q.priority?`<em>${esc(q.priority)}</em>`:""}</div>`).join("")||'<div class="note">本轮没有继续检索</div>'}</div></div>`).join("");
  const sourceHtml=sources.slice(0,compact?12:40).map(r=>`<div class="research-source"><div class="global-news-head"><b>${esc(r.id||"")} · ${esc(r.title||r.query||"外部资料")}</b><span class="source-grade grade-${esc(String(r.sourceGrade||"D").toLowerCase())}">${esc(r.sourceGrade||"D")} · ${esc(r.sourceLabel||"普通网页")}</span></div><small>${esc(r.purpose||r.query||"")}</small><p>${esc(r.snippet||r.page?.slice(0,360)||"")}</p>${r.url?`<button class="link-btn" data-url="${esc(r.url)}">打开来源</button>`:""}</div>`).join("");
  const unresolved=(agent.unresolvedQuestions||[]).map(x=>`<div class="note">• ${esc(x)}</div>`).join("");
  return `<div class="card research-agent-card"><span class="card-title">LLM 自主外部研究 Agent <em>可审计</em></span>${head}<div class="note">停止原因：${esc(agent.stopReason||"—")}</div>${unresolved?`<details class="ai-detail-fold"><summary>仍待确认 · ${(agent.unresolvedQuestions||[]).length}</summary>${unresolved}</details>`:""}<details class="ai-detail-fold" ${compact?"":"open"}><summary>研究过程 · ${rounds.length} 轮</summary>${roundHtml||'<div class="note">暂无研究轮次</div>'}</details><details class="ai-detail-fold"><summary>取得资料 · ${sources.length}</summary>${sourceHtml||'<div class="note">本次未取得有效外部资料</div>'}</details><div class="note">${esc(agent.securityNotice||"")}</div></div>`;
}
function renderReportResult() {
  const r = state.researchResult, body = $("#panel-body");
  if (state.reportTab === "risk") state.reportTab = "overview";
  if (!r) return;
  const ev = r.evidence || {}, ov = r.overview || {};
  let content = "";
  if (state.reportTab === "overview") {
    content = `<div class="report-hero">
      <div><span>现价</span><b>${ov.price ?? "—"}</b></div><div><span>当日</span><b class="${pctCls(ov.changePct)}">${ov.changePct==null?"—":(ov.changePct>0?"+":"")+ov.changePct+"%"}</b></div>
      <div><span>基础技术</span><b>${ov.technicalScore ?? "—"}</b></div><div><span>融合技术</span><b>${ov.technicalCompositeScore ?? "—"}</b></div>
    </div>
    ${r.technical?.advancedIndicatorAnalysis?`<div class="card"><span class="card-title">22类扩展技术指标 · 因子族聚合</span><div class="kv-row"><span>方向综合</span><b>${r.technical.advancedIndicatorAnalysis.compositeScore>0?"+":""}${r.technical.advancedIndicatorAnalysis.compositeScore}</b></div><div class="kv-row"><span>过热/波动风险</span><b>${r.technical.advancedIndicatorAnalysis.risk}/100</b></div><div class="advanced-family-grid">${Object.values(r.technical.advancedIndicatorAnalysis.families||{}).filter(x=>x.count).map(x=>`<div><span>${esc(x.label)} · ${x.count}项</span><b>${x.score>0?"+":""}${x.score}</b></div>`).join("")}</div><div class="note">${esc(r.technical.advancedIndicatorAnalysis.methodology||"")}</div></div>`:""}
    <div class="card"><span class="card-title">支持证据</span>${(ev.positive||[]).map(x=>`<div class="evidence-row pos">＋ ${esc(x)}</div>`).join("")||'<div class="note">暂无明显支持证据</div>'}</div>
    <div class="card"><span class="card-title">反向/风险证据</span>${(ev.negative||[]).map(x=>`<div class="evidence-row neg">－ ${esc(x)}</div>`).join("")}${(ev.risks||[]).map(x=>`<div class="evidence-row risk">⚠ ${esc(x)}</div>`).join("")||'<div class="note">暂无额外风险条目</div>'}</div>
    <div class="card"><span class="card-title">数据缺口</span>${(ev.dataGaps||[]).map(x=>`<div class="note">• ${esc(x)}</div>`).join("")||'<div class="note">核心模块均有数据</div>'}</div>
    <div class="card"><span class="card-title">数据口径检查 · ${esc(r.dataQualityChecks?.status||"ok")}</span>${(r.dataQualityChecks?.checks||[]).map(x=>`<div class="evidence-row ${x.severity==="error"?"risk":""}">${x.severity==="error"?"⚠":"•"} ${esc(x.message)}</div>`).join("")||'<div class="note">未发现已知字段/单位口径异常。</div>'}<details class="ai-detail-fold"><summary>查看分析口径说明</summary>${Object.values(r.dataQualityChecks?.semantics||{}).map(x=>`<div class="note">• ${esc(x)}</div>`).join("")}</details></div>`;
  } else if (state.reportTab === "quotes") {
    const b = r.relatedQuotes?.board, peers = r.relatedQuotes?.peers || [];
    content = `<div class="card"><span class="card-title">所属板块</span><div class="kv-row"><span>${esc(b?.name||ov.industry||"—")}</span><b class="${pctCls(b?.changePct)}">${b?.changePct==null?"—":b.changePct+"%"}</b></div><div class="kv-row"><span>板块主力</span><b>${fmtMoneyYi(b?.mainFlowYi)}</b></div><div class="kv-row"><span>成分涨/跌</span><b>${r.relatedQuotes?.breadth?.up??"—"} / ${r.relatedQuotes?.breadth?.down??"—"}</b></div></div>
    <div class="card"><span class="card-title">关联报价 / 同业</span><div class="mini-table">${peers.map(x=>`<div><span>${esc(x.name)} <em>${esc(x.code)}</em></span><b class="${pctCls(x.changePct)}">${x.changePct==null?"—":(x.changePct>0?"+":"")+x.changePct+"%"}</b><small>PE ${x.peTtm??"—"}</small></div>`).join("")||'<div class="note">暂无同业数据</div>'}</div></div>`;
  } else if (state.reportTab === "trade") {
    const t=r.transaction||{}, rows=t.lhbRecent30d||[], hist=t.lhbHistory||[];
    content=`<div class="card"><span class="card-title">交易查询</span><div class="kv-row"><span>换手率</span><b>${t.turnover??"—"}%</b></div><div class="kv-row"><span>量比</span><b>${t.volumeRatio??"—"}</b></div><div class="kv-row"><span>成交额</span><b>${t.amountYi??"—"}亿</b></div></div><div class="card"><span class="card-title">近30日龙虎榜</span>${rows.map(x=>`<div class="lhb-row"><b>${esc(x.tradeDate)}</b><span>${esc(x.explanation||"")}</span><em class="${pctCls(x.netYi)}">净额 ${fmtMoneyYi(x.netYi)}</em></div>`).join("")||'<div class="note">近30日无龙虎榜记录</div>'}${hist.length&&!rows.length?`<details class="ai-detail-fold"><summary>查看更早历史记录 · ${hist.length}</summary>${hist.map(x=>`<div class="lhb-row"><b>${esc(x.tradeDate)}</b><span>${esc(x.explanation||"")}</span><em>距今约 ${x.ageDays??"—"} 天</em></div>`).join("")}</details>`:""}<div class="note">${esc(t.note||"")}</div></div>`;
  } else if (state.reportTab === "funds") {
    const f=r.capitalFlow||{};
    const hasFunds=(f.rows||[]).some(x=>x.mainNetYi!=null && Number.isFinite(Number(x.mainNetYi)));
    const total=hasFunds && f.status!=="unavailable" ? f.main10dNetYi : null;
    content=`<div class="card"><span class="card-title">${f.status==="partial"?`已获取 ${f.validDays} 日主力合计`:"近10日主力合计"}</span><div class="big-number ${pctCls(total)}">${fmtMoneyYi(total)}</div><div class="note">${esc(f.message||(!hasFunds?"资金流暂未获取，请重新采集":""))}</div>${f.latestDate?`<div class="note">${esc(f.source||"")} · 截至 ${esc(f.latestDate)}</div>`:""}</div><div class="card"><span class="card-title">每日资金流</span>${(f.rows||[]).slice().reverse().map(x=>`<div class="kv-row"><span>${esc(x.date)} · 涨跌 ${x.changePct??"—"}%</span><b class="${pctCls(x.mainNetYi)}">${fmtMoneyYi(x.mainNetYi)}</b></div>`).join("")||'<div class="note">暂无资金流数据</div>'}</div>`;
  } else if (state.reportTab === "news") {
    content=`<div class="card"><span class="card-title">企业公告与动态</span>${newsCards(r.news?.general)}</div><div class="card"><span class="card-title">企业财报与业绩披露</span>${newsCards(r.news?.sector)}</div><div class="note">已按股票代码精确匹配法定披露公告${Number.isFinite(Number(r.news?.officialAnnouncementCount))?`（共 ${Number(r.news.officialAnnouncementCount)} 条）`:""}；网页资讯仍需明确提及所选企业名称或代码。</div>`;
  } else if (state.reportTab === "global") {
    const g=r.globalContext||{}; const assets=g.assets||[]; const agent=currentResearchAgent();
    const assetRows=assets.map(x=>`<div class="global-asset-row"><div><b>${esc(x.name||x.symbol||"外部资产")}</b><small>${esc(x.symbol||"")} · ${esc(x.country||"")} · ${esc(x.type||"")}</small></div><span>${x.price??"—"}</span><em class="${pctCls(x.change5d)}">5日 ${x.change5d==null?"—":(x.change5d>0?"+":"")+x.change5d+"%"}</em><small>20日 ${x.change20d==null?"—":(x.change20d>0?"+":"")+x.change20d+"%"}</small></div>`).join("")||'<div class="note">暂无可用海外资产行情</div>';
    content=`<div class="report-hero"><div><span>结构化映射</span><b>${esc(g.mapping?.profileLabel||"通用市场")}</b></div><div><span>外部市场</span><b class="${pctCls(g.externalImpactScore)}">${g.externalImpactScore==null?"—":(g.externalImpactScore>0?"+":"")+g.externalImpactScore}</b></div><div><span>Agent</span><b>${esc(agent?researchStatusLabel(agent.status):"待生成AI研报")}</b></div><div><span>资料</span><b>${agent?.sources?.length??0}</b></div></div>
    <div class="card"><span class="card-title">确定性外部市场映射</span><p>${esc(g.mapping?.method||"")}</p><div class="note">匹配：${esc((g.mapping?.matchedKeywords||[]).join(" / ")||"通用宏观映射")}</div></div>
    <div class="card"><span class="card-title">海外资产 / 商品 / 汇率利率</span>${assetRows}<div class="note">这些是程序采集的结构化市场数据；开放式新闻与政策不会再由程序预设搜索。</div></div>
    ${researchAgentHtml(agent)}
    <details class="card"><summary>外部研究方法与数据缺口</summary><div class="note">${esc(g.methodology?.assetScore||"")}</div><div class="note">${esc(g.methodology?.openResearch||"")}</div>${(g.dataGaps||[]).map(x=>`<div class="evidence-row risk">• ${esc(x)}</div>`).join("")||'<div class="note">当前结构化外部市场未记录明显数据缺口</div>'}</details>`;
  } else if (state.reportTab === "ai") {
    content = renderAiSection();
  }
  body.innerHTML = `<div class="panel-title">综合研报 <span class="note">v1.9.3${r.cached?" · 缓存":""}</span><button class="tiny-action" id="report-refresh">重新采集</button></div>${reportSubTabs()}${content}<div class="note report-disclaimer">${esc(r.disclaimer||"")}</div>`;
  body.querySelectorAll(".report-tabs button").forEach(b=>b.onclick=()=>{state.reportTab=b.dataset.rpt;api.setSettings({lastReportTab:state.reportTab});renderReportResult();});
  body.querySelectorAll(".link-btn[data-url]").forEach(b=>b.onclick=()=>api.openExternal(b.dataset.url));
  const rf=$("#report-refresh"); if(rf) rf.onclick=()=>renderReport(true);
  const gen=$("#ai-generate"); if(gen) gen.onclick=runAiReport;
  const cfg=$("#ai-configure"); if(cfg) cfg.onclick=openLlmModal;
  const rawRoot=$("#ai-open-raw-root"); if(rawRoot) rawRoot.onclick=()=>api.openLlmRawOutputDir(null);
  body.querySelectorAll("[data-ai-restore]").forEach((b)=>b.onclick=()=>restoreAiReport(b.dataset.aiRestore));
  body.querySelectorAll("[data-ai-export]").forEach((b)=>b.onclick=()=>exportAiReport(b.dataset.aiExport));
  const rawBtn=body.querySelector("[data-ai-open-raw]"); if(rawBtn) rawBtn.onclick=()=>openAiRawOutputDir();
  body.querySelectorAll("[data-ai-delete]").forEach((b)=>b.onclick=()=>deleteAiReport(b.dataset.aiDelete));
}

const AI_SECTION_META = {
  market_and_related: ["市场与关联报价", "◫"], technical: ["技术面与量价", "⌁"], fundamentals: ["基本面与估值", "▦"],
  capital_and_trading: ["资金与交易", "↕"], news_and_sector: ["资讯与板块", "◎"], global_context: ["全球关联环境", "◉"], backtest: ["历史回测", "⟳"], risk: ["风险提示", "⚠"],
};
const EVIDENCE_LABELS={
  "technical.factors":"基础技术因子","technical.validation":"历史信号验证","technical.advancedIndicatorAnalysis":"22类扩展指标聚合","capitalFlow.main10dNetYi":"近10日主力资金净额","capitalFlow.rows":"每日主力资金流","relatedQuotes.board":"所属行业板块","relatedQuotes.breadth":"板块涨跌宽度","relatedQuotes.peers":"同行关联报价","transaction.turnover":"换手率","transaction.volumeRatio":"量比","transaction.amountYi":"成交额","transaction.lhb":"龙虎榜记录","riskScan":"扫雷结果","research.rows":"机构研报","news.general":"综合资讯","news.sector":"板块资讯","backtest.metrics":"历史回测指标","backtest.currentSignal":"当前策略触发状态","backtest.parameterStability":"参数稳定性","overview.marketRegime":"市场状态","overview.technicalCompositeScore":"融合技术评分","globalContext":"全球关联环境","globalContext.assets":"海外资产/商品/汇率利率","globalContext.policies":"各国政策与监管","globalContext.industryNews":"海外同行/全球行业消息","globalContext.externalImpactScore":"外部环境参考分","fundamentals.features.roe_latest":"最新ROE","fundamentals.features.revenue_latest_yi":"最新营收","fundamentals.features.net_profit_latest_yi":"最新归母净利润","fundamentals.features.pe":"市盈率","fundamentals.features.pb":"市净率"
};
const EVIDENCE_PATH_LABELS={overview:"综合概览",changePct:"涨跌幅",historicalReliability:"历史可靠度",verdict:"基础技术结论",marketRegime:"市场状态",technicalCompositeScore:"融合技术评分",relatedQuotes:"关联报价",peers:"同行股票",board:"所属板块",breadth:"板块宽度",mainFlowYi:"主力资金净额(亿元)",upCount:"上涨家数",downCount:"下跌家数",peTtm:"市盈率TTM",pb:"市净率",technical:"技术分析",factors:"基础技术因子",trend:"趋势",momentum:"动量",volume:"量价",risk:"风险",validation:"历史信号验证",sampleSize:"历史样本数",reliability:"历史可靠度",horizons:"持有周期",hitRate:"历史胜率",indicators:"扩展技术指标",advancedIndicatorAnalysis:"扩展指标聚合",families:"指标族",score:"评分",state:"状态",summary:"摘要",latest:"最新值",trajectory:"曲线轨迹",lines:"曲线",recentCross:"最近交叉",fundamentals:"基本面",features:"基本面特征",basic:"基础财务/估值",methods:"估值模型",dcf:"DCF估值",intrinsic_per_share:"每股内在价值",safety_margin_pct:"安全边际",tv_pct_of_ev:"永续价值占比",sensitivity_table:"敏感性分析表",base_fcf_yi:"基础自由现金流(亿元)",roe_latest:"最新ROE",roe_5y_min:"近5年最低ROE",roe_5y_above_15:"近5年ROE>15%次数",roe_trend_up:"ROE趋势向上",net_profit_growth_latest:"最新净利润增速",revenue_growth_latest:"最新营收增速",gross_margin:"毛利率",pe_quantile_5y:"PE五年分位",peg:"PEG",eps:"每股收益EPS",fcf_margin:"自由现金流率",fcf_positive:"自由现金流为正",lhb_30d_count:"近30日龙虎榜次数",matched_youzi_count:"识别游资席位数",sentiment_heat:"资讯热度",sentiment_positive_pct:"正面资讯占比",has_positive_catalyst:"存在正面催化",has_negative_catalyst:"存在负面催化",vs_peer_avg_pe:"相对同业PE",volatility_1y:"一年波动率",max_drawdown_1y:"一年最大回撤",pct_from_year_high:"距年内高点幅度",roic:"投入资本回报率ROIC",pe:"市盈率",capitalFlow:"资金流向",main10dNetYi:"近10日主力资金净额",rows:"明细",largeNetYi:"大单净额(亿元)",superNetYi:"超大单净额(亿元)",mainPct:"主力净占比",transaction:"交易行为",turnover:"换手率",volumeRatio:"量比",amountYi:"成交额(亿元)",lhb:"龙虎榜",lhbRecent30d:"近30日龙虎榜",lhbHistory:"历史龙虎榜",netYi:"净额(亿元)",d5:"上榜后5日表现",tradeDate:"交易日期",research:"机构研报",total:"数量",rating:"评级",title:"标题",org:"机构",news:"资讯",general:"综合资讯",sector:"板块资讯",securityNotice:"资讯安全说明",backtest:"历史回测",metrics:"回测指标",currentSignal:"当前策略触发",parameterStability:"参数稳定性",foldConsistency:"分段一致性",riskScan:"扫雷结果",globalContext:"全球关联环境",assets:"海外资产",policies:"国家政策",industryNews:"全球行业消息",externalImpactScore:"外部环境参考分",externalImpactLabel:"外部环境判断",mapping:"全球映射",relevance:"相关度",externalResearch:"联网补充研究",analysis:"指标分析",riskScore:"风险评分",evidence:"计算依据",params:"参数"};
function genericEvidenceLabel(path){const fam={trend:"趋势",momentum:"动量",volume:"量价",sentiment:"情绪",volatility:"波动",support:"支撑压力",cost:"成本"};return String(path||"").replace(/\[([^\]]+)\]/g,".$1").split(".").filter(Boolean).map(seg=>/^\d+$/.test(seg)?`第${Number(seg)+1}项`:/^N\d+$/i.test(seg)?`资讯${seg.toUpperCase()}`:fam[seg.toLowerCase()]?`${fam[seg.toLowerCase()]}族`:(EVIDENCE_PATH_LABELS[seg]||String(seg).replace(/_/g," "))).filter((v,i,a)=>v&&v!==a[i-1]).join(" · ")||"软件内部证据";}
function evidenceLabel(path){
  const x=String(path||""); if(/^R\d+$/.test(x))return `外部研究资料 ${x}`; if(/^G\d+$/.test(x))return `旧版全球资料 ${x}`;
  if(EVIDENCE_LABELS[x])return EVIDENCE_LABELS[x];
  const f=x.match(/(?:technical\.)?advancedIndicatorAnalysis\.families\.(trend|momentum|volume|sentiment|volatility|support|cost)/i); if(f){const d={trend:"趋势",momentum:"动量",volume:"量价",sentiment:"情绪",volatility:"波动",support:"支撑压力",cost:"成本"};return `扩展指标 · ${d[String(f[1]).toLowerCase()]||f[1]}族`;}
  const m=x.match(/technical\.indicators(?:\[([^\]]+)\]|\.([A-Z0-9-]+))/i);
  if(m){
    let id=m[1]||m[2];
    if(/^\d+$/.test(String(id))){
      const row=state.aiArchive?.inputSnapshot?.technical?.indicators?.[Number(id)];
      id=row?.id||row?.name||`第${Number(id)+1}项`;
    }
    const rest=x.slice((m.index||0)+m[0].length).replace(/^\./,"");
    return `扩展技术指标 · ${id}${rest?` · ${genericEvidenceLabel(rest)}`:""}`;
  }
  for(const [k,v] of Object.entries(EVIDENCE_LABELS))if(x.startsWith(k+".")){const suffix=x.slice(k.length+1);return suffix?`${v} · ${genericEvidenceLabel(suffix)}`:v;}
  return genericEvidenceLabel(x);
}

function fmtEvidenceNumber(v){
  const n=Number(v); if(!Number.isFinite(n))return "";
  if(Number.isInteger(n))return n.toLocaleString("zh-CN");
  if(Math.abs(n)>0&&Math.abs(n)<0.01)return n>0?"<0.01":">-0.01";
  return n.toLocaleString("zh-CN",{maximumFractionDigits:2,minimumFractionDigits:0,useGrouping:true});
}
const EVIDENCE_VALUE_LABELS={score:"评分",state:"状态",summary:"摘要",risk:"风险",value:"数值",hitRate:"胜率",sampleSize:"样本",reliability:"可靠度",upCount:"上涨",downCount:"下跌",flatCount:"平盘",changePct:"涨跌幅",mainNetYi:"主力净额",largeNetYi:"大单净额",superNetYi:"超大单净额",mainPct:"主力净占比",trend:"趋势",momentum:"动量",volume:"量价",sentiment:"情绪",volatility:"波动",support:"支撑",cost:"成本"};
function compactEvidenceValue(v, maxChars=110){
  if(v==null)return "";
  if(typeof v==="number")return fmtEvidenceNumber(v);
  if(typeof v==="boolean")return v?"是":"否";
  if(typeof v==="string"){
    const t=v.trim();
    if(/^[-+]?\d+(?:\.\d+)?$/.test(t))return fmtEvidenceNumber(Number(t));
    return t.length>maxChars?`${t.slice(0,maxChars-1)}…`:t;
  }
  if(Array.isArray(v)){
    if(!v.length)return "无";
    if(v.every(x=>x==null||["string","number","boolean"].includes(typeof x))){
      const shown=v.slice(0,4).map(x=>compactEvidenceValue(x,28)).filter(Boolean).join(" / ");
      return `${shown}${v.length>4?` · 另${v.length-4}项`:""}`;
    }
    return `${v.length}项结构化数据`;
  }
  if(typeof v==="object"){
    const preferred=["score","state","summary","risk","hitRate","sampleSize","reliability","upCount","downCount","flatCount","changePct","mainNetYi","largeNetYi","superNetYi","mainPct"];
    const parts=[];
    for(const k of preferred){
      if(v[k]==null||typeof v[k]==="object")continue;
      const val=compactEvidenceValue(v[k],58); if(!val)continue;
      const suffix=/Pct$|hitRate/i.test(k)&&!String(val).includes("%")?"%":"";
      parts.push(`${EVIDENCE_VALUE_LABELS[k]||k} ${val}${suffix}`);
      if(parts.length>=4)break;
    }
    if(parts.length)return parts.join(" · ");
    const primitive=Object.entries(v).filter(([,x])=>x!=null&&typeof x!=="object").slice(0,3).map(([k,x])=>`${EVIDENCE_VALUE_LABELS[k]||genericEvidenceLabel(k)} ${compactEvidenceValue(x,42)}`);
    return primitive.length?primitive.join(" · "):`${Object.keys(v).length}项结构化数据`;
  }
  return "";
}
function evidenceSource(path){
  const snap=state.aiArchive?.inputSnapshot||null; const x=String(path||"");
  if(/^R\d+$/.test(x)){const row=snap?.externalResearch?.sources?.find?.(r=>r.id===x); return row?compactEvidenceValue(`${row.sourceGrade?`[${row.sourceGrade}] `:""}${row.title||row.query||x}${row.snippet?" · "+row.snippet:""}`,110):"";}
  if(/^G\d+$/.test(x)){const rows=[...(snap?.globalContext?.policies||[]),...(snap?.globalContext?.industryNews||[])];const row=rows.find(r=>r.id===x);return row?compactEvidenceValue(`${row.title||x}${row.body?" · "+row.body:""}`,110):"";}
  if(!snap)return ""; let cur=snap;
  try{
    for(const part of x.replace(/\[(\d+)\]/g,".$1").split(".")){if(!part)continue;cur=cur?.[part];if(cur==null)break;}
    return compactEvidenceValue(cur,110);
  }catch{return "";}
}
function aiRefs(refs) {
  const xs=[...new Set((refs||[]).filter(Boolean).map(String))]; if(!xs.length)return "";
  return `<details class="ai-evidence-readable"><summary><span>依据</span><em>${xs.length} 条</em></summary><div class="ai-evidence-body">${xs.map(x=>{const v=evidenceSource(x);return `<div class="ai-evidence-item"><span>${esc(evidenceLabel(x))}</span>${v?`<small>${esc(v)}</small>`:""}</div>`}).join("")}<details class="ai-evidence"><summary>技术审计路径 · ${xs.length}</summary><div>${xs.map(x=>`<code>${esc(x)}</code>`).join("")}</div></details></div></details>`;
}
function aiPointList(rows, tone="") {
  if(!(rows||[]).length)return '<div class="note">暂无</div>';
  return `<div class="ai-point-list">${rows.map(x=>`<div class="ai-point ${tone}"><div class="ai-point-text">${esc(x?.text||x?.condition||x?.summary||x||"")}</div>${x?.why?`<div class="ai-point-why">${esc(x.why)}</div>`:""}${aiRefs(x?.evidence_refs)}</div>`).join("")}</div>`;
}
function aiSectionCards(a) {
  return Object.entries(a.sections||{}).map(([k,v])=>{
    const [label,icon]=AI_SECTION_META[k]||[k,"•"];
    const details=(v?.details||[]).map(d=>`<div class="ai-detail"><b>${esc(d?.point||d?.title||"补充观察")}</b>${d?.interpretation?`<p>${esc(d.interpretation)}</p>`:""}${aiRefs(d?.evidence_refs)}</div>`).join("");
    return `<section class="ai-analysis-card"><div class="ai-card-title"><span>${icon}</span><b>${esc(label)}</b></div><p>${esc(v?.summary||"暂无有效结论")}</p>${details?`<details class="ai-detail-fold"><summary>展开详细解释 · ${(v?.details||[]).length} 项</summary>${details}</details>`:""}${aiRefs(v?.evidence_refs)}</section>`;
  }).join("");
}
function aiConsensus(a){
  const rows=a.cross_module_consensus||a.conflicts||[];
  if(!rows.length)return "";
  return `<div class="card ai-consensus"><span class="card-title">跨模块一致性与差异</span>${rows.map(x=>`<div class="ai-consensus-row ${x.impact==="负面"?"conflict":"consensus"}"><b>${esc(x.type||"待确认")}${x.impact?` · ${esc(x.impact)}`:""}</b><span>${esc(x.summary||x.text||"")}</span>${aiRefs(x.evidence_refs)}</div>`).join("")}</div>`;
}
function aiScenarios(a){
  const obj=a.scenarios||a.scenario_analysis||{}; const rows=Object.entries(obj); if(!rows.length)return "";
  return `<div class="card"><span class="card-title">条件情景推演 <em>不是价格预测</em></span><div class="ai-scenarios">${rows.map(([k,v])=>`<div class="ai-scenario"><b>${esc(k)}</b>${v?.trigger?`<small>条件：${esc(v.trigger)}</small>`:""}<p>${esc(v?.summary||v?.implication||v||"")}</p>${aiRefs(v?.evidence_refs)}</div>`).join("")}</div></div>`;
}
function fmtAiTime(ts){if(!ts)return "—";try{return new Date(ts).toLocaleString("zh-CN",{hour12:false});}catch{return "—";}}
function aiHistoryHtml(){
  const rows=state.aiHistory||[];
  if(!rows.length)return `<div class="card ai-history"><span class="card-title">历史 AI 研报</span><div class="note">当前股票暂无历史档案。每次成功生成后都会自动保存在本机。</div></div>`;
  return `<div class="card ai-history"><span class="card-title">历史 AI 研报 <em>刷新/重启不会丢失</em></span><div class="ai-history-list">${rows.slice(0,20).map((x,i)=>`<div class="ai-history-row ${state.aiReport?.archiveId===x.id?"current":""}"><div><b>${esc(fmtAiTime(x.generatedAt))}</b><small>${esc(x.provider||"")} / ${esc(x.model||"")} · ${esc(x.stance||"—")}</small></div><button class="tiny-action" data-ai-restore="${esc(x.id)}">${state.aiReport?.archiveId===x.id?"当前":"恢复"}</button><button class="tiny-action danger" data-ai-delete="${esc(x.id)}">删除</button></div>`).join("")}</div></div>`;
}
function aiTechnicalIndicatorReview(a){
  const t=a.technical_indicator_review||{}; const fam=t.family_summaries||[], sig=t.notable_signals||[]; if(!fam.length&&!sig.length)return "";
  return `<div class="card"><span class="card-title">22类技术指标专项解读 <em>${esc(t.coverage||"")}</em></span>${fam.map(x=>`<div class="ai-family-review"><b>${esc(x.family||"指标族")}</b><span>${esc(x.summary||"")}</span>${(x.key_indicators||[]).length?`<small>关键：${esc(x.key_indicators.join(" / "))}</small>`:""}${aiRefs(x.evidence_refs)}</div>`).join("")}${sig.length?`<details class="ai-detail-fold"><summary>关键曲线与形态 · ${sig.length} 项</summary>${sig.map(x=>`<div class="ai-detail"><b>${esc(x.indicator||"指标")}</b><p>${esc(x.observation||"")}${x.interpretation?` · ${esc(x.interpretation)}`:""}</p>${aiRefs(x.evidence_refs)}</div>`).join("")}</details>`:""}</div>`;
}
function aiExternalResearch(a){
  const e=a.external_research_summary||{}; const snap=state.aiArchive?.inputSnapshot?.externalResearch; if(!e.used&&!snap?.sources?.length)return "";
  const ids=e.source_ids||[]; return `<div class="card"><span class="card-title">自主外部研究结论</span><p>${esc(e.summary||`Research Agent 本次取得 ${snap?.sources?.length||0} 条外部资料。`)}</p>${ids.length?aiRefs(ids):""}</div>${researchAgentHtml(snap,{compact:true})}`;
}

function renderAiReadableReport(a) {
  const archive=state.aiArchive; const meta=state.aiReport?.archiveMeta||{};
  const stamp=archive?.generatedAt||state.aiReport?.generatedAt||meta.generatedAt;
  const usage=state.aiReport?.usage||{}; const actual=state.aiReport?.actualCost; const diag=state.aiReport?.parseDiagnostics||{};
  const action=a.action_framework;
  return `<div class="ai-report-shell">
    ${a._parse_warning?`<div class="ai-parse-warning">⚠ ${esc(a._parse_warning)}</div>`:""}
    <div class="ai-report-hero"><div class="ai-hero-top"><span class="stance">${esc(a.stance||"—")}</span><span class="ai-archive-badge">${esc(fmtAiTime(stamp))} · 基于当时数据快照</span></div><h3>${esc(a.title||"智能分析")}</h3><p>${esc(a.executive_summary||"")}</p><div class="ai-quality"><span>证据质量</span><b>${a.evidence_quality?.score??"—"}/100</b><small>${esc(a.evidence_quality?.reason||"")}</small></div></div>
    <div class="ai-two-col"><div class="card ai-core-card"><span class="card-title">核心支持</span>${aiPointList(a.key_bull_points,"pos")}</div><div class="card ai-core-card"><span class="card-title">核心反向 / 风险</span>${aiPointList(a.key_bear_points,"neg")}</div></div>
    ${aiConsensus(a)}
    ${aiTechnicalIndicatorReview(a)}
    <div class="ai-analysis-grid">${aiSectionCards(a)}</div>
    ${aiExternalResearch(a)}
    ${aiScenarios(a)}
    ${action?`<div class="card"><span class="card-title">当前研究框架</span><p>${esc(action.summary||action.current||"")}</p>${(action.steps||[]).map(x=>`<div class="ai-step">${esc(x)}</div>`).join("")}</div>`:""}
    <div class="ai-two-col"><div class="card"><span class="card-title">后续观察条件</span>${aiPointList(a.watch_conditions)}</div><div class="card"><span class="card-title">结论失效条件</span>${aiPointList(a.invalidation_conditions,"warn")}</div></div>
    <details class="card ai-data-gaps"><summary>数据缺口 / 待核验 · ${(a.data_gaps||[]).length}</summary>${(a.data_gaps||[]).map(x=>`<div class="note">• ${esc(x)}</div>`).join("")||'<div class="note">暂无明确缺口</div>'}</details>
    <div class="ai-report-toolbar"><button class="btn ghost" data-ai-export="docx" ${state.aiReport?.archiveId?"":"disabled"}>导出 Word</button><button class="btn ghost" data-ai-export="pdf" ${state.aiReport?.archiveId?"":"disabled"}>导出 PDF</button><button class="btn ghost" data-ai-open-raw ${state.aiReport?.rawOutput?.dir?"":"disabled"}>打开原始输出</button><span class="flex-1"></span><span>输入 ${usage.inputTokens??"—"} / 输出 ${usage.outputTokens??"—"} tokens${usage.reasoningTokens!=null?` · 推理 ${usage.reasoningTokens}`:""}${usage.visibleOutputTokens!=null?` · 可见约 ${usage.visibleOutputTokens}`:""}${diag.reasoningContentPromoted?` · 研报从推理通道恢复`:""}${actual?` · 约 ${esc(actual.currency)} ${Number(actual.totalCost||0).toFixed(4)}`:""}</span></div>
    <div class="note ai-disclaimer">${esc(a.disclaimer||"仅供研究，不构成投资建议。")}</div>
  </div>`;
}
function renderAiSection() {
  const e = state.aiEstimate;
  const ls = state.llmState;
  const configured = !!ls?.keyConfigured;
  const price = e?.pricing;
  const cost = e?.calculable ? `${e.currency || "USD"} ${Number(e.totalCost||0).toFixed(4)}` : (Number.isFinite(Number(e?.inputCost)) ? `输入侧约 ${e.currency||"USD"} ${Number(e.inputCost).toFixed(4)} + 输出按实际` : "发送前无法可靠计算");
  const a = state.aiReport?.report;
  const result = a ? renderAiReadableReport(a) : '<div class="card"><div class="note">尚未生成 AI 报告。成功生成后会自动保存到本机历史档案，页面刷新或软件重启后仍可恢复。</div></div>';
  return `<div class="card ai-service-card"><span class="card-title">LLM 智能研报</span><div class="kv-row"><span>服务</span><b>${esc(ls?.settings?.provider||"—")} / ${esc(ls?.settings?.model||"—")}</b></div><div class="kv-row"><span>Key</span><b>${configured?"已配置":"未配置"}</b></div><div class="kv-row"><span>预计输入</span><b>${e?.inputTokens??"—"} tokens</b></div><div class="kv-row"><span>输出策略</span><b>不主动限制 · 由模型/服务商结束</b></div>${ls?.settings?.provider==="deepseek"?`<div class="kv-row"><span>思考模式</span><b>${esc(({auto:"自动",disabled:"关闭",low:"低",high:"高",max:"最大"})[ls?.settings?.deepseekThinkingMode||"low"]||"低")}</b></div>`:""}<div class="kv-row"><span>外部研究 Agent</span><b>${ls?.settings?.enableResearchAgent===false?"关闭":`开启 · ${{fast:"快速",standard:"标准",deep:"深度"}[ls?.settings?.researchMode||"standard"]||"标准"}`}</b></div><div class="kv-row"><span>费用</span><b>${esc(cost)}</b></div><div class="note">${esc(e?.note||"价格未知时可在 AI 设置里手工填写单价。")}${price?` · 单价 ${price.input}/${price.output} ${price.currency}/1M`:""}</div><div class="note">若启用自主外部研究，发送前显示的 token 仅是最终综合报告的基础输入估算；Agent 的多轮规划调用取决于实际研究过程，完成后会按服务商 usage 合并统计。</div><div class="note">每次模型原始回答、Research Agent 研究日志和输入快照会完整保存在程序当前目录的 <code>llm_raw_outputs</code> 文件夹中，不保存 API Key。</div><div class="ai-actions"><button class="btn ghost" id="ai-configure">模型设置</button><button class="btn ghost" id="ai-open-raw-root">原始输出目录</button><button class="btn primary" id="ai-generate" ${configured?"":"disabled"}>重新生成智能报告</button></div></div>${result}${aiHistoryHtml()}`;
}
async function refreshAiHistory() {
  try { const h=await api.getAiReportHistory(state.activeCode,30); state.aiHistory=h?.rows||[]; } catch { state.aiHistory=[]; }
}
async function runAiReport() {
  const btn=$("#ai-generate"); if(btn){btn.disabled=true;btn.textContent="生成中…";}
  const r=await api.generateAiReport(state.activeCode);
  if(r.error){toast("error",r.error); if(btn){btn.disabled=false;btn.textContent="重新生成智能报告";} return;}
  state.aiReport=r; state.aiArchive=null;
  if(r.archiveId){try{const x=await api.getAiReportEntry(r.archiveId);state.aiArchive=x?.archive||null;}catch{}}
  await refreshAiHistory();
  renderReportResult();
  if(r.rawOutput?.ok===false) toast("error",`AI 研报已生成，但原始输出保存失败：${r.rawOutput.error||"未知错误"}`);
  else toast("success","AI 研报已生成；历史档案与原始模型输出均已保存");
}
async function restoreAiReport(id) {
  const r=await api.getAiReportEntry(id); if(r.error||!r.archive){toast("error",r.error||"无法恢复历史研报");return;}
  state.aiArchive=r.archive; state.aiReport={...r.archive.result,archiveId:r.archive.id,archiveMeta:(state.aiHistory||[]).find(x=>x.id===r.archive.id)||null};
  renderReportResult(); toast("success",`已恢复 ${fmtAiTime(r.archive.generatedAt)} 的历史 AI 研报`);
}

async function openAiRawOutputDir() {
  const dir=state.aiReport?.rawOutput?.dir||null;
  const r=await api.openLlmRawOutputDir(dir);
  if(r?.error)toast("error",`无法打开原始输出目录：${r.error}`);
}

async function exportAiReport(format) {
  const id=state.aiReport?.archiveId; if(!id){toast("error","当前报告尚未保存到历史档案");return;}
  const r=await api.exportAiReport(id,format); if(r?.error){toast("error",r.error);return;} if(r?.canceled)return;
  toast("success",`${format==="pdf"?"PDF":"Word"} 已保存：${r.path||""}`);
}
async function deleteAiReport(id) {
  if(!confirm("删除这份本地 AI 历史研报？此操作不会删除股票数据。"))return;
  const r=await api.deleteAiReportEntry(id); if(!r?.ok){toast("error","删除失败");return;}
  if(state.aiReport?.archiveId===id){state.aiReport=null;state.aiArchive=null;}
  await refreshAiHistory();
  if(!state.aiReport&&state.aiHistory.length)await restoreAiReport(state.aiHistory[0].id); else renderReportResult();
}

// ================= v1.3 LLM 设置 =================
async function openLlmModal() {
  $("#llm-modal").hidden=false;
  const r=await api.getLlmState(); state.llmState=r;
  const provider=$("#llm-provider"); provider.innerHTML=Object.entries(r.presets||{}).map(([k,v])=>`<option value="${esc(k)}">${esc(v.label)}</option>`).join("");
  fillLlmForm(r);
  provider.onchange=()=>{
    const pre=r.presets?.[provider.value]; if(!pre)return;
    $("#llm-endpoint").value=pre.endpoint||""; $("#llm-model").value=pre.model||""; $("#llm-billing").value=pre.billingMode||"unknown"; if(provider.value==="deepseek" && !$("#llm-thinking").value) $("#llm-thinking").value="low";
    syncLlmThinkingUi();
    $("#llm-price-hint").textContent="切换服务商后请先测试；公开价格需保存后按模型重新识别，也可手工覆盖。";
  };
  $("#llm-thinking").onchange=syncLlmThinkingUi;
}
function syncLlmThinkingUi(){
  const isDeepSeek=$("#llm-provider").value==="deepseek";
  const mode=$("#llm-thinking").value||"low";
  $("#llm-thinking").disabled=!isDeepSeek;
  $("#llm-temperature").disabled=isDeepSeek && mode!=="disabled";
  $("#llm-temperature").title=isDeepSeek && mode!=="disabled"?"DeepSeek 思考模式下服务商会忽略 temperature":"";
}
function fillLlmForm(r){
  const c=r.settings||{}; $("#llm-provider").value=c.provider||"custom"; $("#llm-endpoint").value=c.endpoint||""; $("#llm-model").value=c.model||""; $("#llm-key").value=""; $("#llm-key").placeholder=r.keyConfigured?`已保存 ${r.keyMasked||"Key"}；留空不修改`:"请输入 API Key"; $("#llm-billing").value=c.billingMode||"unknown"; $("#llm-temperature").value=c.temperature??0.2; $("#llm-thinking").value=c.deepseekThinkingMode||"low"; $("#llm-web-research").checked=c.enableResearchAgent!==false; $("#llm-research-mode").value=c.researchMode||"standard"; $("#llm-web-pages").checked=c.researchAllowPageRead!==false; $("#llm-manual-pricing").checked=!!c.useManualPricing; $("#llm-price-in").value=c.inputPricePerM??""; $("#llm-price-out").value=c.outputPricePerM??"";
  syncLlmThinkingUi();
  $("#llm-status").textContent=`${r.keyConfigured?"✓ Key 已配置":"未配置 Key"} · 安全存储 ${r.storageBackend||"未知"}`;
  $("#llm-price-hint").textContent=r.pricing?`公开价格快照：输入 $${r.pricing.input}/1M，输出 $${r.pricing.output}/1M · 更新 ${r.pricing.updatedAt}`:"当前模型没有内置价格；可手工填写。";
}
function readLlmForm(){return {provider:$("#llm-provider").value,adapter:$("#llm-provider").value==="anthropic"?"anthropic":"openai",endpoint:$("#llm-endpoint").value.trim(),model:$("#llm-model").value.trim(),billingMode:$("#llm-billing").value,temperature:Number($("#llm-temperature").value),deepseekThinkingMode:$("#llm-thinking").value||"low",enableResearchAgent:$("#llm-web-research").checked,researchMode:$("#llm-research-mode").value||"standard",researchAllowPageRead:$("#llm-web-pages").checked,useManualPricing:$("#llm-manual-pricing").checked,inputPricePerM:$("#llm-price-in").value,outputPricePerM:$("#llm-price-out").value,currency:"USD"};}
async function testLlm(){const cfg=readLlmForm(), key=$("#llm-key").value.trim(); $("#llm-status").textContent="测试连接中…"; const r=await api.testLlm(cfg,key||null); $("#llm-status").textContent=r.ok?`✓ ${r.message}${r.warning?" · "+r.warning:""}`:`✗ ${r.error}`; if(r.pricing)$("#llm-price-hint").textContent=`识别单价：输入 $${r.pricing.input}/1M，输出 $${r.pricing.output}/1M · ${r.pricing.updatedAt}`;}
async function saveLlm(){const cfg=readLlmForm(), key=$("#llm-key").value.trim(); const r=await api.setLlmSettings(cfg,key||null,false); state.llmState=r; $("#llm-key").value=""; $("#llm-status").textContent=`✓ 已保存 · ${r.keyConfigured?"Key已配置":"无Key"}${r.keyResult?.warning?" · "+r.keyResult.warning:""}`; toast("success","AI 模型设置已保存"); if(state.panel==="report"&&state.researchResult){try{const e=await api.estimateAiReport(state.activeCode);state.aiEstimate=e.estimate;state.llmState=e.llm;renderReportResult();}catch{}}}
// ================= 添加弹窗 =================
function openAdd() {
  $("#add-modal").hidden = false;
  state.searchRows = [];
  $("#add-results").innerHTML = "";
  $("#add-input").value = "";
  $("#add-buy").value = ""; $("#add-sell").value = "";
  state.addPick = null;
  $("#add-input").focus();
}
function closeAdd() { $("#add-modal").hidden = true; }

let searchTimer = null, searchSeq = 0;
$("#add-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const seq = ++searchSeq;
  if (!q) { $("#add-results").innerHTML = ""; return; }
  searchTimer = setTimeout(async () => {
    $("#add-results").innerHTML = '<div class="note">正在查询本地名单与最新证券库…</div>';
    let r;try{r=await api.searchStocks(q);}catch(err){if(seq===searchSeq)$("#add-results").innerHTML=`<div class="note">查询失败：${esc(err?.message||String(err))}</div>`;return;}
    if(seq!==searchSeq||$("#add-input").value.trim()!==q)return;
    $("#add-results").innerHTML = r.rows.map((row) => `
      <div class="modal-result" data-code="${esc(row.code)}" data-name="${esc(row.name)}">
        <span class="rcode">${esc(row.code)}</span><span class="rname">${esc(row.name)}</span><small>${row.source==="eastmoney"?"东财最新证券库":row.source&&row.source!=="local"?"实时行情验证":"本地名单"}</small>
      </div>`).join("") || `<div class="note">无匹配结果${r.remoteError?` · 最新证券库暂不可用：${esc(r.remoteError)}`:""}</div>`;
    $("#add-results").querySelectorAll(".modal-result").forEach((el) => {
      el.onclick = () => {
        state.addPick = { code: el.dataset.code, name: el.dataset.name };
        $("#add-results").querySelectorAll(".modal-result").forEach((x) => x.classList.remove("on"));
        el.classList.add("on");
      };
    });
  }, 250);
});

$("#add-confirm").onclick = () => {
  const code = normalizeUiCode(state.addPick ? state.addPick.code : $("#add-input").value);
  if (!code) { toast("risk","请输入六位股票代码，或先从搜索结果中选择"); return; }
  const buy = parseFloat($("#add-buy").value);
  const sell = parseFloat($("#add-sell").value);
  const sym = { code };
  if (state.addPick && state.addPick.name) sym.name = state.addPick.name;
  if (Number.isFinite(buy) && buy > 0) sym.buyPrice = buy;
  if (Number.isFinite(sell) && sell > 0) sym.sellPrice = sell;
  let group = state.watchlist.groups[state.activeGroup];
  if (!group) { group = { name: "分组1", symbols: [] }; state.watchlist.groups.push(group); state.activeGroup = 0; }
  if(group.symbols.some((x)=>normalizeUiCode(x.code)===code)){toast("","该股票已在当前分组中");return;}
  group.symbols.push(sym);
  api.setWatchlist(state.watchlist.groups);
  closeAdd();
  renderGroupTabs();
  renderWatchList();
  api.pollNow();
};


// ================= v1.8.1 多数据源管理 =================
const dsBuiltinMeta = {
  eastmoney:{label:"东方财富",caps:"批量行情 · 分时 · 前复权K线 · 专用F10/资金/行业",capKeys:["quote","minute","kline","aux"]},
  tencent:{label:"腾讯行情",caps:"批量行情 · 分时 · 前复权K线",capKeys:["quote","minute","kline"]},
  sina:{label:"新浪行情",caps:"批量实时行情 · 行业",capKeys:["quote","aux"]},
  tdx:{label:"通达信 / pytdx",caps:"独立行情路径 · 实时/分时/K线（需本地安装 pytdx）",capKeys:["quote","minute","kline"]},
  tushare:{label:"Tushare Pro",caps:"高质量历史日线 · 基础面/交易日历（需 Token）",capKeys:["kline","aux"]},
  baostock:{label:"Baostock",caps:"免费历史行情/研究数据（需本地安装 baostock）",capKeys:["kline","aux"]},
  akshare:{label:"AKShare 聚合适配",caps:"多上游适配器 · 不计作独立冗余源（需本地安装）",capKeys:["quote","minute","kline","aux"]},
  exchange:{label:"交易所 / 巨潮",caps:"权威公告/交易日历/披露辅助 · 不用于高频行情",capKeys:["aux"]},
};
function dsFmtTime(t){if(!t)return "—";try{return new Date(t).toLocaleTimeString("zh-CN",{hour12:false});}catch{return "—";}}
function renderDataSourceBuiltins(){
  const box=$("#data-source-builtins"), st=state.dataSourceState; if(!box||!st)return;
  const cfg=st.config||{}, providers=cfg.providers||{}, hs=new Map((st.providers||[]).map(x=>[x.id,x]));
  box.innerHTML=["eastmoney","tencent","sina","tdx","tushare","baostock","akshare","exchange"].map(id=>{const p=providers[id]||{},h=hs.get(id)||{},meta=dsBuiltinMeta[id]||{label:id,caps:"",capKeys:[]};const health=h.blocked?`熔断至 ${dsFmtTime(h.blockedUntil)}`:h.successRate==null?"尚无运行统计":`成功率 ${h.successRate}% · ${h.latencyMs??"—"}ms`;const hc=h.blocked||h.failures>h.successes?"bad":h.successes?"good":""; const kind=meta.label.includes("需")?"optional":"";const capNames={quote:"行情",minute:"分时",kline:"K线",aux:"专用"};const rates=(meta.capKeys||[]).map(cap=>`<label>${capNames[cap]||cap}<input type="number" min="250" step="250" data-ds-cap="${cap}" value="${Number(p.minIntervals?.[cap])||2500}">ms</label>`).join("");return `<div class="data-source-row" data-ds-id="${id}"><div class="ds-name"><b>${esc(meta.label)}</b><small>${esc(meta.caps)}</small><em class="ds-kind ${kind}">${kind?"可选组件":"内置"}</em></div><label><input type="checkbox" data-ds-field="enabled" ${p.enabled!==false?"checked":""}>启用</label><label>优先级（1最高）<input type="number" min="1" max="100" data-ds-field="priority" value="${Number(p.priority)||50}"></label><label>源级间隔<input type="number" min="250" step="250" data-ds-field="globalInterval" value="${Number(p.globalMinIntervalMs)||1500}">ms</label><div class="ds-rates">${rates}</div><div class="data-source-health ${hc}">${esc(health)}${h.lastError?`<br>${esc(h.lastError)}`:""}</div></div>`;}).join("");
}
function renderDataSourceStatus(test=null){
  const el=$("#data-source-status"); if(!el)return; const st=test?.status||state.dataSourceState;if(!st){el.innerHTML="";return;}
  const rows=test?.results;
  if(Array.isArray(rows)){el.innerHTML=rows.map(r=>`<div class="data-source-test-row ${r.ok?"ok":"fail"}"><span>${esc(dsBuiltinMeta[r.id]?.label||r.id)}</span><span>${esc(r.capability)}</span><b>${r.ok?"PASS":"FAIL"}</b><span>${r.latencyMs??"—"} ms</span><span>${esc(r.detail||r.error||"")}${r.waf?" · WAF/限流→已熔断":""}</span></div>`).join("");return;}
  el.innerHTML=(st.providers||[]).map(h=>`<div class="data-source-test-row ${h.blocked?"fail":h.successes?"ok":""}"><span>${esc(dsBuiltinMeta[h.id]?.label||h.id)}</span><span>${esc((h.capabilities||[]).join("/"))}</span><b>${h.blocked?"熔断":h.enabled?"启用":"关闭"}</b><span>${h.latencyMs??"—"} ms</span><span>${h.successRate==null?"尚无请求":`成功 ${h.successes}/${h.requests}`}${h.lastError?` · ${esc(h.lastError)}`:""}</span></div>`).join("");
}
async function openDataSourceModal(){
  const modal=$("#data-source-modal"); modal.hidden=false; $("#data-source-status").innerHTML='<div class="note">正在读取数据源状态…</div>';
  try{state.dataSourceState=await api.getDataSourceState();const c=state.dataSourceState.config||{};$("#data-source-routing").value=c.routingMode||"adaptive";$("#data-source-cache").value=c.cacheProfile||"balanced";$("#data-source-stale").checked=c.staleFallback!==false;$("#data-source-custom-json").value=JSON.stringify(c.customProviders||[],null,2);renderDataSourceBuiltins();renderDataSourceStatus();}catch(e){$("#data-source-status").innerHTML=`<div class="note">读取失败：${esc(e?.message||e)}</div>`;}
}
function readDataSourceForm(){
  const base=JSON.parse(JSON.stringify(state.dataSourceState?.config||{}));base.routingMode=$("#data-source-routing").value;base.cacheProfile=$("#data-source-cache").value;base.staleFallback=$("#data-source-stale").checked;base.providers||={};
  document.querySelectorAll(".data-source-row[data-ds-id]").forEach(row=>{const id=row.dataset.dsId,p=base.providers[id]||{};p.enabled=row.querySelector('[data-ds-field="enabled"]').checked;p.priority=Number(row.querySelector('[data-ds-field="priority"]').value)||50;p.globalMinIntervalMs=Number(row.querySelector('[data-ds-field="globalInterval"]').value)||1500;p.minIntervals={...(p.minIntervals||{})};row.querySelectorAll("[data-ds-cap]").forEach(inp=>{p.minIntervals[inp.dataset.dsCap]=Number(inp.value)||2500;});base.providers[id]=p;});
  const txt=$("#data-source-custom-json").value.trim();try{base.customProviders=txt?JSON.parse(txt):[];}catch{throw new Error("自定义数据源 JSON 格式错误");}if(!Array.isArray(base.customProviders))throw new Error("自定义数据源必须是 JSON 数组");return base;
}
async function saveDataSourceConfig(){try{const cfg=readDataSourceForm();state.dataSourceState=await api.setDataSourceConfig(cfg);toast("","数据源配置已保存");renderDataSourceBuiltins();renderDataSourceStatus();}catch(e){toast("error",e?.message||String(e));}}
async function saveDataSourceSecret(){const id=$("#data-source-secret-id").value.trim(),secret=$("#data-source-secret").value;if(!id)return toast("error","请填写自定义数据源 ID");const r=await api.setDataSourceSecret(id,secret);state.dataSourceState=r.state||state.dataSourceState;$("#data-source-secret").value="";toast(r.persisted===false?"error":"",r.persisted===false?(r.warning||"密钥仅保存在本次运行内存"):(secret?"密钥已安全保存":"密钥已清除"));}
async function testDataSourceConfig(){try{await saveDataSourceConfig();$("#data-source-status").innerHTML='<div class="note">正在逐项测试启用的数据源；测试请求也受限速器约束…</div>';const r=await api.testDataSources($("#data-source-test-code").value.trim()||"sh600519");state.dataSourceState=r.status;renderDataSourceBuiltins();renderDataSourceStatus(r);}catch(e){toast("error",e?.message||String(e));}}

// ================= 事件绑定 =================
function bindUI() {
  $("#btn-add").onclick = openAdd;
  $("#add-close").onclick = closeAdd;
  $("#add-modal").addEventListener("click", (e) => { if (e.target === $("#add-modal")) closeAdd(); });
  $("#btn-refresh").onclick = () => api.pollNow();
  $("#btn-monitor").onclick = openMonitorModal;
  $("#monitor-close").onclick = () => { $("#monitor-modal").hidden = true; };
  $("#monitor-modal").addEventListener("click", (e) => { if (e.target === $("#monitor-modal")) $("#monitor-modal").hidden = true; });
  $("#monitor-check-now").onclick = async () => { $("#monitor-check-now").disabled=true; await api.checkMonitorsNow(); await updateMonitorState(true); $("#monitor-check-now").disabled=false; };
  $("#monitor-read-all").onclick = async () => { await api.markAlertsRead(); await updateMonitorState(true); };
  $("#monitor-clear-alerts").onclick = async () => { await api.clearAlertHistory(); await updateMonitorState(true); };
  $("#position-close").onclick = () => { $("#position-modal").hidden = true; };
  $("#position-modal").addEventListener("click", (e) => { if (e.target === $("#position-modal")) $("#position-modal").hidden = true; });
  $("#position-save").onclick = savePositionModal;
  $("#position-clear").onclick = async () => { if(!state.positionCode)return; const x=await api.setMonitorPosition(state.positionCode,null); if(x.ok){state.monitorState=x.state;$("#position-modal").hidden=true;toast("","持仓记录已清除");if(state.panel==="strategy"&&state.strategyResult)renderStrategyResult(state.strategyResult);if(!$("#monitor-modal").hidden)await updateMonitorState(true);} };
  $("#btn-settings").onclick = (e) => { e.stopPropagation(); const p = $("#settings-pop"); p.hidden = !p.hidden; };
  $("#data-source-open").onclick = (e) => { e.stopPropagation(); $("#settings-pop").hidden=true; openDataSourceModal(); };
  $("#data-source-close").onclick = () => { $("#data-source-modal").hidden=true; };
  $("#data-source-modal").addEventListener("click", (e) => { if(e.target===$("#data-source-modal")) $("#data-source-modal").hidden=true; });
  $("#data-source-save").onclick = saveDataSourceConfig;
  $("#data-source-test").onclick = testDataSourceConfig;
  $("#data-source-save-secret").onclick = saveDataSourceSecret;
  $("#data-source-reset-breakers").onclick = async()=>{await api.resetDataSourceBreakers();state.dataSourceState=await api.getDataSourceState();renderDataSourceBuiltins();renderDataSourceStatus();toast("","已解除数据源熔断；下一次请求会重新尝试。")};
  $("#btn-ai-settings").onclick = openLlmModal;
  $("#indicator-params").onclick = openIndicatorParamModal;
  $("#indicator-param-close").onclick = () => { $("#indicator-param-modal").hidden = true; };
  $("#indicator-param-modal").addEventListener("click", (e) => { if (e.target === $("#indicator-param-modal")) $("#indicator-param-modal").hidden = true; });
  $("#indicator-param-save").onclick = saveIndicatorParams;
  $("#indicator-param-reset").onclick = () => resetIndicatorParams(false);
  $("#indicator-param-reset-all").onclick = () => resetIndicatorParams(true);
  $("#llm-close").onclick = () => { $("#llm-modal").hidden = true; };
  $("#llm-modal").addEventListener("click", (e) => { if (e.target === $("#llm-modal")) $("#llm-modal").hidden = true; });
  $("#llm-test").onclick = testLlm;
  $("#llm-save").onclick = saveLlm;
  $("#llm-clear-key").onclick = async () => { const r = await api.setLlmSettings(readLlmForm(), null, true); state.llmState = r; $("#llm-status").textContent = "Key 已清除"; };
  // 点击弹窗外部关闭设置面板
  document.addEventListener("click", (e) => {
    const pop = $("#settings-pop");
    if (!pop.hidden && !pop.contains(e.target) && e.target.id !== "btn-settings") {
      pop.hidden = true;
    }
  });
  $("#btn-theme").onclick = () => toggleTheme();
  // 窗口控制（无边框窗口）
  $("#btn-min").onclick = () => api.windowControl("min");
  $("#btn-max").onclick = () => api.windowControl("max");
  $("#btn-close").onclick = () => api.windowControl("close");
  $("#set-poll").onchange = (e) => api.setSettings({ pollMs: Number(e.target.value) });
  $("#set-alerts").onchange = (e) => api.setSettings({ priceAlerts: !!e.target.checked });
  $("#set-monitor-enabled").onchange = async (e) => { await api.setSettings({ monitorEnabled: !!e.target.checked }); await updateMonitorState(); };
  $("#set-strategy-alerts").onchange = (e) => api.setSettings({ strategyAlerts: !!e.target.checked });
  $("#set-monitor-poll").onchange = (e) => api.setSettings({ monitorPollMs: Number(e.target.value) });
  $("#set-monitor-cooldown").onchange = (e) => api.setSettings({ monitorCooldownMin: Number(e.target.value) });
  $("#set-market-hours").onchange = (e) => api.setSettings({ monitorOnlyMarketHours: !!e.target.checked });
  $("#set-close-tray").onchange = (e) => api.setSettings({ closeToTray: !!e.target.checked });
  $("#set-pause-hidden").onchange = (e) => api.setSettings({ pauseWhenHidden: !!e.target.checked });
  // 毛玻璃透明度滑杆（实时预览 + 持久化）
  $("#set-opacity").oninput = (e) => { applyOpacity(Number(e.target.value)); };
  $("#set-opacity").onchange = (e) => api.setSettings({ opacity: Number(e.target.value) });
  $("#btn-new-group").onclick = () => {
    const name = `分组${state.watchlist.groups.length + 1}`;
    state.watchlist.groups.push({ name, symbols: [] });
    api.setWatchlist(state.watchlist.groups);
    state.activeGroup = state.watchlist.groups.length - 1;
    renderGroupTabs(); renderWatchList();
  };
  // 图表周期切换
  $("#chart-tabs").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      $("#chart-tabs").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.chartMode = b.dataset.period;
      loadChart();
    };
  });
  // 面板切换
  $("#panel-tabs").querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      $("#panel-tabs").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.panel = b.dataset.panel;
      api.setSettings({ lastPanel: state.panel });
      switch (state.panel) {
        case "signal": loadSignal(); break;
        case "screen": renderScreen(); break;
        case "strategy": renderStrategy(); break;
        case "report": renderReport(); break;
      }
    };
  });
  window.addEventListener("resize", () => { chart.resize(); indicatorPanes.resize(); });
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  document.body.classList.toggle("light", state.settings.theme === "light");
  $("#btn-theme").textContent = state.settings.theme === "dark" ? "🌙" : "☀️";
  chart.setTheme(state.settings.theme);
  indicatorPanes.setTheme(state.settings.theme);
  api.setSettings({ theme: state.settings.theme });
}

/** 毛玻璃透明度：百分比 (30-95) → CSS 变量，实时生效 */
function applyOpacity(pct) {
  const v = Math.max(30, Math.min(95, Math.round(pct)));
  document.documentElement.style.setProperty("--glass-opacity", (v / 100).toFixed(2));
  const el = $("#set-opacity-val");
  if (el) el.textContent = v + "%";
}

// 行情推送
function updateConnectionStatus() {
  const liveCount = state.quotes.filter((r) => r.live).length;
  const dot = $(".status-dot");
  const txt = $("#market-status-text");
  const regime = state.marketRegime?.label ? ` · 市场 ${state.marketRegime.label}` : "";
  if (liveCount > 0) { dot.className = "status-dot ok"; txt.textContent = `已连接 · ${liveCount} 只在线${regime}`; }
  else { dot.className = "status-dot err"; txt.textContent = `行情获取失败${regime}`; }
}

api.onQuotes(({ rows }) => {
  state.quotes = rows;
  updateConnectionStatus();
  renderWatchList();
  renderDetail();
  if (state.activeCode && Date.now() - signalRefreshAt >= 60000) loadSignal(false, true);
  // 更新分时/详情价格（不整图重绘，避免闪烁；K线不动）
  if (state.chartMode === "minute" && state.activeCode) loadChart();
});
api.onAlert(({ type, message }) => toast(type, message));
api.onMonitorAlert((item) => {
  state.alertHistory = [item, ...(state.alertHistory || []).filter((x) => x.id !== item.id)].slice(0,120);
  state.monitorState = { ...(state.monitorState || {}), unreadCount: (Number(state.monitorState?.unreadCount)||0) + 1 };
  updateMonitorBadge();
  if (!$("#monitor-modal")?.hidden) renderMonitorModal();
});
api.onMonitorState((ms) => {
  state.monitorState = ms || state.monitorState; updateMonitorBadge(); renderWatchList();
  if (!$("#monitor-modal")?.hidden) { api.getAlertHistory(120).then((h)=>{state.alertHistory=h.items||[];state.monitorState.unreadCount=h.unreadCount||0;renderMonitorModal();updateMonitorBadge();}).catch(()=>{}); }
  if (state.panel === "strategy" && state.strategyResult) renderStrategyResult(state.strategyResult);
});
api.onNavigateStock(({code}) => { if(code){ selectStock(code); } });
api.onLocalAiEvent((evt)=>{
  state.localAiEvent=evt||null;
  const box=$("#local-ai-progress"); if(box&&evt?.message) box.textContent=evt.message;
  if(evt?.type==="installed"||evt?.type==="status"||evt?.type==="prediction"){
    api.getLocalAiState(false).then(async(x)=>{state.localAi=x;try{state.localAiHistory=(await api.getLocalAiHistory(20)).items||[];}catch{}if(state.panel==="strategy"&&state.strategyResult)renderStrategyResult(state.strategyResult);}).catch(()=>{});
  }
});

// 时钟
setInterval(() => {
  $("#status-clock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}, 1000);

// ================= 启动 =================
(async function init() {
  bindUI();
  const st = await api.getState();
  state.watchlist = st.watchlist || { groups: [] };
  state.settings = { ...state.settings, ...st.settings };
  state.dataSourceState = st.dataSources || null;
  if (["signal","screen","strategy","report"].includes(state.settings.lastPanel)) state.panel = state.settings.lastPanel;
  if (["overview","quotes","trade","funds","news","global","ai"].includes(state.settings.lastReportTab)) state.reportTab = state.settings.lastReportTab;
  document.body.classList.toggle("light", state.settings.theme === "light");
  $("#btn-theme").textContent = state.settings.theme === "dark" ? "🌙" : "☀️";
  $("#set-poll").value = String(state.settings.pollMs || 5000);
  $("#set-alerts").checked = state.settings.priceAlerts !== false && state.settings.alerts !== false;
  $("#set-monitor-enabled").checked = state.settings.monitorEnabled !== false;
  $("#set-strategy-alerts").checked = state.settings.strategyAlerts !== false;
  $("#set-monitor-poll").value = String(state.settings.monitorPollMs || 15000);
  $("#set-monitor-cooldown").value = String(state.settings.monitorCooldownMin || 30);
  $("#set-market-hours").checked = state.settings.monitorOnlyMarketHours !== false;
  $("#set-close-tray").checked = state.settings.closeToTray !== false;
  $("#set-pause-hidden").checked = state.settings.pauseWhenHidden !== false;
  // 透明度初始化（默认 72）
  $("#set-opacity").value = String(state.settings.opacity ?? 72);
  applyOpacity(state.settings.opacity ?? 72);
  chart.setTheme(state.settings.theme);
  indicatorPanes.setTheme(state.settings.theme);
  await initIndicatorUi();
  await updateMonitorState();
  renderGroupTabs();
  renderWatchList();
  // 恢复刷新前的股票/面板；若不存在则默认第一只。
  const syms = allSymbols();
  const chosen = syms.find((x) => x.code === state.settings.lastCode) || syms[0];
  $("#panel-tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.panel === state.panel));
  if (chosen) {
    selectStock(chosen.code);
    if (state.panel === "screen") renderScreen();
  } else renderSignalPanelEmpty();
  api.pollNow();
})();

function renderSignalPanelEmpty() {
  $("#panel-body").innerHTML = '<div class="empty-tip">点击左上角 ＋ 添加股票\n开始你的盯盘之旅</div>';
}
