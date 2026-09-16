/**
 * StockDesk — 桌面盯盘应用主进程
 * Electron main process：窗口管理 + 数据服务（行情轮询/分析/缓存/提醒）
 * 引擎复用 dsh-stock-watch 插件的核心模块（engine/），与原插件解耦、只读。
 */
import { app, BrowserWindow, ipcMain, Notification, shell, Tray, Menu, safeStorage, dialog } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import * as dataHub from "./engine/data-provider-hub.js";
import { createSignalService } from "./engine/signal-service.js";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(__dirname, "engine");

// ---- 引擎模块（懒加载，避免启动即解析全部） ----
const ENGINE_URL = (p) => pathToFileURL(join(ENGINE, ...p)).href;
let _mods = null;
async function mods() {
  if (!_mods) {
    const [{ analyzeDaily, analyzeSignals, computeTiming, validateSignalHistory }, sectors] =
      await Promise.all([
        import(ENGINE_URL(["indicators.js"])),
        import(ENGINE_URL(["sectors.js"])),
      ]);
    _mods = { analyzeDaily, analyzeSignals, computeTiming, validateSignalHistory, ...sectors };
  }
  return _mods;
}

// ---- 持久化：自选股 + 设置（JSON 文件，~/.stockdesk/） ----
const DATA_DIR = join(homedir(), ".stockdesk");
const WATCHLIST_PATH = join(DATA_DIR, "watchlist.json");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
const LLM_SETTINGS_PATH = join(DATA_DIR, "llm.json");
const LLM_SECRET_PATH = join(DATA_DIR, "llm-secret.bin");
const DATA_SOURCE_SECRET_PATH = join(DATA_DIR, "data-source-secrets.bin");
const AI_REPORT_DIR = join(DATA_DIR, "ai-reports");
const AI_REPORT_INDEX_PATH = join(AI_REPORT_DIR, "index.json");
const MONITOR_PATH = join(DATA_DIR, "strategy-monitors.json");
const ALERT_HISTORY_PATH = join(DATA_DIR, "monitor-alerts.json");
const LOCAL_AI_HOME = join(DATA_DIR, "ai-engine");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(AI_REPORT_DIR, { recursive: true });

// v1.3.3 · LLM 原始输出：保存在“程序当前目录/llm_raw_outputs/”，不写 API Key。
function llmRawOutputBaseDir() {
  const programDir = app.isPackaged ? dirname(process.execPath) : process.cwd();
  return join(programDir, "llm_raw_outputs");
}
function safeFilePart(v, fallback = "unknown") {
  return String(v || fallback).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/_+/g, "_").slice(0, 80) || fallback;
}
function saveLlmRawOutputBundle(code, inputSnapshot, result) {
  const stamp = new Date(Number(result?.generatedAt) || Date.now()).toISOString().replace(/[:.]/g, "-");
  const folderName = `${stamp}_${safeFilePart(code)}_${safeFilePart(llmSettings.model, "model")}`;
  const base = llmRawOutputBaseDir();
  const dir = join(base, folderName);
  try {
    mkdirSync(dir, { recursive: true });
    const attempts = Array.isArray(result?.rawAttempts) ? result.rawAttempts : [];
    const files = [];
    attempts.forEach((a, i) => {
      const n = String(i + 1).padStart(2, "0");
      const label = safeFilePart(a?.label || `attempt_${n}`);
      const txtName = `${n}_${label}.txt`;
      const jsonName = `${n}_${label}_response.json`;
      writeFileSync(join(dir, txtName), String(a?.text ?? ""), "utf8");
      files.push(txtName);
      if (String(a?.reasoningText || "")) {
        const reasoningName = `${n}_${label}_reasoning.txt`;
        writeFileSync(join(dir, reasoningName), String(a.reasoningText), "utf8");
        files.push(reasoningName);
      }
      if (a?.rawResponse != null) {
        writeFileSync(join(dir, jsonName), JSON.stringify(a.rawResponse, null, 2), "utf8");
        files.push(jsonName);
      }
    });
    // 输入快照也保存，便于以后复现实验；其中不包含 API Key。
    writeFileSync(join(dir, "stockdesk_input_snapshot.json"), JSON.stringify(inputSnapshot, null, 2), "utf8");
    files.push("stockdesk_input_snapshot.json");
    if (result?.researchAgentLog) {
      writeFileSync(join(dir, "research_agent_log.json"), JSON.stringify(result.researchAgentLog, null, 2), "utf8");
      files.push("research_agent_log.json");
    }
    const meta = {
      schemaVersion: 2, generatedAt: Number(result?.generatedAt) || Date.now(), code: String(code || ""),
      provider: llmSettings.provider, model: llmSettings.model, endpoint: llmSettings.endpoint,
      usage: result?.usage || null, actualCost: result?.actualCost || null, estimate: result?.estimate || null,
      parseDiagnostics: result?.parseDiagnostics || null, files, note: "原始模型输出完整保留；本目录不保存 API Key。"
    };
    writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta, null, 2), "utf8");
    files.push("metadata.json");
    return { ok: true, dir, files, baseDir: base };
  } catch (e) {
    return { ok: false, dir, baseDir: base, error: e?.message || String(e) };
  }
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJsonAtomic(path, obj) {
  // 简化原子写：临时文件 + rename
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    // Windows 上 rename 覆盖失败则直接写入并清理临时文件
    try { writeFileSync(path, JSON.stringify(obj, null, 2), "utf8"); } catch {}
    try { unlinkSync(tmp); } catch {}
  }
}

// ---- v1.3.1 AI 研报档案：刷新/重启不丢，保留当时输入快照与模型信息 ----
function aiReportIndex() {
  const raw = readJson(AI_REPORT_INDEX_PATH, { version: 1, items: [] });
  return { version: 1, items: Array.isArray(raw?.items) ? raw.items : [] };
}
function safeArchiveId(id) {
  const x = String(id || "");
  return /^[A-Za-z0-9_.-]{8,160}$/.test(x) ? x : "";
}
function aiArchivePath(id) {
  const safe = safeArchiveId(id);
  return safe ? join(AI_REPORT_DIR, `${safe}.json`) : null;
}
function reportStockName(snapshot, code) {
  return String(snapshot?.meta?.name || snapshot?.name || snapshot?.overview?.name || code || "股票").slice(0, 80);
}
function saveAiReportArchive(code, inputSnapshot, result) {
  const now = Number(result?.generatedAt) || Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const normalizedCode = String(code || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const id = `${normalizedCode}_${now}_${rand}`;
  const archive = {
    schemaVersion: 1, id, code: String(code || ""), generatedAt: now,
    stock: { code: String(code || ""), name: reportStockName(inputSnapshot, code) },
    llm: { provider: llmSettings.provider, model: llmSettings.model, endpoint: llmSettings.endpoint, billingMode: llmSettings.billingMode },
    inputSnapshot, result,
  };
  writeJsonAtomic(aiArchivePath(id), archive);
  const idx = aiReportIndex();
  const meta = { id, code: archive.code, name: archive.stock.name, generatedAt: now, stance: result?.report?.stance || "", title: result?.report?.title || "智能分析报告", provider: llmSettings.provider, model: llmSettings.model, inputTokens: result?.usage?.inputTokens ?? null, outputTokens: result?.usage?.outputTokens ?? null };
  const merged = [meta, ...idx.items.filter((x) => x?.id !== id)];
  const dropped = merged.slice(300);
  idx.items = merged.slice(0, 300);
  writeJsonAtomic(AI_REPORT_INDEX_PATH, idx);
  for (const old of dropped) { try { const p = aiArchivePath(old?.id); if (p) unlinkSync(p); } catch {} }
  return meta;
}
function readAiReportArchive(id) {
  const path = aiArchivePath(id);
  if (!path) return null;
  return readJson(path, null);
}
function listAiReportArchives(code = null, limit = 50) {
  const c = code == null ? null : String(code);
  return aiReportIndex().items.filter((x) => !c || x.code === c).slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));
}
function deleteAiReportArchive(id) {
  const safe = safeArchiveId(id);
  if (!safe) return false;
  try { unlinkSync(aiArchivePath(safe)); } catch {}
  const idx = aiReportIndex();
  idx.items = idx.items.filter((x) => x?.id !== safe);
  writeJsonAtomic(AI_REPORT_INDEX_PATH, idx);
  return true;
}
function exportSafeName(v) {
  return String(v || "StockDesk_AI_Report").replace(/[\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 90) || "StockDesk_AI_Report";
}
async function exportAiArchive(id, format) {
  const archive = readAiReportArchive(id);
  if (!archive) return { error: "未找到该历史研报，可能已被删除。" };
  const ext = format === "pdf" ? "pdf" : "docx";
  const base = exportSafeName(`${archive.stock?.name || archive.code || "股票"}_${new Date(archive.generatedAt).toISOString().slice(0, 10)}_AI研报`);
  const pick = await dialog.showSaveDialog(mainWindow || undefined, {
    title: ext === "pdf" ? "导出 AI 研报为 PDF" : "导出 AI 研报为 Word",
    defaultPath: `${base}.${ext}`,
    filters: ext === "pdf" ? [{ name: "PDF 文档", extensions: ["pdf"] }] : [{ name: "Word 文档", extensions: ["docx"] }],
  });
  if (pick.canceled || !pick.filePath) return { canceled: true };
  const exporter = await import(ENGINE_URL(["report-export.js"]));
  if (ext === "docx") {
    writeFileSync(pick.filePath, exporter.buildAiReportDocx(archive));
    return { ok: true, path: pick.filePath, format: ext };
  }
  const html = exporter.buildAiReportHtml(archive);
  const printWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  try {
    await printWin.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    const pdf = await printWin.webContents.printToPDF({ printBackground: true, pageSize: "A4", preferCSSPageSize: true });
    writeFileSync(pick.filePath, pdf);
    return { ok: true, path: pick.filePath, format: ext };
  } finally { try { printWin.destroy(); } catch {} }
}

// ---- v1.9.2 统一行情数据源 Hub ----
// 业务层不再直接绑定腾讯/东财/新浪。Hub 负责批量、限速、轮换、缓存、熔断与失败回退。
function normalizeApiCode(code) { return dataHub.normalizeStockCode(code)?.symbol || String(code || ""); }

async function fetchKline(code, period, countOverride = null) {
  // 日 K 统一请求 750 根，供图表、信号、策略和研报共同复用。
  const count = Number(countOverride || (period === "day" ? 750 : 120));
  const r = await dataHub.getKline(code, period, count);
  return Array.isArray(r.candles) ? r.candles : [];
}

async function fetchMinuteDetail(code) {
  return dataHub.getMinute(code).catch(() => ({ prevClose:null, points:[], name:null, price:null, changePercent:null, provider:null, stale:false }));
}

/** v1.1 · 当前股票的事件型提示（不把事件重复计入因子总分）。 */
function buildSignalEvents(daily, sig, timing) {
  const out = [];
  if (!daily || !sig) return out;
  const push = (level, title, detail) => out.push({ level, title, detail });
  if (Number.isFinite(daily.pctFrom20dHigh) && daily.pctFrom20dHigh >= -0.5) {
    push("positive", "接近20日新高", `距高点 ${daily.pctFrom20dHigh.toFixed(2)}%${Number.isFinite(daily.volRatio) ? ` · 量比 ${daily.volRatio.toFixed(2)}` : ""}`);
  }
  if (Number.isFinite(daily.volRatio) && daily.volRatio >= 2) {
    push(daily.close >= daily.prevClose ? "positive" : "negative", "成交量异常", `当前量比 ${daily.volRatio.toFixed(2)}`);
  }
  if (Number.isFinite(daily.rsi) && daily.rsi >= 75) push("risk", "短线过热", `RSI ${daily.rsi.toFixed(1)}`);
  if (Number.isFinite(daily.atr14Pct) && daily.atr14Pct >= 5) push("risk", "波动率偏高", `ATR14 / 价格 ${daily.atr14Pct.toFixed(1)}%`);
  if (timing?.hint) push("info", "分时状态", timing.hint);
  return out.slice(0, 6);
}

// ---- 缓存（LRU + TTL，控制内存与请求频率） ----
const klineCache = new Map(); // `${code}:${period}` -> {exp, data}
const KLINE_TTL = 15 * 60 * 1000, KLINE_MAX = 80;
const klineInflight = new Map();
const signalService = createSignalService({ getKline: dataHub.getKline, getMinute: dataHub.getMinute, indicatorParams: () => settings.indicatorParams || {}, buildEvents: (...args) => buildSignalEvents(...args) });

const marketCache = new Map();  // singleton key -> {exp,data}
const MARKET_TTL = 60 * 1000;
const marketInflight = new Map();
// v1.2 策略实验室使用更长历史，和图表短缓存分开，避免把640根K线塞给普通图表。
const strategyHistoryCache = new Map();
const STRATEGY_HISTORY_TTL = 15 * 60 * 1000, STRATEGY_HISTORY_MAX = 80;
const strategyLabCache = new Map();
const STRATEGY_LAB_TTL = 3 * 60 * 1000, STRATEGY_LAB_MAX = 24;
const researchReportCache = new Map();
const RESEARCH_TTL = 10 * 60 * 1000, RESEARCH_MAX = 8;
const researchReportInflight = new Map();

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { map.delete(key); return null; }
  map.delete(key); map.set(key, hit); // LRU touch
  return hit.data;
}
function cacheSet(map, key, data, ttl, max) {
  map.set(key, { exp: Date.now() + ttl, data });
  while (map.size > max) map.delete(map.keys().next().value);
}

function coalesce(map, key, work) {
  if (map.has(key)) return map.get(key);
  const task = Promise.resolve().then(work).finally(() => map.delete(key));
  map.set(key, task);
  return task;
}

async function cachedKline(code, period) {
  const key = `${code}:${period}`;
  const hit = cacheGet(klineCache, key);
  const market = dataHub.normalizeStockCode(code)?.market;
  const minBars = market === "bj" ? 2 : 1;
  if (hit?.length >= minBars) return hit;
  // Do not keep a one-candle BSE result produced by older provider routing.
  if (hit) klineCache.delete(key);
  return coalesce(klineInflight, key, async () => {
    const data = await fetchKline(code, period);
    if (data.length >= minBars) cacheSet(klineCache, key, data, KLINE_TTL, KLINE_MAX);
    return data;
  });
}

async function cachedStrategyHistory(code) {
  const key = String(code);
  const hit = cacheGet(strategyHistoryCache, key);
  if (hit) return hit;
  const data = await cachedKline(code, "day");
  if (data.length) cacheSet(strategyHistoryCache, key, data, STRATEGY_HISTORY_TTL, STRATEGY_HISTORY_MAX);
  return data;
}

// ---- 设置与轮询 ----
let settings = readJson(SETTINGS_PATH, { pollMs: 5000, alerts: true, priceAlerts: true, strategyAlerts: true, monitorEnabled: true, monitorPollMs: 15000, monitorCooldownMin: 30, monitorOnlyMarketHours: true, theme: "dark", winBounds: null, indicatorParams: {}, closeToTray: true, pauseWhenHidden: true, dataSources: dataHub.DEFAULT_DATA_SOURCE_CONFIG });
if (!settings.indicatorParams || typeof settings.indicatorParams !== "object" || Array.isArray(settings.indicatorParams)) settings.indicatorParams = {};
settings.dataSources = dataHub.sanitizeConfig(settings.dataSources || dataHub.DEFAULT_DATA_SOURCE_CONFIG);
if (settings.closeToTray == null) settings.closeToTray = true;
if (settings.pauseWhenHidden == null) settings.pauseWhenHidden = true;
if (settings.priceAlerts == null) settings.priceAlerts = settings.alerts !== false;
if (settings.strategyAlerts == null) settings.strategyAlerts = true;
if (settings.monitorEnabled == null) settings.monitorEnabled = true;
if (!Number.isFinite(Number(settings.monitorPollMs))) settings.monitorPollMs = 15000;
settings.monitorPollMs = Math.max(10000, Math.min(300000, Number(settings.monitorPollMs) || 15000));
if (!Number.isFinite(Number(settings.monitorCooldownMin))) settings.monitorCooldownMin = 30;
settings.monitorCooldownMin = Math.max(1, Math.min(360, Number(settings.monitorCooldownMin) || 30));
if (settings.monitorOnlyMarketHours == null) settings.monitorOnlyMarketHours = true;
let watchlist = readJson(WATCHLIST_PATH, { groups: [{ name: "分组1", symbols: [{ code: "sh000001" }, { code: "sz399300" }, { code: "sh601899" }] }] });
let monitorStore = readJson(MONITOR_PATH, { version: 1, items: {} });
if (!monitorStore || typeof monitorStore !== "object" || Array.isArray(monitorStore)) monitorStore = { version: 1, items: {} };
if (!monitorStore.items || typeof monitorStore.items !== "object" || Array.isArray(monitorStore.items)) monitorStore.items = {};
let alertStore = readJson(ALERT_HISTORY_PATH, { version: 1, items: [] });
if (!alertStore || typeof alertStore !== "object" || !Array.isArray(alertStore.items)) alertStore = { version: 1, items: [] };
let llmSettings = readJson(LLM_SETTINGS_PATH, {
  provider: "deepseek", adapter: "openai", endpoint: "https://api.deepseek.com", model: "deepseek-v4-flash",
  billingMode: "payg", temperature: 0.2, deepseekThinkingMode: "low",
  enableResearchAgent: true, researchMode: "standard", researchAllowPageRead: true,
  // 旧字段保留用于配置迁移，不再作为 v1.8 主流程控制项。
  enableWebResearch: true, maxResearchQueries: 4, readResearchPages: false,
  useManualPricing: false, inputPricePerM: null, outputPricePerM: null, currency: "USD",
});
delete llmSettings.maxOutputTokens;
// v1.8：迁移旧联网研究配置到自主 Research Agent。旧字段继续保留，避免用户已有 llm.json 失效。
if (llmSettings.enableWebResearch == null) llmSettings.enableWebResearch = true;
if (!Number.isFinite(Number(llmSettings.maxResearchQueries))) llmSettings.maxResearchQueries = 4;
if (!["auto","disabled","low","high","max"].includes(String(llmSettings.deepseekThinkingMode || ""))) llmSettings.deepseekThinkingMode = "low";
llmSettings.maxResearchQueries = Math.max(1, Math.min(8, Math.round(Number(llmSettings.maxResearchQueries) || 4)));
if (llmSettings.readResearchPages == null) llmSettings.readResearchPages = false;
if (llmSettings.enableResearchAgent == null) llmSettings.enableResearchAgent = llmSettings.enableWebResearch !== false;
if (!["fast","standard","deep"].includes(String(llmSettings.researchMode || ""))) llmSettings.researchMode = "standard";
if (llmSettings.researchAllowPageRead == null) llmSettings.researchAllowPageRead = true;
let sessionLlmKey = "";

function saveLlmSettings() { writeJsonAtomic(LLM_SETTINGS_PATH, llmSettings); }
function llmStorageBackend() {
  try { return safeStorage.isEncryptionAvailable() ? (safeStorage.getSelectedStorageBackend?.() || "os_encrypted") : "unavailable"; }
  catch { return "unavailable"; }
}
function readLlmKey() {
  if (sessionLlmKey) return sessionLlmKey;
  try {
    if (!safeStorage.isEncryptionAvailable()) return "";
    const b64 = readFileSync(LLM_SECRET_PATH, "utf8").trim();
    if (!b64) return "";
    return safeStorage.decryptString(Buffer.from(b64, "base64"));
  } catch { return ""; }
}
function writeLlmKey(key) {
  const val = String(key || "").trim();
  sessionLlmKey = val;
  if (!val) { try { unlinkSync(LLM_SECRET_PATH); } catch {} return { persisted: true }; }
  if (!safeStorage.isEncryptionAvailable()) return { persisted: false, warning: "当前系统安全存储不可用：Key 仅保存在本次运行内存，关闭软件后失效。" };
  const enc = safeStorage.encryptString(val);
  writeFileSync(LLM_SECRET_PATH, enc.toString("base64"), "utf8");
  return { persisted: true };
}

let sessionDataSourceSecrets = {};
function readDataSourceSecrets() {
  if (Object.keys(sessionDataSourceSecrets).length) return { ...sessionDataSourceSecrets };
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const b64 = readFileSync(DATA_SOURCE_SECRET_PATH, "utf8").trim();
    if (!b64) return {};
    const obj = JSON.parse(safeStorage.decryptString(Buffer.from(b64, "base64")));
    sessionDataSourceSecrets = obj && typeof obj === "object" ? obj : {};
    return { ...sessionDataSourceSecrets };
  } catch { return {}; }
}
function writeDataSourceSecret(id, secret) {
  const key = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0,40);
  if (!key) return { persisted:false, warning:"数据源 ID 无效" };
  const all = readDataSourceSecrets();
  const val = String(secret || "").trim();
  if (val) all[key] = val; else delete all[key];
  sessionDataSourceSecrets = all;
  if (!Object.keys(all).length) { try { unlinkSync(DATA_SOURCE_SECRET_PATH); } catch {} return { persisted:true }; }
  if (!safeStorage.isEncryptionAvailable()) return { persisted:false, warning:"系统安全存储不可用：数据源密钥仅保存在本次运行内存。" };
  const enc = safeStorage.encryptString(JSON.stringify(all));
  writeFileSync(DATA_SOURCE_SECRET_PATH, enc.toString("base64"), "utf8");
  return { persisted:true };
}
function configureDataHub() { dataHub.configureDataSources(settings.dataSources || dataHub.DEFAULT_DATA_SOURCE_CONFIG, readDataSourceSecrets()); }
configureDataHub();
function publicLlmState() {
  const key = readLlmKey();
  return { settings: { ...llmSettings }, keyConfigured: !!key, keyMasked: key ? `${key.slice(0, 3)}••••${key.slice(-3)}` : "", storageBackend: llmStorageBackend() };
}
function sanitizeLlmSettings(patch = {}) {
  const allowedProviders = ["openai", "deepseek", "anthropic", "gemini", "custom"];
  const out = { ...llmSettings };
  if (patch.provider != null) out.provider = allowedProviders.includes(String(patch.provider)) ? String(patch.provider) : "custom";
  if (patch.adapter != null) out.adapter = patch.adapter === "anthropic" ? "anthropic" : "openai";
  if (patch.endpoint != null) out.endpoint = String(patch.endpoint).trim().slice(0, 500);
  if (patch.model != null) out.model = String(patch.model).trim().slice(0, 160);
  if (patch.billingMode != null) out.billingMode = ["payg", "monthly", "free", "unknown"].includes(String(patch.billingMode)) ? String(patch.billingMode) : "unknown";
  if (patch.temperature != null) out.temperature = Math.max(0, Math.min(1, Number(patch.temperature) || 0));
  if (patch.deepseekThinkingMode != null) out.deepseekThinkingMode = ["auto","disabled","low","high","max"].includes(String(patch.deepseekThinkingMode)) ? String(patch.deepseekThinkingMode) : "low";
  if (patch.enableWebResearch != null) out.enableWebResearch = !!patch.enableWebResearch;
  if (patch.maxResearchQueries != null) out.maxResearchQueries = Math.max(1, Math.min(8, Math.round(Number(patch.maxResearchQueries) || 4)));
  if (patch.readResearchPages != null) out.readResearchPages = !!patch.readResearchPages;
  if (patch.enableResearchAgent != null) out.enableResearchAgent = !!patch.enableResearchAgent;
  if (patch.researchMode != null) out.researchMode = ["fast","standard","deep"].includes(String(patch.researchMode)) ? String(patch.researchMode) : "standard";
  if (patch.researchAllowPageRead != null) out.researchAllowPageRead = !!patch.researchAllowPageRead;
  if (patch.useManualPricing != null) out.useManualPricing = !!patch.useManualPricing;
  if (patch.inputPricePerM !== undefined) out.inputPricePerM = patch.inputPricePerM === "" || patch.inputPricePerM == null ? null : Math.max(0, Number(patch.inputPricePerM));
  if (patch.outputPricePerM !== undefined) out.outputPricePerM = patch.outputPricePerM === "" || patch.outputPricePerM == null ? null : Math.max(0, Number(patch.outputPricePerM));
  if (patch.currency != null) out.currency = String(patch.currency || "USD").slice(0, 8).toUpperCase();
  delete out.maxOutputTokens; // v1.3.3：迁移旧配置，不再由 StockDesk 设置报告输出上限。
  return out;
}
let pollTimer = null;
let polling = false;
let windowHidden = false;
let lastAlerts = new Map(); // code -> {buyFired, sellFired}

function saveWatchlist() { writeJsonAtomic(WATCHLIST_PATH, watchlist); }
function saveSettings() { writeJsonAtomic(SETTINGS_PATH, settings); }

function normalizeSymbol(raw) {
  if (typeof raw === "string") raw = { code: raw };
  if (!raw || typeof raw !== "object") return null;
  const code = normalizeApiCode(raw.code);
  if (!dataHub.normalizeStockCode(code)) return null;
  const s = { code };
  if (raw.name) s.name = raw.name;
  const bp = parseFloat(raw.buyPrice); if (Number.isFinite(bp) && bp > 0) s.buyPrice = bp;
  const sp = parseFloat(raw.sellPrice); if (Number.isFinite(sp) && sp > 0) s.sellPrice = sp;
  return s;
}
function normalizeSymbolList(items) {
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const row = normalizeSymbol(raw);
    if (!row || seen.has(row.code)) continue;
    seen.add(row.code); out.push(row);
  }
  return out;
}
{
  const before = JSON.stringify(watchlist);
  watchlist = { groups: (watchlist?.groups || []).map((g) => ({
    name: String(g?.name || "分组").slice(0, 32),
    symbols: normalizeSymbolList(g?.symbols),
  })) };
  if (!watchlist.groups.length) watchlist.groups.push({ name: "分组1", symbols: [] });
  if (JSON.stringify(watchlist) !== before) saveWatchlist();
}

function allSymbols() {
  const seen = new Set(), out = [];
  for (const g of watchlist.groups) for (const s of g.symbols) {
    if (seen.has(s.code)) continue;
    seen.add(s.code); out.push(s);
  }
  return out;
}

function computeTrigger(price, buyPrice, sellPrice) {
  if (buyPrice === undefined && sellPrice === undefined) return "none";
  if (sellPrice !== undefined && price >= sellPrice) return "sell";
  if (buyPrice !== undefined && price <= buyPrice) return "buy";
  return "wait";
}
function isAshareNotifyWindow(date = new Date()) {
  if (settings.monitorOnlyMarketHours === false) return true;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const o = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  if (["Sat", "Sun"].includes(o.weekday)) return false;
  const m = Number(o.hour) * 60 + Number(o.minute);
  return (m >= 570 && m <= 690) || (m >= 780 && m <= 900);
}

// ---- 行情轮询（可暂停：窗口失焦降频/隐藏时暂停） ----
async function pollOnce(force) {
  if (polling && !force) return;
  polling = true;
  try {
    const symbols = allSymbols();
    // 一次批量请求整个自选池；Hub 每轮在健康数据源之间调度，避免 N 只股票产生 N 次 HTTP。
    const batch = await dataHub.getQuotes(symbols.map((s) => s.code));
    const quoteMap = new Map((batch.rows || []).map((q) => [String(q.symbol || normalizeApiCode(q.code)), q]));
    const rows = [];
    for (const sym of symbols) {
      const q = quoteMap.get(normalizeApiCode(sym.code)) || null;
      const row = { code: sym.code, name: q ? q.name : sym.name || sym.code, trigger: "none", live: !!q, provider: q?._provider || batch.provider || null, stale: !!q?._stale };
      if (sym.buyPrice !== undefined) row.buyPrice = sym.buyPrice;
      if (sym.sellPrice !== undefined) row.sellPrice = sym.sellPrice;
      if (q) {
        row.price = q.price; row.changePercent = q.changePercent; row.changeAmount = q.changeAmount;
        row.high = q.high; row.low = q.low; row.volume = q.volume; row.amount = q.amount;
        row.prevClose = q.prevClose;
        row.trigger = computeTrigger(q.price, sym.buyPrice, sym.sellPrice);
        // 目标价提醒
        if (settings.priceAlerts !== false && !q._stale && isAshareNotifyWindow()) {
          const prev = lastAlerts.get(sym.code) || { buyFired: false, sellFired: false };
          const firedBuy = sym.buyPrice !== undefined && q.price <= sym.buyPrice && !prev.buyFired;
          const firedSell = sym.sellPrice !== undefined && q.price >= sym.sellPrice && !prev.sellFired;
          if (firedBuy || firedSell) {
            const note = firedBuy
              ? `📉 ${row.name} 跌至买入目标 ${sym.buyPrice.toFixed(2)}，现价 ${q.price.toFixed(2)}`
              : `📈 ${row.name} 涨至卖出目标 ${sym.sellPrice.toFixed(2)}，现价 ${q.price.toFixed(2)}`;
            dispatchMonitorAlert({ source: "price", type: firedBuy ? "buy" : "sell", severity: firedBuy ? "positive" : "warning", code: sym.code, name: row.name, price: q.price, title: firedBuy ? "📉 买入目标价触发" : "📈 卖出目标价触发", message: note }, { notify: true });
            lastAlerts.set(sym.code, { buyFired: firedBuy || prev.buyFired, sellFired: firedSell || prev.sellFired });
          } else {
            // 价格回落到区间外后重置触发标记
            const outBuy = sym.buyPrice === undefined || q.price > sym.buyPrice * 1.005;
            const outSell = sym.sellPrice === undefined || q.price < sym.sellPrice * 0.995;
            if (outBuy && outSell) lastAlerts.delete(sym.code);
          }
        }
      }
      rows.push(row);
    }
    if (!windowHidden || settings.pauseWhenHidden === false) {
      try { mainWindow?.webContents.send("quotes", { rows, updatedAt: Date.now(), provider: batch.provider || null, stale: !!batch.stale }); } catch {}
    }
  } finally { polling = false; }
}

function startPolling() {
  stopPolling();
  pollOnce(true);
  pollTimer = setInterval(() => pollOnce(false), Math.max(2000, settings.pollMs || 5000));
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---- v1.6 策略后台监控 / 提醒中心 ----
let monitorTimer = null;
let monitorPolling = false;
let monitorSaveTimer = null;

function saveMonitorStore() { writeJsonAtomic(MONITOR_PATH, monitorStore); }
function saveAlertStore() { writeJsonAtomic(ALERT_HISTORY_PATH, alertStore); }
function scheduleMonitorSave() {
  clearTimeout(monitorSaveTimer);
  monitorSaveTimer = setTimeout(() => { saveMonitorStore(); monitorSaveTimer = null; }, 600);
}
function monitoredItems() { return Object.entries(monitorStore.items || {}).filter(([, x]) => x && x.enabled !== false); }
function symbolName(code) {
  for (const g of watchlist.groups || []) for (const s of g.symbols || []) if (s.code === code) return s.name || code;
  return code;
}
function monitorPublicState() {
  const items = Object.entries(monitorStore.items || {}).map(([code, x]) => ({ code, name: x.name || symbolName(code), ...x }));
  return {
    enabled: settings.monitorEnabled !== false,
    intervalMs: settings.monitorPollMs || 15000,
    onlyMarketHours: settings.monitorOnlyMarketHours !== false,
    strategyAlerts: settings.strategyAlerts !== false,
    items,
    activeCount: items.filter((x) => x.enabled !== false).length,
    unreadCount: (alertStore.items || []).filter((x) => !x.read).length,
    lastAlerts: (alertStore.items || []).slice(0, 10),
  };
}
function pushMonitorState() {
  try { mainWindow?.webContents.send("monitor-state", monitorPublicState()); } catch {}
}
function alertId() { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
function dispatchMonitorAlert(evt = {}, { notify = true } = {}) {
  const item = {
    id: alertId(), time: Date.now(), read: false,
    source: evt.source || "strategy", type: evt.type || "info", severity: evt.severity || "info",
    code: String(evt.code || ""), name: String(evt.name || symbolName(evt.code || "")),
    title: String(evt.title || "盯盘提醒"), message: String(evt.message || ""),
    price: Number.isFinite(Number(evt.price)) ? Number(evt.price) : null,
    stage: evt.stage || null, details: Array.isArray(evt.details) ? evt.details.slice(0, 8) : [],
  };
  alertStore.items.unshift(item);
  if (alertStore.items.length > 500) alertStore.items.length = 500;
  saveAlertStore();
  if (notify) {
    try {
      const n = new Notification({ title: item.title, body: item.message, silent: false });
      n.on("click", () => {
        try { mainWindow?.show(); mainWindow?.focus(); mainWindow?.webContents.send("navigate-stock", { code: item.code, alertId: item.id }); } catch {}
      });
      n.show();
    } catch {}
  }
  try { mainWindow?.webContents.send("monitor-alert", item); } catch {}
  try { mainWindow?.webContents.send("alert", { type: item.type, message: `${item.name} · ${item.message}` }); } catch {}
  pushMonitorState();
  return item;
}
function alertAllowed(spec, key, now = Date.now()) {
  const runtime = spec.runtime || (spec.runtime = {});
  const map = runtime.lastAlertAt || (runtime.lastAlertAt = {});
  const prev = Number(map[key]) || 0;
  const cool = Math.max(1, Number(settings.monitorCooldownMin) || 30) * 60000;
  if (now - prev < cool) return false;
  map[key] = now;
  return true;
}
function monitorDetails(snapshot) {
  const v = snapshot.current?.entry?.values || {};
  const ai = snapshot.ai || {};
  const details = [
    `入场完成度 ${snapshot.completion ?? 0}%`,
    Number.isFinite(v.score) ? `综合 ${v.score}` : null,
    Number.isFinite(v.trend) ? `趋势 ${v.trend}` : null,
    Number.isFinite(v.momentum) ? `动量 ${v.momentum}` : null,
    Number.isFinite(v.risk) ? `风险 ${v.risk}` : null,
    snapshot.timing?.hint || null,
    ai.usable ? `AI ${ai.action || "—"} · 可信 ${ai.confidence ?? "—"}` : null,
    ai.applied && ai.changes?.length ? `动态调整 ${ai.changes.map((x) => `${x.label} ${x.from}→${x.to}`).join(" / ")}` : null,
  ].filter(Boolean);
  return details;
}

async function monitorOne(code, spec, { allowNotify = true, aiRow = null, aiSettings = null } = {}) {
  const monitorMod = await import(ENGINE_URL(["strategy-monitor.js"]));
  const safe = monitorMod.normalizeMonitorConfig(spec);
  // 保留持久化运行态，不让 normalize 丢失。
  safe.runtime = spec.runtime || {};
  safe.name = spec.name || symbolName(code);
  const [candles, minute] = await Promise.all([cachedStrategyHistory(code), fetchMinuteDetail(code)]);
  let effectiveSafe = safe;
  let aiContext = { enabled: safe.aiAssist === true, fresh: false, usable: false, applied: false };
  if (safe.aiAssist && aiRow && String(aiRow.code || "") === String(code)) {
    const aiMod = await localAiMod();
    const ageMs = Math.max(0, Date.now() - Number(aiRow.generatedAt || 0));
    const maxAgeMin = Math.max(15, Number(aiSettings?.maxPredictionAgeMin ?? safe.aiMaxAgeMin) || 120);
    const planKeys = ["presetId","entryScore","maxRisk","stopLossPct","takeProfitPct","trailingStopPct","maxHoldDays"];
    const storedBase = aiRow.adaptivePlan?.baselineConfig;
    const sameBaseline = storedBase && planKeys.every((key) => String(storedBase?.[key] ?? "") === String(safe.config?.[key] ?? ""));
    const plan = sameBaseline ? aiRow.adaptivePlan : aiMod.buildAdaptiveAiPlan(aiRow.prediction, {
      config: safe.config,
      current: aiRow.strategy?.current || { matched: aiRow.strategy?.matched === true, values: {} },
    }, { generatedAt: aiRow.generatedAt, maxAgeMin, position: safe.position });
    const confidence = Number(plan?.decision?.confidence ?? aiRow.decision?.confidence);
    const minConfidence = Math.max(40, Number(aiSettings?.minDecisionConfidence ?? safe.aiMinConfidence) || 55);
    const fresh = ageMs <= maxAgeMin * 60000 && Number(plan?.effectiveUntil || Infinity) >= Date.now();
    const monitorEligible = plan?.monitorEligible !== false && aiRow.prediction?.monitorEligible !== false;
    const usable = fresh && confidence >= minConfidence && monitorEligible;
    const applied = usable && safe.aiAdaptive && aiSettings?.adaptiveStrategy !== false && plan?.changes?.length > 0;
    if (applied) effectiveSafe = { ...safe, config: { ...safe.config, ...(plan.suggestedConfig || {}) } };
    aiContext = {
      enabled: true, fresh, usable, applied, monitorEligible, ageMs, maxAgeMin, minConfidence,
      action: plan?.decision?.action || aiRow.decision?.action || "WATCH",
      confidence: Number.isFinite(confidence) ? confidence : null,
      probability: plan?.decision?.probability ?? aiRow.decision?.probability ?? null,
      label: plan?.label || "", window: plan?.window || "", fingerprint: plan?.fingerprint || aiRow.id || "",
      changes: plan?.changes || [], riskFlags: plan?.riskFlags || [], generatedAt: aiRow.generatedAt,
    };
  }
  // 陈旧缓存可用于界面连续性，但绝不允许产生买卖/止损类主动提醒。
  allowNotify = allowNotify && !minute?.stale;
  const previous = safe.runtime || null;
  let snapshot = monitorMod.evaluateMonitorSnapshot({ candles, minute, quote: { price: minute.price, name: minute.name }, monitor: effectiveSafe, previous });
  snapshot.ai = aiContext;
  const now = Date.now();
  const notifyTypes = safe.notifyTypes || {};
  let changed = false;

  if (snapshot.status === "ok") {
    // 正式入场后可自动进入“模拟持仓跟踪”；这不会被标记为真实成交。
    if (snapshot.stage === "entry" && !safe.position && safe.autoPaperPosition && allowNotify) {
      safe.position = { kind: "paper", entryPrice: snapshot.price, entryDate: new Date().toISOString().slice(0, 10), highestPrice: snapshot.price, createdAt: now };
      spec.position = safe.position;
      changed = true;
    } else if (snapshot.position && safe.position) {
      if (Number(snapshot.position.highestPrice) > Number(safe.position.highestPrice || 0)) {
        spec.position = { ...safe.position, highestPrice: snapshot.position.highestPrice };
        changed = true;
      }
    }

    const prevStage = previous?.stage || "idle";
    const lastNotifiedStage = previous?.lastNotifiedStage || "idle";
    const send = (key, payload, markStage = false) => {
      if (!allowNotify || settings.strategyAlerts === false || !alertAllowed(spec, key, now)) return false;
      dispatchMonitorAlert({ code, name: minute.name || spec.name || symbolName(code), price: snapshot.price, stage: snapshot.stage, details: monitorDetails(snapshot), ...payload });
      if (markStage) spec.runtime = { ...(spec.runtime || {}), lastNotifiedStage: snapshot.stage };
      changed = true; return true;
    };
    if (aiContext.usable && notifyTypes.ai !== false && aiSettings?.decisionAlerts !== false && aiContext.fingerprint !== previous?.lastAiFingerprint) {
      const bearish = ["REDUCE","EXIT"].includes(aiContext.action);
      const bullish = aiContext.action === "BUY";
      const noteworthy = bearish || bullish || aiContext.applied;
      if (noteworthy) {
        const changedText = aiContext.applied && aiContext.changes.length
          ? ` · 临时调整：${aiContext.changes.map((x) => `${x.label}${x.from}→${x.to}`).join("、")}`
          : "";
        const sent = send(`ai_${aiContext.action}`, {
          source: "local-ai",
          type: bearish ? "sell" : bullish ? "buy" : "info",
          severity: bearish ? "warning" : bullish ? "positive" : "info",
          title: bearish ? "🧠 AI卖出/风控时机变化" : bullish ? "🧠 AI买入时机增强" : "🧠 AI动态策略调整",
          message: `${aiContext.label || aiContext.action} · ${aiContext.window || "等待下一次复核"}${changedText}`,
        });
        if (sent) spec.runtime = { ...(spec.runtime || {}), lastAiFingerprint: aiContext.fingerprint };
      }
    }
    if ((snapshot.stage === "near_entry" || snapshot.stage === "entry_ready") && snapshot.stage !== lastNotifiedStage && notifyTypes.nearEntry !== false) {
      send("near_entry", { type: "near", severity: "info", title: "🟡 接近买点", message: snapshot.reason || `入场条件完成 ${snapshot.completion}%` }, true);
    }
    if (snapshot.stage === "entry" && snapshot.stage !== lastNotifiedStage && notifyTypes.entry !== false && !(aiContext.usable && aiContext.action === "BUY")) {
      send("entry", { type: "buy", severity: "positive", title: "🟢 策略买点触发", message: `${safe.strategyName} · ${snapshot.reason || "入场条件满足"}` }, true);
    }
    if (snapshot.stage === "risk" && snapshot.stage !== lastNotifiedStage && notifyTypes.risk !== false) {
      send("risk", { type: "risk", severity: "warning", title: "🟠 策略风险预警", message: snapshot.reason || "策略风险状态发生变化" }, true);
    }
    if (snapshot.stage === "exit" && snapshot.stage !== lastNotifiedStage && notifyTypes.exit !== false) {
      send("exit", { type: "sell", severity: "negative", title: "🔴 策略退出触发", message: `${safe.strategyName} · ${snapshot.reason || "退出条件满足"}` }, true);
      if (spec.position?.kind === "paper") { spec.position = null; changed = true; }
    }
    if (allowNotify && ["idle","holding"].includes(snapshot.stage)) spec.runtime = { ...(spec.runtime || {}), lastNotifiedStage: snapshot.stage };
    if (snapshot.change?.riskCrossed && snapshot.stage !== "exit" && notifyTypes.risk !== false) {
      send("risk_cross", { type: "risk", severity: "warning", title: "🟠 风险阈值突破", message: `当前风险 ${snapshot.risk}，高于策略上限 ${safe.config.maxRisk}` });
    }
    if (notifyTypes.event === true) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(now));
      if (snapshot.eventFlags?.highVolume && previous?.lastHighVolumeDay !== day) {
        spec.runtime = { ...(spec.runtime || {}), lastHighVolumeDay: day };
        send(`event_volume_${day}`, { type: "info", severity: "info", title: "📊 量能异动", message: `量比 ${snapshot.current?.daily?.volRatio?.toFixed?.(2) || "—"}，请结合策略状态观察。` });
      }
      if (snapshot.eventFlags?.high20 && previous?.lastHigh20Day !== day) {
        spec.runtime = { ...(spec.runtime || {}), lastHigh20Day: day };
        send(`event_high20_${day}`, { type: "info", severity: "info", title: "📈 接近20日新高", message: `距20日高点 ${snapshot.current?.daily?.pctFrom20dHigh?.toFixed?.(2) || "—"}%` });
      }
    }
  }

  spec.runtime = {
    ...(spec.runtime || {}),
    stage: snapshot.stage,
    action: snapshot.action,
    reason: snapshot.reason,
    price: snapshot.price,
    risk: snapshot.risk,
    completion: snapshot.completion,
    timing: snapshot.timing,
    levels: snapshot.levels,
    eventFlags: snapshot.eventFlags,
    checkedAt: now,
    error: snapshot.status === "ok" ? (minute?.stale ? "行情为缓存数据，已禁止主动提醒" : null) : "数据不足",
    dataStale: !!minute?.stale,
    dataProvider: minute?.provider || null,
    lastAlertAt: spec.runtime?.lastAlertAt || {},
    lastNotifiedStage: spec.runtime?.lastNotifiedStage || null,
    lastHighVolumeDay: spec.runtime?.lastHighVolumeDay || null,
    lastHigh20Day: spec.runtime?.lastHigh20Day || null,
    ai: aiContext,
    effectiveConfig: aiContext.applied ? effectiveSafe.config : null,
    lastAiFingerprint: spec.runtime?.lastAiFingerprint || previous?.lastAiFingerprint || null,
  };
  if (snapshot.status === "ok") changed = true; // 状态页需记住最近检查结果
  if (changed) scheduleMonitorSave();
  return snapshot;
}

async function runMonitoringOnce(force = false) {
  if (monitorPolling || settings.monitorEnabled === false) return monitorPublicState();
  monitorPolling = true;
  try {
    const monitorMod = await import(ENGINE_URL(["strategy-monitor.js"]));
    const session = monitorMod.chinaTradingSession(new Date());
    const allowNotify = settings.monitorOnlyMarketHours === false || session.open;
    if (!force && settings.monitorOnlyMarketHours !== false && !session.open) {
      pushMonitorState();
      return monitorPublicState();
    }
    const items = monitoredItems().slice(0, 60);
    let aiSettings = null;
    const aiByCode = new Map();
    if (items.some(([, spec]) => spec?.aiAssist === true)) {
      try {
        const st = await ensureLocalAiState(false);
        if (st.enabled) {
          aiSettings = st;
          const rows = (await localAiMod()).loadShadowHistory(DATA_DIR, 1000).items || [];
          for (const row of rows) {
            const key = String(row?.code || "");
            if (key && !aiByCode.has(key)) aiByCode.set(key, row);
          }
        }
      } catch {}
    }
    // 后台监控逐只让出数据源队列，避免挡住前台分析。
    for (let i = 0; i < items.length; i += 1) {
      await Promise.all(items.slice(i, i + 1).map(([code, spec]) => monitorOne(code, spec, { allowNotify, aiRow: aiByCode.get(code) || null, aiSettings }).catch((e) => {
        spec.runtime = { ...(spec.runtime || {}), checkedAt: Date.now(), error: e?.message || "监控失败" };
        scheduleMonitorSave();
      })));
    }
    pushMonitorState();
    return monitorPublicState();
  } finally { monitorPolling = false; }
}
function startMonitoring() {
  stopMonitoring();
  if (settings.monitorEnabled === false) return;
  runMonitoringOnce(false).catch(() => {});
  monitorTimer = setInterval(() => runMonitoringOnce(false).catch(() => {}), Math.max(10000, settings.monitorPollMs || 15000));
}
function stopMonitoring() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}


// ---- v1.9 可选本地 AI：独立 Python sidecar + Kronos 影子预测 + 在线校准 ----
let localAiState = null;
let localAiProc = null;
let localAiStopping = false;
let localAiInstallProc = null;
let localAiSeq = 0;
let localAiBuf = "";
const localAiPendingReq = new Map();
let localAiTimer = null;
let localAiLabelTimer = null;
const localAiPredictionInflight = new Map();
let localAiLabelBusy = false;
let localAiCycleBusy = false;
let localAiAutoCursor = 0;
let _localAiMod = null;
async function localAiMod() { if (!_localAiMod) _localAiMod = await import(ENGINE_URL(["local-ai.js"])); return _localAiMod; }
function pythonAiScript(name) {
  if (app.isPackaged) return join(process.resourcesPath, "app.asar.unpacked", "python-ai", name);
  return join(__dirname, "python-ai", name);
}
async function ensureLocalAiState(detect = false) {
  const mod = await localAiMod();
  if (!localAiState) {
    const loaded = mod.loadAiState(DATA_DIR);
    localAiState = mod.reconcileAiState(DATA_DIR, loaded);
    const reconciledChanged = loaded.engineStatus !== localAiState.engineStatus
      || loaded.lastError !== localAiState.lastError
      || JSON.stringify(loaded.installedModels || []) !== JSON.stringify(localAiState.installedModels || []);
    if (["running","installing"].includes(localAiState.engineStatus)) {
      localAiState.engineStatus = localAiState.installed ? "stopped" : "not_installed";
      localAiState = mod.saveAiState(DATA_DIR, localAiState);
    } else if (reconciledChanged) localAiState = mod.saveAiState(DATA_DIR, localAiState);
  }
  if (detect || !localAiState.hardware) {
    const hw = mod.detectHardware(DATA_DIR);
    localAiState.hardware = hw;
    localAiState.recommendation = hw.recommendation;
    if (!localAiState.installed && !localAiState.userSelectedProfile) {
      localAiState.profile = hw.recommendation.profile;
      localAiState.modelId = hw.recommendation.modelId;
    }
    localAiState = mod.saveAiState(DATA_DIR, localAiState);
  }
  return localAiState;
}
async function saveLocalAiState(patch = {}) {
  const mod = await localAiMod(); await ensureLocalAiState(false);
  localAiState = mod.saveAiState(DATA_DIR, { ...localAiState, ...patch, resources: { ...(localAiState.resources || {}), ...(patch.resources || {}) } });
  return localAiState;
}
function pushLocalAiEvent(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("local-ai-event", { time: Date.now(), ...data });
}
function handleLocalAiLine(line) {
  let row; try { row = JSON.parse(String(line || "")); } catch { return; }
  const waiter = localAiPendingReq.get(row.id);
  if (!waiter) return;
  localAiPendingReq.delete(row.id); clearTimeout(waiter.timer);
  row.ok ? waiter.resolve(row.result) : waiter.reject(new Error(row.error || "本地AI请求失败"));
}
async function startLocalAiService() {
  await ensureLocalAiState(false); const mod = await localAiMod();
  if (localAiProc && !localAiProc.killed) return { ok: true, alreadyRunning: true };
  const py = mod.enginePython(DATA_DIR);
  if (!py) throw new Error("本地AI Python 环境尚未安装");
  localAiStopping = false;
  localAiBuf = "";
  localAiProc = spawn(py, [pythonAiScript("service.py")], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, STOCKDESK_AI_HOME: LOCAL_AI_HOME, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  localAiProc.stdout.setEncoding("utf8"); localAiProc.stderr.setEncoding("utf8");
  localAiProc.stdout.on("data", (chunk) => {
    localAiBuf += chunk; let idx;
    while ((idx = localAiBuf.indexOf("\n")) >= 0) { const line = localAiBuf.slice(0, idx); localAiBuf = localAiBuf.slice(idx + 1); handleLocalAiLine(line); }
  });
  localAiProc.stderr.on("data", (x) => pushLocalAiEvent({ type: "log", level: "error", message: String(x).trim().slice(-800) }));
  localAiProc.on("exit", async (code) => {
    const expectedStop = localAiStopping || quitting || code === 0;
    localAiStopping = false;
    localAiProc = null;
    for (const [id, w] of localAiPendingReq) { clearTimeout(w.timer); w.reject(new Error("本地AI进程已退出")); localAiPendingReq.delete(id); }
    await saveLocalAiState({ engineStatus: expectedStop ? "stopped" : "error", lastError: expectedStop ? null : `AI进程退出(${code})` }).catch(() => {});
    pushLocalAiEvent({ type: "status", status: expectedStop ? "stopped" : "error" });
  });
  try {
    const health = await localAiRequest({ action: "status" }, 20000);
    await saveLocalAiState({ engineStatus: "running", health, lastError: null, installed: true });
    pushLocalAiEvent({ type: "status", status: "running", health });
    return { ok: true, health };
  } catch (e) { try { localAiProc?.kill(); } catch {} localAiProc = null; throw e; }
}
function localAiRequest(payload, timeoutMs = 120000) {
  if (!localAiProc || localAiProc.killed || !localAiProc.stdin?.writable) return Promise.reject(new Error("本地AI进程未运行"));
  const id = `ai_${Date.now()}_${++localAiSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { localAiPendingReq.delete(id); reject(new Error("本地AI请求超时")); }, timeoutMs);
    localAiPendingReq.set(id, { resolve, reject, timer });
    try { localAiProc.stdin.write(JSON.stringify({ id, ...payload }) + "\n"); }
    catch (e) { clearTimeout(timer); localAiPendingReq.delete(id); reject(e); }
  });
}
async function stopLocalAiService() {
  stopLocalAiLoop();
  if (!localAiProc) { if (localAiState?.installed) await saveLocalAiState({ engineStatus: "stopped", lastError: null }); return { ok: true }; }
  const proc = localAiProc;
  localAiStopping = true;
  try { await localAiRequest({ action: "shutdown" }, 3000); } catch {}
  if (localAiProc === proc) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 800);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (localAiProc === proc) { try { proc.kill(); } catch {} }
  await saveLocalAiState({ engineStatus: "stopped" });
  return { ok: true };
}
async function startLocalAiInstall(modelId) {
  const mod = await localAiMod(); const st = await ensureLocalAiState(true);
  const spec = mod.modelById(modelId);
  if (!spec?.installable) return { ok: false, error: "该实验模型需要本地训练，暂无可直接安装权重。" };
  if (localAiInstallProc) return { ok: false, error: "已有AI安装任务正在运行" };
  if (!st.hardware?.python?.supported) return { ok: false, error: "需要先安装 Python 3.10+，然后重新检测硬件。" };
  const py = st.hardware.python.command;
  const prefix = st.hardware.python.argsPrefix || [];
  await saveLocalAiState({ engineStatus: "installing", lastError: null, ...(spec.family === "Kronos" ? { modelId, userSelectedProfile: true } : {}) });
  localAiInstallProc = spawn(py, [...prefix, pythonAiScript("install.py"), "--home", LOCAL_AI_HOME, "--model", modelId], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  let outBuf = "";
  let errBuf = "";
  const consume = (chunk, isErr = false) => {
    let buf = (isErr ? errBuf : outBuf) + String(chunk); let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1); if (!line) continue;
      try { pushLocalAiEvent(JSON.parse(line)); } catch { pushLocalAiEvent({ type: "log", level: isErr ? "error" : "info", message: line.slice(-800) }); }
    }
    if (isErr) errBuf = buf; else outBuf = buf;
  };
  localAiInstallProc.stdout?.on("data", (x) => consume(x)); localAiInstallProc.stderr?.on("data", (x) => consume(x, true));
  localAiInstallProc.on("exit", async (code) => {
    localAiInstallProc = null;
    if (code === 0) {
      const models = [...new Set([...(localAiState?.installedModels || []), modelId])];
      await saveLocalAiState({ installed: true, installedModels: models, engineStatus: "stopped", lastError: null });
      pushLocalAiEvent({ type: "installed", modelId, message: `${spec.name} 安装完成` });
    } else {
      await saveLocalAiState({ engineStatus: "error", lastError: `安装失败(${code})` });
      pushLocalAiEvent({ type: "error", message: `AI安装失败，退出码 ${code}` });
    }
  });
  return { ok: true, started: true, model: spec };
}
async function runLocalAiShadow(code, strategyConfig = null, opts = {}) {
  const safeCode = String(code || ""); if (!safeCode) throw new Error("股票代码为空");
  if (localAiPredictionInflight.has(safeCode)) return localAiPredictionInflight.get(safeCode);
  const task = runLocalAiShadowOnce(safeCode, strategyConfig, opts).finally(() => localAiPredictionInflight.delete(safeCode));
  localAiPredictionInflight.set(safeCode, task);
  return task;
}
async function runLocalAiShadowOnce(safeCode, strategyConfig = null, opts = {}) {
  const st = await ensureLocalAiState(false); const mod = await localAiMod();
  if (!st.enabled && !opts.manual) throw new Error("本地AI增强未启用");
  if (!(st.installedModels || []).includes(st.modelId)) throw new Error(`当前模型 ${st.modelId} 尚未安装`);
  const [candles, regime, minute, strategyMod, signalMod] = await Promise.all([
    cachedStrategyHistory(safeCode), Promise.resolve(cachedMarketRegime()), fetchMinuteDetail(safeCode).catch(() => null), import(ENGINE_URL(["strategy-lab.js"])), mods(),
  ]);
  const strategy = strategyMod.runStrategyLab(candles, strategyConfig || { mode: "smart", profile: "balanced" }, { marketRegime: regime, scan: false });
  const validCandles = candles.filter((x) => Number.isFinite(Number(x?.open)) && Number.isFinite(Number(x?.high)) && Number.isFinite(Number(x?.low)) && Number.isFinite(Number(x?.close)) && Number(x.close) > 0);
  let pred;
  if (validCandles.length < 40) {
    pred = mod.buildColdStartPrediction(validCandles, { code: safeCode, generatedAt: Date.now() });
  } else {
    await startLocalAiService();
    pred = await localAiRequest({
      action: "predict", code: safeCode, modelId: st.modelId, candles: validCandles.map((x) => ({ ...x, amount: Number(x.amount) || Number(x.volume || 0) * ((Number(x.open) + Number(x.close)) / 2 || 0) })),
      predLen: 5, sampleRuns: st.profile === "advanced" ? 5 : st.profile === "lite" ? 2 : 3, onlineHorizonMin: 30,
      extra: { strategyScore: strategy.current?.values?.score ?? null, risk: strategy.current?.values?.risk ?? null, changePercent: minute?.changePercent ?? null, regimeScore: regime?.score ?? null },
    }, 180000);
  }
  const timing = signalMod.computeTiming({
    points: minute?.points || [], prevClose: minute?.prevClose, price: minute?.price,
    direction: strategy?.current?.matched ? "bullish" : "neutral",
  });
  const monitorSpec = monitorStore.items?.[safeCode] || null;
  const adaptivePlan = mod.buildAdaptiveAiPlan(pred, strategy, {
    generatedAt: pred.generatedAt,
    maxAgeMin: st.maxPredictionAgeMin,
    intradayConfirmed: timing?.type === "buy" || !Array.isArray(minute?.points) || minute.points.length < 5,
    completion: monitorSpec?.runtime?.completion,
    position: monitorSpec?.position || null,
  });
  const decision = adaptivePlan.decision;
  const price = Number(minute?.price) || Number(candles.at(-1)?.close) || null;
  const row = mod.appendShadowHistory(DATA_DIR, {
    code: safeCode, name: minute?.name || symbolName(safeCode), generatedAt: Date.now(), price,
    modelId: st.modelId, profile: st.profile, prediction: pred, decision, adaptivePlan, timing,
    strategy: { mode: strategy.mode, presetId: strategy.config?.presetId, config: strategy.config, matched: strategy.current?.matched, current: strategy.current, regimeFit: strategy.regimeFit },
  });
  // 快速适应层使用30分钟延迟标签。Kronos本身仍是慢速金融K线基座，不盘中破坏官方权重。
  if (price > 0 && pred?.features) {
    const monitorMod = await import(ENGINE_URL(["strategy-monitor.js"]));
    const session = monitorMod.chinaTradingSession(new Date());
    const remain = session.session === "morning" ? 690 - session.beijingMinute : session.session === "afternoon" ? 900 - session.beijingMinute : -1;
    // v1.9 在线标签只在同一连续交易时段内成熟，避免午休/收盘后的静态价格污染快速学习层。
    if (session.open && remain >= 30) {
      const pending = mod.loadPendingLabels(DATA_DIR); const items = Array.isArray(pending.items) ? pending.items : [];
      items.push({ id: row.id, code: safeCode, horizonMin: 30, createdAt: Date.now(), targetAt: Date.now() + 30 * 60 * 1000, basePrice: price, features: pred.features });
      pending.items = items.slice(-1000); mod.savePendingLabels(DATA_DIR, pending);
    }
  }
  await saveLocalAiState({ lastPrediction: row, health: { ...(st.health || {}), online: pred.online || null }, lastError: null });
  pushLocalAiEvent({ type: "prediction", row }); return row;
}
async function processMatureLocalAiLabels() {
  if (localAiLabelBusy) return;
  localAiLabelBusy = true;
  try {
  const st = await ensureLocalAiState(false); if (!st.enabled || !st.installed) return;
  const mod = await localAiMod(); const pending = mod.loadPendingLabels(DATA_DIR); const now = Date.now(); const keep = [];
  for (const item of Array.isArray(pending.items) ? pending.items : []) {
    if (Number(item.targetAt) > now) { keep.push(item); continue; }
    try {
      await startLocalAiService(); const minute = await fetchMinuteDetail(item.code); const price = Number(minute?.price);
      if (!(price > 0) || !(Number(item.basePrice) > 0)) { if (now - Number(item.targetAt) < 6 * 3600000) keep.push(item); continue; }
      const label = price > Number(item.basePrice);
      const result = await localAiRequest({ action: "update_online", code: item.code, horizonMin: item.horizonMin || 30, features: item.features || {}, label }, 30000);
      pushLocalAiEvent({ type: "learn", code: item.code, label, result });
    } catch { if (now - Number(item.targetAt) < 6 * 3600000) keep.push(item); }
  }
  pending.items = keep; mod.savePendingLabels(DATA_DIR, pending);
  } finally { localAiLabelBusy = false; }
}
async function runLocalAiAutoCycle() {
  if (localAiCycleBusy) return;
  localAiCycleBusy = true;
  try {
  const st = await ensureLocalAiState(false); if (!st.enabled || !st.autoShadow || st.mode !== "shadow") return;
  // 自动影子预测仅在A股连续交易时段运行，避免夜间/午休反复占用CPU/GPU并用静态价格生成无意义预测。
  const monitorMod = await import(ENGINE_URL(["strategy-monitor.js"]));
  const session = monitorMod.chinaTradingSession(new Date());
  if (!session.open) return;
  const allItems = monitoredItems().filter(([,x]) => x?.enabled !== false && x?.aiAssist === true);
  const batch = allItems.length <= 3 ? allItems : Array.from({ length: 3 }, (_, i) => allItems[(localAiAutoCursor + i) % allItems.length]);
  if (allItems.length) localAiAutoCursor = (localAiAutoCursor + batch.length) % allItems.length;
  for (const [code, spec] of batch) { try { await runLocalAiShadow(code, { ...(spec.config || {}), mode: "manual" }, { manual: false }); } catch (e) { await saveLocalAiState({ lastError: e?.message || String(e) }); } }
  } finally { localAiCycleBusy = false; }
}
function stopLocalAiLoop() { if (localAiTimer) clearInterval(localAiTimer); if (localAiLabelTimer) clearInterval(localAiLabelTimer); localAiTimer = null; localAiLabelTimer = null; }
async function startLocalAiLoop() {
  stopLocalAiLoop(); const st = await ensureLocalAiState(false); if (!st.enabled) return;
  localAiLabelTimer = setInterval(() => processMatureLocalAiLabels().catch(() => {}), 60 * 1000);
  processMatureLocalAiLabels().catch(() => {});
  if (st.autoShadow) {
    const min = Math.max(5, Math.min(120, Number(st.autoIntervalMin) || 15));
    localAiTimer = setInterval(() => runLocalAiAutoCycle().catch(() => {}), min * 60 * 1000);
  }
}

// ---- 窗口 ----
let mainWindow = null;
let tray = null;
let quitting = false;

function createWindow() {
  const bounds = settings.winBounds || { width: 1280, height: 800 };
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1024, minHeight: 660,
    title: "StockDesk 盯盘",
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    titleBarStyle: "hidden",
    vibrancy: "under-window",
    visualEffectState: "active",
    hasShadow: true,
    autoHideMenuBar: true,
    icon: join(__dirname, "renderer", "assets", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (e) => {
    if (!quitting && settings.closeToTray !== false && tray) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.on("blur", () => { if (settings.pollMs >= 5000) return; });
  mainWindow.on("hide", () => { windowHidden = true; });
  mainWindow.on("show", () => { windowHidden = false; pollOnce(true); }); // 后台目标价/策略监控继续；仅暂停隐藏窗口的渲染推送
  // 窗口位置/尺寸记忆：防抖 500ms，避免拖动时高频写盘
  let boundsTimer = null;
  const rememberBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) settings.winBounds = mainWindow.getBounds();
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveSettings(), 500);
  };
  mainWindow.on("resize", rememberBounds);
  mainWindow.on("move", rememberBounds);
  mainWindow.on("close", () => { clearTimeout(boundsTimer); saveSettings(); });
}

function createTray() {
  try {
    tray = new Tray(join(__dirname, "renderer", "assets", "icon.png"));
    tray.setToolTip("StockDesk 盯盘");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: "立即刷新行情", click: () => pollOnce(true) },
      { type: "separator" },
      { label: "退出", click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch {}
}

// ---- v1.1 市场状态：4 个代表性指数合成 ----
async function getMarketRegime() {
  const hit = cacheGet(marketCache, "regime");
  if (hit) return { ...hit, cached: true };
  return coalesce(marketInflight, "regime", async () => {
  const specs = [
    ["sh000001", "上证指数"],
    ["sh000300", "沪深300"],
    ["sz399006", "创业板指"],
    ["sh000852", "中证1000"],
  ];
  const m = await mods();
  const rows = await Promise.all(specs.map(async ([code, name]) => {
    const [candles, minute] = await Promise.all([cachedKline(code, "day"), fetchMinuteDetail(code)]);
    const daily = m.analyzeDaily(candles);
    const signal = m.analyzeSignals(daily);
    return { code, name: minute.name || name, changePercent: minute.changePercent, daily, signal };
  }));
  const { classifyMarketRegime } = await import(ENGINE_URL(["market.js"]));
  const result = classifyMarketRegime(rows);
  result.updatedAt = Date.now();
  cacheSet(marketCache, "regime", result, MARKET_TTL, 1);
  return result;
  });
}

function cachedMarketRegime() {
  const hit = cacheGet(marketCache, "regime");
  return hit ? { ...hit, cached: true } : null;
}

// ---- v1.3 综合研报 / AI 上下文 ----
async function buildResearchReport(code, force = false) {
  const key = String(code || "");
  if (!force) {
    const hit = cacheGet(researchReportCache, key);
    if (hit) return { ...hit, cached: true };
  }
  const [{ collectResearchSupplement, buildStructuredResearchReport }, tech, strategyMod, globalMod] = await Promise.all([
    import(ENGINE_URL(["research-report.js"])),
    import(ENGINE_URL(["technical-indicators.js"])),
    import(ENGINE_URL(["strategy-lab.js"])),
    import(ENGINE_URL(["global-context.js"])),
  ]);
  const [signal, market, supplement, history] = await Promise.all([
    signalService.get(key, force),
    Promise.resolve(cachedMarketRegime()),
    collectResearchSupplement(key),
    cachedStrategyHistory(key),
  ]);
  const globalContext = supplement?.error ? null : await globalMod.collectGlobalContext({
    code:key, name:supplement?.name || key, industry:supplement?.quote?.industry || "", region:supplement?.quote?.region || "", maxAssets:8
  }).catch((e)=>({ enabled:true, version:"1.9.3", error:e?.message||String(e), assets:[], policies:[], industryNews:[], dataGaps:["全球关联分析获取失败"] }));
  const strategy = history?.length ? strategyMod.runStrategyLab(history, { mode: "smart", profile: "balanced" }, { marketRegime: market, scan: true }) : null;
  const techCandles = history?.length ? history : await cachedKline(key, "day");
  const fullIndicators = tech.computeTechnicalIndicators(tech.INDICATOR_CATALOG.map((x) => x.id), techCandles, { floatShares: supplement?.quote?.floatShares }, settings.indicatorParams || {});
  const indicatorAnalysis = tech.analyzeTechnicalIndicatorSet(fullIndicators, techCandles);
  const indicators = tech.indicatorSnapshot(tech.INDICATOR_CATALOG.map((x) => x.id), techCandles, { floatShares: supplement?.quote?.floatShares }, settings.indicatorParams || {});
  const report = buildStructuredResearchReport({ code: key, signal, strategy, market, indicators, indicatorAnalysis, supplement, globalContext });
  if (!report.error) cacheSet(researchReportCache, key, report, RESEARCH_TTL, RESEARCH_MAX);
  return report;
}

// ---- IPC 处理器 ----
function registerIpc() {
  ipcMain.handle("get-state", () => ({ watchlist, settings: { pollMs: settings.pollMs, alerts: settings.priceAlerts !== false, priceAlerts: settings.priceAlerts !== false, strategyAlerts: settings.strategyAlerts !== false, monitorEnabled: settings.monitorEnabled !== false, monitorPollMs: settings.monitorPollMs, monitorCooldownMin: settings.monitorCooldownMin, monitorOnlyMarketHours: settings.monitorOnlyMarketHours !== false, theme: settings.theme, opacity: settings.opacity, closeToTray: settings.closeToTray !== false, pauseWhenHidden: settings.pauseWhenHidden !== false, lastCode: settings.lastCode || null, lastPanel: settings.lastPanel || "signal", lastReportTab: settings.lastReportTab || "overview", indicatorParams: settings.indicatorParams || {}, dataSources: dataHub.getDataSourceConfig() }, dataSources: dataHub.getDataSourceStatus(), llm: publicLlmState() }));

  ipcMain.handle("set-watchlist", (_e, groups) => {
    watchlist = { groups: (groups || []).map((g) => ({ name: String(g.name || "分组").slice(0, 32), symbols: normalizeSymbolList(g.symbols) })) };
    if (!watchlist.groups.length) watchlist.groups.push({ name: "分组1", symbols: [] });
    lastAlerts.clear();
    const keep = new Set(allSymbols().map((x) => x.code));
    for (const code of Object.keys(monitorStore.items || {})) if (!keep.has(code)) delete monitorStore.items[code];
    saveWatchlist(); saveMonitorStore(); pushMonitorState();
    return watchlist;
  });

  ipcMain.handle("set-settings", (_e, patch) => {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "pollMs") settings.pollMs = Math.max(2000, Math.min(60000, Number(v) || 5000));
      else if (k === "alerts" || k === "priceAlerts") { settings.alerts = !!v; settings.priceAlerts = !!v; }
      else if (k === "strategyAlerts") settings.strategyAlerts = !!v;
      else if (k === "monitorEnabled") settings.monitorEnabled = !!v;
      else if (k === "monitorPollMs") settings.monitorPollMs = Math.max(10000, Math.min(300000, Number(v) || 15000));
      else if (k === "monitorCooldownMin") settings.monitorCooldownMin = Math.max(1, Math.min(360, Number(v) || 30));
      else if (k === "monitorOnlyMarketHours") settings.monitorOnlyMarketHours = !!v;
      else if (k === "theme") settings.theme = v === "light" ? "light" : "dark";
      else if (k === "opacity") settings.opacity = Math.max(30, Math.min(95, Math.round(Number(v) || 72)));
      else if (k === "closeToTray") settings.closeToTray = !!v;
      else if (k === "pauseWhenHidden") settings.pauseWhenHidden = !!v;
      else if (k === "dataSources") settings.dataSources = dataHub.sanitizeConfig(v);
      else settings[k] = v;
    }
    saveSettings();
    configureDataHub();
    startPolling();
    startMonitoring();
    return { pollMs: settings.pollMs, alerts: settings.priceAlerts !== false, priceAlerts: settings.priceAlerts !== false, strategyAlerts: settings.strategyAlerts !== false, monitorEnabled: settings.monitorEnabled !== false, monitorPollMs: settings.monitorPollMs, monitorCooldownMin: settings.monitorCooldownMin, monitorOnlyMarketHours: settings.monitorOnlyMarketHours !== false, theme: settings.theme, opacity: settings.opacity, closeToTray: settings.closeToTray !== false, pauseWhenHidden: settings.pauseWhenHidden !== false };
  });


  // v1.9.2 · 多数据源管理。密钥独立用 safeStorage 保存，不写 settings.json。
  ipcMain.handle("get-data-source-state", () => { configureDataHub(); return { ...dataHub.getDataSourceStatus(), secretIds:Object.keys(readDataSourceSecrets()) }; });
  ipcMain.handle("set-data-source-config", (_e, patch = {}) => {
    settings.dataSources = dataHub.sanitizeConfig(patch); saveSettings(); configureDataHub();
    return { ...dataHub.getDataSourceStatus(), secretIds:Object.keys(readDataSourceSecrets()) };
  });
  ipcMain.handle("set-data-source-secret", (_e, id, secret) => { const persisted=writeDataSourceSecret(id,secret); configureDataHub(); return { ...persisted, state:{ ...dataHub.getDataSourceStatus(), secretIds:Object.keys(readDataSourceSecrets()) } }; });
  ipcMain.handle("test-data-sources", async (_e, sampleCode = "sh600519") => { configureDataHub(); return dataHub.testDataSources(sampleCode); });
  ipcMain.handle("reset-data-source-breakers", (_e, id = null) => dataHub.resetProviderBreaker(id));

  ipcMain.handle("poll-now", () => { pollOnce(true); return true; });

  ipcMain.handle("get-quotes", async () => {
    const symbols = allSymbols();
    const batch = await dataHub.getQuotes(symbols.map((s) => s.code));
    const quoteMap = new Map((batch.rows || []).map((q) => [String(q.symbol || normalizeApiCode(q.code)), q]));
    const rows = symbols.map((sym) => {
      const q = quoteMap.get(normalizeApiCode(sym.code)) || null;
      const row = { code:sym.code, name:q?.name || sym.name || sym.code, trigger:"none", live:!!q, provider:q?._provider || batch.provider || null, stale:!!q?._stale };
      if (sym.buyPrice !== undefined) row.buyPrice=sym.buyPrice; if (sym.sellPrice !== undefined) row.sellPrice=sym.sellPrice;
      if (q) Object.assign(row,{price:q.price,changePercent:q.changePercent,changeAmount:q.changeAmount,high:q.high,low:q.low,volume:q.volume,amount:q.amount,prevClose:q.prevClose,trigger:computeTrigger(q.price,sym.buyPrice,sym.sellPrice)});
      return row;
    });
    return { rows, updatedAt:Date.now(), provider:batch.provider || null, stale:!!batch.stale, error:batch.error || null };
  });

  ipcMain.handle("get-kline", async (_e, code, period) => {
    const safePeriod = ["day", "week", "month"].includes(period) ? period : "day";
    const history = await cachedKline(code, safePeriod);
    const candles = safePeriod === "day" ? history.slice(-180) : history;
    return { code, period: safePeriod, candles };
  });

  ipcMain.handle("get-minute", async (_e, code) => fetchMinuteDetail(code));

  ipcMain.handle("get-market-regime", async () => getMarketRegime());

  ipcMain.handle("get-signal", async (_e, code, force = false) => signalService.get(code, !!force));

  // v1.5 · 策略实验室：智能推荐 + 手动高级；长历史、次日开盘执行、成本/止损/参数稳定性扫描。
  ipcMain.handle("get-strategy-lab", async (_e, code, config = {}) => {
    const safeCode = String(code || "");
    const cacheKey = `${safeCode}:${JSON.stringify(config || {})}`;
    const hit = cacheGet(strategyLabCache, cacheKey);
    if (hit) return { ...hit, cached: true };
    const candles = await cachedStrategyHistory(safeCode);
    const [{ runStrategyLab }, regime] = await Promise.all([
      import(ENGINE_URL(["strategy-lab.js"])),
      Promise.resolve(cachedMarketRegime()),
    ]);
    const result = runStrategyLab(candles, config || {}, { marketRegime: regime, scan: true });
    result.code = safeCode;
    result.historyBars = candles.length;
    result.marketRegime = regime ? { state: regime.state, label: regime.label, score: regime.score, risk: regime.risk } : null;
    if (result.status === "ok") cacheSet(strategyLabCache, cacheKey, result, STRATEGY_LAB_TTL, STRATEGY_LAB_MAX);
    return result;
  });

  // v1.6 · 策略监控与提醒中心
  ipcMain.handle("get-monitor-state", () => monitorPublicState());
  ipcMain.handle("set-strategy-monitor", async (_e, code, patch = {}) => {
    const key = String(code || "");
    if (!key) return { ok: false, error: "股票代码为空" };
    const mod = await import(ENGINE_URL(["strategy-monitor.js"]));
    const prev = monitorStore.items[key] || {};
    if (patch.remove === true) {
      delete monitorStore.items[key]; saveMonitorStore(); pushMonitorState();
      return { ok: true, state: monitorPublicState() };
    }
    const merged = { ...prev, ...patch, config: patch.config ? { ...(prev.config || {}), ...patch.config } : (prev.config || {}), notifyTypes: { ...(prev.notifyTypes || {}), ...(patch.notifyTypes || {}) }, position: patch.position === undefined ? prev.position : patch.position };
    const normalized = mod.normalizeMonitorConfig(merged);
    monitorStore.items[key] = {
      ...normalized,
      name: String(patch.name || prev.name || symbolName(key)).slice(0, 80),
      runtime: prev.runtime || {},
      updatedAt: Date.now(),
    };
    saveMonitorStore(); startMonitoring();
    await runMonitoringOnce(true).catch(() => {});
    return { ok: true, monitor: { code: key, ...monitorStore.items[key] }, state: monitorPublicState() };
  });
  ipcMain.handle("set-monitor-position", async (_e, code, position = null) => {
    const key = String(code || ""); const spec = monitorStore.items[key];
    if (!spec) return { ok: false, error: "请先启用该股票的策略监控" };
    const mod = await import(ENGINE_URL(["strategy-monitor.js"]));
    if (position == null) spec.position = null;
    else {
      const p = mod.normalizePosition({ ...position, kind: position.kind === "paper" ? "paper" : "actual" });
      if (!p) return { ok: false, error: "持仓成本价无效" };
      spec.position = p;
    }
    spec.runtime = { ...(spec.runtime || {}), stage: position ? "holding" : "idle" };
    spec.updatedAt = Date.now(); saveMonitorStore();
    await runMonitoringOnce(true).catch(() => {}); pushMonitorState();
    return { ok: true, monitor: { code: key, ...spec }, state: monitorPublicState() };
  });
  ipcMain.handle("check-monitors-now", async () => runMonitoringOnce(true));
  ipcMain.handle("get-alert-history", (_e, limit = 100) => ({ items: (alertStore.items || []).slice(0, Math.max(1, Math.min(500, Number(limit) || 100))), unreadCount: (alertStore.items || []).filter((x) => !x.read).length }));
  ipcMain.handle("mark-alerts-read", (_e, ids = null) => {
    const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    for (const x of alertStore.items || []) if (!wanted || wanted.has(String(x.id))) x.read = true;
    saveAlertStore(); pushMonitorState(); return { ok: true, unreadCount: (alertStore.items || []).filter((x) => !x.read).length };
  });
  ipcMain.handle("clear-alert-history", () => { alertStore = { version: 1, items: [] }; saveAlertStore(); pushMonitorState(); return { ok: true }; });

  // v1.3 · 技术指标分屏
  ipcMain.handle("get-indicator-catalog", async () => {
    const t = await import(ENGINE_URL(["technical-indicators.js"]));
    return { rows: t.getIndicatorCatalog().map((x) => ({ ...x, currentParams: t.sanitizeIndicatorParams(x.id, settings.indicatorParams?.[x.id] || {}) })) };
  });
  ipcMain.handle("set-indicator-params", async (_e, id, params = {}) => {
    const t = await import(ENGINE_URL(["technical-indicators.js"]));
    const key = String(id || "").toUpperCase();
    if (!t.INDICATOR_CATALOG.some((x) => x.id === key)) return { error: "未知指标" };
    settings.indicatorParams[key] = t.sanitizeIndicatorParams(key, params);
    saveSettings(); researchReportCache.clear?.(); signalService.clear();
    return { ok: true, id: key, params: settings.indicatorParams[key] };
  });
  ipcMain.handle("reset-indicator-params", async (_e, id = null) => {
    const t = await import(ENGINE_URL(["technical-indicators.js"]));
    if (id) { const key=String(id).toUpperCase(); delete settings.indicatorParams[key]; } else settings.indicatorParams = {};
    saveSettings(); researchReportCache.clear?.(); signalService.clear();
    return { ok: true, rows: t.getIndicatorCatalog().map((x) => ({ ...x, currentParams: t.sanitizeIndicatorParams(x.id, settings.indicatorParams?.[x.id] || {}) })) };
  });

  ipcMain.handle("get-indicators", async (_e, code, period, ids) => {
    const p = ["day", "week", "month"].includes(period) ? period : "day";
    const candles = await cachedKline(String(code || ""), p);
    const t = await import(ENGINE_URL(["technical-indicators.js"]));
    let floatShares = null;
    if (p === "day" && (ids || []).map(String).some((x) => x.toUpperCase() === "MCST")) {
      try { const em = await import(ENGINE_URL(["market-fetchers.js"])); floatShares = (await em.emQuote(code))?.floatShares ?? null; } catch {}
    }
    return { code, period: p, times: candles.map((c) => c.time), rows: t.computeTechnicalIndicators(ids, candles, { floatShares }, settings.indicatorParams || {}) };
  });

  // v1.3 · 规则综合研报
  ipcMain.handle("get-research-report", async (_e, code, force = false) => {
    const key = `${String(code || "")}:${force ? "force" : "normal"}`;
    return coalesce(researchReportInflight, key, () => buildResearchReport(code, !!force));
  });

  // v1.3 · LLM 设置。API key 永不回传到渲染进程。
  ipcMain.handle("get-llm-state", async () => {
    const llm = await import(ENGINE_URL(["llm-service.js"]));
    return { ...publicLlmState(), presets: llm.PROVIDER_PRESETS, pricing: llm.lookupPricing(llmSettings.provider, llmSettings.model) };
  });
  ipcMain.handle("set-llm-settings", async (_e, patch = {}, apiKey = null, clearKey = false) => {
    llmSettings = sanitizeLlmSettings(patch || {}); saveLlmSettings();
    let keyResult = { persisted: !!readLlmKey() };
    if (clearKey) keyResult = writeLlmKey("");
    else if (apiKey != null && String(apiKey).trim()) keyResult = writeLlmKey(apiKey);
    return { ...publicLlmState(), keyResult };
  });
  ipcMain.handle("test-llm", async (_e, patch = {}, apiKey = null) => {
    const cfg = sanitizeLlmSettings(patch || {});
    const key = String(apiKey || "").trim() || readLlmKey();
    const llm = await import(ENGINE_URL(["llm-service.js"]));
    const result = await llm.testLlmConnection(cfg, key);
    return { ...result, pricing: llm.lookupPricing(cfg.provider, cfg.model) };
  });
  ipcMain.handle("estimate-ai-report", async (_e, code) => {
    const [{ compactForLlm }, llm] = await Promise.all([import(ENGINE_URL(["research-report.js"])), import(ENGINE_URL(["llm-service.js"]))]);
    const report = compactForLlm(await buildResearchReport(code));
    if (report?.error) return report;
    const prompt = llm.buildPrompt(report);
    return { estimate: llm.estimateCost({ inputText: prompt.combinedForEstimate, expectedOutputTokens: null, settings: llmSettings }), pricingUpdatedAt: llm.resolvePricing(llmSettings)?.updatedAt || null, llm: publicLlmState() };
  });
  ipcMain.handle("generate-ai-report", async (_e, code) => {
    const [{ compactForLlm }, llm] = await Promise.all([import(ENGINE_URL(["research-report.js"])), import(ENGINE_URL(["llm-service.js"]))]);
    const key = readLlmKey();
    if (!key) return { error: "尚未配置 API Key，请先打开 AI 模型设置。" };
    let report = compactForLlm(await buildResearchReport(code));
    if (report?.error) return report;
    try {
      let researchAgent = null;
      if (llmSettings.enableResearchAgent !== false) {
        try {
          const agentMod = await import(ENGINE_URL(["research-agent.js"]));
          researchAgent = await agentMod.runAutonomousResearchAgent(report, llmSettings, key, {
            mode: llmSettings.researchMode || "standard",
            allowPageRead: llmSettings.researchAllowPageRead !== false,
          });
          report = { ...report, externalResearch: agentMod.compactResearchAgentResult(researchAgent) };
        } catch (e) {
          report = { ...report, externalResearch: {
            enabled: true, agentVersion: "1.8.0", mode: llmSettings.researchMode || "standard", status: "error",
            error: e?.message || String(e), sources: [], rounds: [],
            securityNotice: "LLM 自主外部研究失败，不影响本地数据与最终研报生成。",
          } };
        }
      }
      const generated = await llm.generateAiResearchReport(report, llmSettings, key);
      if (researchAgent?.rawAttempts?.length) {
        generated.rawAttempts = [...researchAgent.rawAttempts, ...(generated.rawAttempts || [])];
        const ru=researchAgent.modelUsage||{}, u=generated.usage||{};
        generated.usage={
          inputTokens:(Number(ru.inputTokens)||0)+(Number(u.inputTokens)||0)||null,
          outputTokens:(Number(ru.outputTokens)||0)+(Number(u.outputTokens)||0)||null,
          reasoningTokens:(Number(ru.reasoningTokens)||0)+(Number(u.reasoningTokens)||0)||null,
          visibleOutputTokens:(Number(ru.visibleOutputTokens)||0)+(Number(u.visibleOutputTokens)||0)||null,
          totalTokens:(Number(ru.totalTokens)||0)+(Number(u.totalTokens)||0)||null,
        };
        generated.actualCost=llm.actualCost(generated.usage,llmSettings);
        generated.researchAgentLog={...researchAgent,rawAttempts:undefined};
      }
      generated.webResearch = report.externalResearch ? {
        enabled:true, agent:true, mode:report.externalResearch.mode||null, status:report.externalResearch.status||null,
        sourceCount:report.externalResearch.sources?.length||0, roundCount:report.externalResearch.rounds?.length||0,
        stopReason:report.externalResearch.stopReason||null, error:report.externalResearch.error||null,
      } : { enabled:false, sourceCount:0 };
      const rawOutput = saveLlmRawOutputBundle(code, report, generated);
      // 原始响应只写独立文件，不重复塞进历史档案/IPC，避免超大 JSON 占内存。
      const { rawAttempts, researchAgentLog, ...resultCore } = generated;
      const result = { ...resultCore, rawOutput };
      const archive = saveAiReportArchive(code, report, result);
      return { ...result, archiveId: archive.id, archiveMeta: archive };
    }
    catch (e) { return { error: e.message || String(e) }; }
  });

  ipcMain.handle("open-llm-raw-output-dir", async (_e, targetDir = null) => {
    const dir = targetDir ? String(targetDir) : llmRawOutputBaseDir();
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const err = await shell.openPath(dir);
    return err ? { error: err, path: dir } : { ok: true, path: dir };
  });

  // v1.3.1 · AI 研报历史、恢复与导出。历史只在本机 ~/.stockdesk/ai-reports/。
  ipcMain.handle("get-ai-report-history", (_e, code = null, limit = 30) => ({ rows: listAiReportArchives(code, limit) }));
  ipcMain.handle("get-ai-report-entry", (_e, id) => {
    const archive = readAiReportArchive(id);
    return archive ? { archive } : { error: "未找到该历史研报。" };
  });
  ipcMain.handle("delete-ai-report-entry", (_e, id) => ({ ok: deleteAiReportArchive(id) }));
  ipcMain.handle("export-ai-report", async (_e, id, format = "docx") => {
    try { return await exportAiArchive(id, format); }
    catch (e) { return { error: e.message || String(e) }; }
  });

  ipcMain.handle("get-screen", async (_e, board, method, maxResults = 0) => {
    const { loadIndustries, screenSector } = await import(ENGINE_URL(["screener.js"]));
    const m = ["tech", "value", "hybrid"].includes(method) ? method : "hybrid";
    const mrRaw = Number(maxResults);
    const mr = Number.isFinite(mrRaw) && mrRaw > 0 ? Math.min(500, Math.max(1, Math.floor(mrRaw))) : 0;
    if (!board) {
      const { boards, source, fromCache } = await loadIndustries("auto");
      return { method: m, source, fromCache, boards: (boards || []).map((b) => ({
        code: String(b.code), name: String(b.name ?? b.code),
        count: Number.isFinite(Number(b.count)) ? Number(b.count) : undefined,
        changePct: Number.isFinite(Number(b.changePct)) ? Number(b.changePct) : undefined,
      })) };
    }
    const source = String(board).toUpperCase().startsWith("BK") ? "eastmoney" : "sina";
    return await screenSector(source, board, m, mr);
  });

  ipcMain.handle("get-sectors", async () => {
    const { DATA_SOURCES } = await mods();
    return DATA_SOURCES;
  });

  // 股票搜索（代码或名称）
  let stocksList = null;
  ipcMain.handle("search-stocks", async (_e, needle) => {
    const q = String(needle || "").trim().toLowerCase();
    if (!q) return { rows: [] };
    if (!stocksList) {
      try {
        const text = readFileSync(join(ENGINE, "data", "a_stocks.json"), "utf8");
        const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        stocksList = JSON.parse(clean);
      } catch { stocksList = []; }
    }
    const rows = [];
    const seen = new Set();
    const push = (row) => {
      const code = normalizeApiCode(row?.code || row?.symbol);
      if (!code || seen.has(code)) return;
      seen.add(code);
      rows.push({ code, name: String(row?.name || code), source: row?.source || "local" });
    };
    for (const s of stocksList) {
      if (s.code.includes(q) || (s.name && s.name.toLowerCase().includes(q))) {
        push({ code: s.code, name: s.name });
        if (rows.length >= 50) break;
      }
    }
    const exactCode = dataHub.normalizeStockCode(q);
    const remoteEligible = rows.length < 10 && (!!exactCode || /[\u3400-\u9fff]{2,}/.test(q));
    const bseDirectoryEligible = exactCode?.market === "bj"
      || /^(?:bj)?(?:4|8|9)\d{0,5}$/i.test(q)
      || (rows.length === 0 && /[\u3400-\u9fff]{2,}/.test(q));
    let remoteError = null;
    const [remoteResult, bseResult] = await Promise.allSettled([
      remoteEligible ? dataHub.searchMarketSymbols(exactCode?.code || q, 30) : Promise.resolve([]),
      bseDirectoryEligible ? dataHub.getMarketStockDirectory("bj") : Promise.resolve([]),
    ]);
    if (remoteResult.status === "fulfilled") for (const row of remoteResult.value) push(row);
    else remoteError = remoteResult.reason?.message || String(remoteResult.reason);
    if (bseResult.status === "fulfilled") {
      const directoryNeedle = q.replace(/^bj/i, "");
      for (const row of bseResult.value) {
        if (row.code.includes(directoryNeedle) || String(row.name || "").toLowerCase().includes(q)) push(row);
      }
    } else remoteError ||= bseResult.reason?.message || String(bseResult.reason);
    // 动态联想不可用时，六位代码仍可通过已启用行情源直接验证。
    if (exactCode && !rows.some((x) => x.code === exactCode.symbol)) {
      try {
        const result = await dataHub.getQuote(exactCode.symbol);
        if (result.quote) push({ ...result.quote, source: result.provider || "quote" });
      } catch (e) { remoteError ||= e?.message || String(e); }
    }
    return { rows: rows.slice(0, 50), total: rows.length, remoteError };
  });


  // v1.9 · 策略实验室可选本地AI增强
  ipcMain.handle("get-local-ai-state", async (_e, detect = false) => {
    const mod = await localAiMod(); const st = await ensureLocalAiState(!!detect); return mod.publicAiState(DATA_DIR, st);
  });
  ipcMain.handle("set-local-ai-settings", async (_e, patch = {}) => {
    const mod = await localAiMod(); const allowed = {};
    if ("enabled" in patch) allowed.enabled = !!patch.enabled;
    if ("autoShadow" in patch) allowed.autoShadow = !!patch.autoShadow;
    if ("autoIntervalMin" in patch) allowed.autoIntervalMin = Math.max(5, Math.min(120, Number(patch.autoIntervalMin) || 15));
    if ("decisionAlerts" in patch) allowed.decisionAlerts = !!patch.decisionAlerts;
    if ("adaptiveStrategy" in patch) allowed.adaptiveStrategy = !!patch.adaptiveStrategy;
    if ("minDecisionConfidence" in patch) allowed.minDecisionConfidence = Math.max(40, Math.min(95, Number(patch.minDecisionConfidence) || 55));
    if ("maxPredictionAgeMin" in patch) allowed.maxPredictionAgeMin = Math.max(15, Math.min(1440, Number(patch.maxPredictionAgeMin) || 120));
    if ("profile" in patch && ["lite","standard","advanced"].includes(patch.profile)) { allowed.profile = patch.profile; allowed.userSelectedProfile = true; }
    if ("modelId" in patch) { const ms = mod.modelById(patch.modelId); if (ms?.installable && ms?.family === "Kronos") { allowed.modelId = patch.modelId; allowed.userSelectedProfile = true; } }
    if (patch.resources) allowed.resources = { maxCpuPct: Math.max(10,Math.min(90,Number(patch.resources.maxCpuPct)||35)), maxRamGB: Math.max(1,Math.min(64,Number(patch.resources.maxRamGB)||6)), maxVramGB: Math.max(0,Math.min(48,Number(patch.resources.maxVramGB)||4)) };
    allowed.mode = "shadow"; // 仅决策支持：不下单；动态参数只形成有有效期的监控快照。
    const st = await saveLocalAiState(allowed); startLocalAiLoop().catch(() => {}); return mod.publicAiState(DATA_DIR, st);
  });
  ipcMain.handle("install-local-ai", async (_e, modelId) => startLocalAiInstall(String(modelId || "")));
  ipcMain.handle("start-local-ai", async () => {
    const result = await startLocalAiService();
    await startLocalAiLoop();
    return result;
  });
  ipcMain.handle("stop-local-ai", async () => stopLocalAiService());
  ipcMain.handle("run-local-ai-shadow", async (_e, code, strategyConfig = null) => runLocalAiShadow(code, strategyConfig, { manual: true }));
  ipcMain.handle("get-local-ai-history", async (_e, limit = 100) => (await localAiMod()).loadShadowHistory(DATA_DIR, limit));
  ipcMain.handle("uninstall-local-ai", async () => {
    await stopLocalAiService();
    try { rmSync(LOCAL_AI_HOME, { recursive: true, force: true }); } catch {}
    localAiState = (await localAiMod()).defaultAiState(); await saveLocalAiState(localAiState); pushLocalAiEvent({ type:"status", status:"not_installed" });
    return { ok: true, state: (await localAiMod()).publicAiState(DATA_DIR, localAiState) };
  });

  ipcMain.handle("open-external", (_e, url) => {
    try { const u = new URL(String(url)); if (["http:", "https:"].includes(u.protocol)) shell.openExternal(u.href); } catch {}
  });

  ipcMain.handle("window-control", (_e, action) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (action === "min") win.minimize();
    else if (action === "max") { win.isMaximized() ? win.unmaximize() : win.maximize(); }
    else if (action === "close") { win.close(); } // 统一交给 close handler：根据“关闭到托盘”设置决定隐藏或退出
  });
}

// ---- 生命周期 ----
app.whenReady().then(() => {
  configureDataHub();
  registerIpc();
  createWindow();
  createTray();
  startPolling();
  startMonitoring();
  startLocalAiLoop().catch(() => {});
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on("before-quit", () => { quitting = true; stopPolling(); stopMonitoring(); stopLocalAiLoop(); try { localAiProc?.kill(); } catch {} try { localAiInstallProc?.kill(); } catch {} saveWatchlist(); saveSettings(); saveMonitorStore(); saveAlertStore(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
