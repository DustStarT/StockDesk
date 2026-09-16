/**
 * StockDesk v1.9 · 可选本地 AI 引擎基础设施。
 * 这里只负责：模型注册、硬件检测/推荐、安装状态、影子预测历史与延迟标签队列。
 * 真正模型运行在独立 Python 进程中，Electron 主程序不依赖 PyTorch。
 */
import os from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const LOCAL_AI_SCHEMA = 2;

export const MODEL_REGISTRY = [
  {
    id: "kronos-mini", family: "Kronos", name: "Kronos-mini", role: "financial_kline_forecaster",
    params: "4.1M", openWeights: true, license: "MIT", authority: "AAAI 2026 / 金融K线基础模型",
    source: "shiyu-coder/Kronos", sourceUrl: "https://github.com/shiyu-coder/Kronos", modelId: "NeoQuasar/Kronos-mini", tokenizerId: "NeoQuasar/Kronos-Tokenizer-2k",
    contextLength: 2048, minRamGB: 8, minVramGB: 0, profile: "lite", installable: true,
    note: "低资源金融K线预测基座；适合CPU影子运行。"
  },
  {
    id: "kronos-small", family: "Kronos", name: "Kronos-small", role: "financial_kline_forecaster",
    params: "24.7M", openWeights: true, license: "MIT", authority: "AAAI 2026 / 金融K线基础模型",
    source: "shiyu-coder/Kronos", sourceUrl: "https://github.com/shiyu-coder/Kronos", modelId: "NeoQuasar/Kronos-small", tokenizerId: "NeoQuasar/Kronos-Tokenizer-base",
    contextLength: 512, minRamGB: 16, minVramGB: 0, profile: "standard", installable: true,
    note: "标准推荐；性能与资源开销平衡。"
  },
  {
    id: "kronos-base", family: "Kronos", name: "Kronos-base", role: "financial_kline_forecaster",
    params: "102.3M", openWeights: true, license: "MIT", authority: "AAAI 2026 / 金融K线基础模型",
    source: "shiyu-coder/Kronos", sourceUrl: "https://github.com/shiyu-coder/Kronos", modelId: "NeoQuasar/Kronos-base", tokenizerId: "NeoQuasar/Kronos-Tokenizer-base",
    contextLength: 512, minRamGB: 24, minVramGB: 6, profile: "advanced", installable: true,
    note: "高性能档；建议NVIDIA GPU或较强CPU。"
  },
  {
    id: "master-csi300", family: "MASTER", name: "MASTER CSI300", role: "cross_section_ranker",
    params: "paper checkpoint", openWeights: true, license: "MIT", authority: "AAAI 2024 / A股横截面股票预测",
    source: "SJTU-DMTai/MASTER", sourceUrl: "https://github.com/SJTU-DMTai/MASTER", checkpoint: "model/csi300_opensource_0.pkl",
    minRamGB: 16, minVramGB: 0, profile: "standard", installable: true, experimental: true,
    note: "公开沪深300权重。需要完整横截面222维特征，不直接用于单只股票盘中预测；v1.9仅安装/校验与后续Feature Store接口。"
  },
  {
    id: "master-csi800", family: "MASTER", name: "MASTER CSI800", role: "cross_section_ranker",
    params: "paper checkpoint", openWeights: true, license: "MIT", authority: "AAAI 2024 / A股横截面股票预测",
    source: "SJTU-DMTai/MASTER", sourceUrl: "https://github.com/SJTU-DMTai/MASTER", checkpoint: "model/csi800_opensource_0.pkl",
    minRamGB: 24, minVramGB: 4, profile: "advanced", installable: true, experimental: true,
    note: "公开中证800权重。需完整横截面特征；v1.9先纳入模型注册与安装。"
  },
  {
    id: "qlib-tra", family: "Qlib TRA", name: "Qlib TRA", role: "market_pattern_router",
    params: "training required", openWeights: false, license: "MIT", authority: "Microsoft Qlib / KDD 2021",
    source: "microsoft/qlib", sourceUrl: "https://github.com/microsoft/qlib", minRamGB: 16, minVramGB: 0, profile: "advanced", installable: false, experimental: true,
    note: "市场模式路由器；没有可直接迁移的通用A股预训练权重，需要在StockDesk Feature Store上训练后才启用。"
  }
];

export function modelById(id) { return MODEL_REGISTRY.find((x) => x.id === id) || MODEL_REGISTRY[0]; }

export function aiPaths(dataDir) {
  const home = join(dataDir, "ai-engine");
  return {
    home,
    state: join(home, "state.json"),
    models: join(home, "models"),
    vendor: join(home, "vendor"),
    venv: join(home, "venv"),
    checkpoints: join(home, "checkpoints"),
    featureStore: join(home, "feature_store"),
    shadowHistory: join(home, "shadow-history.json"),
    pending: join(home, "pending-labels.json"),
    online: join(home, "online"),
  };
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8"); renameSync(tmp, path); }
  catch { try { writeFileSync(path, JSON.stringify(value, null, 2), "utf8"); } catch {} try { unlinkSync(tmp); } catch {} }
}
function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }

export function defaultAiState() {
  return {
    schemaVersion: LOCAL_AI_SCHEMA,
    enabled: false,
    mode: "shadow", // v1.9只允许 shadow 真正运行；filter/adaptive 预留。
    profile: "standard",
    modelId: "kronos-small",
    autoShadow: false,
    autoIntervalMin: 5,
    decisionAlerts: true,
    adaptiveStrategy: true,
    minDecisionConfidence: 55,
    maxPredictionAgeMin: 120,
    resources: { maxCpuPct: 35, maxRamGB: 6, maxVramGB: 4 },
    installed: false,
    installedModels: [],
    engineStatus: "not_installed",
    lastError: null,
    lastPrediction: null,
    health: null,
    hardware: null,
    recommendation: null,
    updatedAt: Date.now(),
  };
}

export function loadAiState(dataDir) {
  const p = aiPaths(dataDir); mkdirSync(p.home, { recursive: true });
  const x = readJson(p.state, defaultAiState());
  return { ...defaultAiState(), ...(x || {}), resources: { ...defaultAiState().resources, ...(x?.resources || {}) } };
}
export function saveAiState(dataDir, state) {
  const p = aiPaths(dataDir); mkdirSync(p.home, { recursive: true });
  const clean = { ...defaultAiState(), ...(state || {}), updatedAt: Date.now() };
  atomicJson(p.state, clean); return clean;
}

function run(cmd, args = [], timeout = 2500) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
    if (r.status === 0) return String(r.stdout || r.stderr || "").trim();
  } catch {}
  return "";
}

function detectPython() {
  const candidates = process.platform === "win32"
    ? [["py", ["-3", "--version"]], ["python", ["--version"]]]
    : [["python3", ["--version"]], ["python", ["--version"]]];
  for (const [cmd, args] of candidates) {
    const out = run(cmd, args);
    const m = out.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
    if (m) return { found: true, command: cmd, argsPrefix: cmd === "py" ? ["-3"] : [], version: `${m[1]}.${m[2]}.${m[3]}`, supported: Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10) };
  }
  return { found: false, command: null, argsPrefix: [], version: null, supported: false };
}

function detectGpu() {
  const smi = run("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], 3500);
  if (smi) {
    const first = smi.split(/\r?\n/)[0].split(",").map((s) => s.trim());
    return { vendor: "NVIDIA", name: first[0] || "NVIDIA GPU", vramMB: Number(first[1]) || null, driver: first[2] || null, cudaCapable: true };
  }
  if (process.platform === "win32") {
    const ps = run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM | ConvertTo-Json -Compress"], 3500);
    try { const x = JSON.parse(ps); return { vendor: /nvidia/i.test(x?.Name || "") ? "NVIDIA" : /amd|radeon/i.test(x?.Name || "") ? "AMD" : /intel/i.test(x?.Name || "") ? "Intel" : "Other", name: x?.Name || "未知GPU", vramMB: Number(x?.AdapterRAM) ? Math.round(Number(x.AdapterRAM) / 1024 / 1024) : null, driver: null, cudaCapable: /nvidia/i.test(x?.Name || "") }; } catch {}
  }
  return { vendor: "None", name: "未检测到独立GPU", vramMB: null, driver: null, cudaCapable: false };
}

export function recommendAiProfile(hw) {
  const ram = Number(hw?.ramGB) || 0, vram = (Number(hw?.gpu?.vramMB) || 0) / 1024, cores = Number(hw?.cpu?.logicalCores) || 1;
  let profile = "lite", modelId = "kronos-mini", reason = "优先保证低资源稳定运行";
  if (ram >= 32 && hw?.gpu?.cudaCapable && vram >= 6) { profile = "advanced"; modelId = "kronos-base"; reason = "内存与NVIDIA显存足够，可运行Kronos-base；MASTER/TRA仍作为慢速实验层"; }
  else if (ram >= 16 && cores >= 4) { profile = "standard"; modelId = "kronos-small"; reason = "内存与CPU足够，Kronos-small适合作为默认影子模型"; }
  return {
    profile, modelId, reason,
    optional: profile === "advanced" ? ["master-csi800", "qlib-tra"] : profile === "standard" ? ["master-csi300"] : [],
    warning: !hw?.python?.supported ? "未检测到 Python 3.10+；安装AI引擎前需要先安装Python。" : null,
  };
}

export function detectHardware(dataDir) {
  const p = aiPaths(dataDir); mkdirSync(p.home, { recursive: true });
  const cpus = os.cpus() || [];
  let diskFreeGB = null;
  try { const fs = statfsSync(p.home); diskFreeGB = Number((Number(fs.bavail) * Number(fs.bsize) / 1024 ** 3).toFixed(1)); } catch {}
  const hw = {
    platform: process.platform, arch: process.arch,
    cpu: { model: cpus[0]?.model || "未知CPU", logicalCores: cpus.length || 1 },
    ramGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    freeRamGB: Number((os.freemem() / 1024 ** 3).toFixed(1)),
    gpu: detectGpu(), python: detectPython(), diskFreeGB,
    detectedAt: Date.now(),
  };
  hw.recommendation = recommendAiProfile(hw);
  return hw;
}

export function enginePython(dataDir) {
  const p = aiPaths(dataDir);
  const exe = process.platform === "win32" ? join(p.venv, "Scripts", "python.exe") : join(p.venv, "bin", "python");
  return existsSync(exe) ? exe : null;
}


export function readInstallManifest(dataDir) {
  const p = aiPaths(dataDir);
  return readJson(join(p.home, "install-manifest.json"), { schemaVersion: 1, models: [] });
}

export function reconcileAiState(dataDir, state) {
  const manifest = readInstallManifest(dataDir);
  const models = Array.isArray(manifest?.models) ? manifest.models.filter((id) => MODEL_REGISTRY.some((m) => m.id === id)) : [];
  const pythonReady = !!enginePython(dataDir);
  const installed = pythonReady && models.length > 0;
  const priorStatus = state?.engineStatus || (installed ? "stopped" : "not_installed");
  const legacyExpectedStop = installed && priorStatus === "error" && /AI进程退出\(null\)/.test(String(state?.lastError || ""));
  const engineStatus = legacyExpectedStop ? "stopped" : (!installed && !["installing","error"].includes(priorStatus) ? "not_installed" : priorStatus);
  return { ...defaultAiState(), ...(state || {}), installedModels: models, installed, engineStatus, ...(legacyExpectedStop ? { lastError: null } : {}) };
}

export function publicAiState(dataDir, state) {
  const p = aiPaths(dataDir);
  const safeState = reconcileAiState(dataDir, state);
  const installedModels = MODEL_REGISTRY.map((m) => ({ ...m, installed: (safeState?.installedModels || []).includes(m.id) }));
  return {
    ...safeState,
    paths: { home: p.home, featureStore: p.featureStore, checkpoints: p.checkpoints },
    pythonReady: !!enginePython(dataDir),
    models: installedModels,
  };
}

export function loadShadowHistory(dataDir, limit = 100) {
  const p = aiPaths(dataDir); const raw = readJson(p.shadowHistory, { version: 1, items: [] });
  return { version: 1, items: Array.isArray(raw?.items) ? raw.items.slice(0, Math.max(1, Math.min(1000, Number(limit) || 100))) : [] };
}
export function latestShadowPrediction(dataDir, code, maxAgeMs = Infinity) {
  const key = String(code || "");
  const row = loadShadowHistory(dataDir, 1000).items.find((x) => String(x?.code || "") === key) || null;
  if (!row) return null;
  const ageMs = Math.max(0, Date.now() - Number(row.generatedAt || 0));
  return { row, ageMs, fresh: ageMs <= Math.max(0, Number(maxAgeMs) || 0) };
}
export function appendShadowHistory(dataDir, row) {
  const p = aiPaths(dataDir); const raw = loadShadowHistory(dataDir, 1000);
  raw.items = [{ id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`, ...row }, ...raw.items].slice(0, 1000);
  atomicJson(p.shadowHistory, raw); return raw.items[0];
}

export function loadPendingLabels(dataDir) { const p = aiPaths(dataDir); return readJson(p.pending, { version: 1, items: [] }); }
export function savePendingLabels(dataDir, value) { const p = aiPaths(dataDir); atomicJson(p.pending, value); return value; }

export function decisionFromPrediction(prediction, strategy = null) {
  const coldStart = prediction?.sourceMode === "cold_start" || prediction?.base === "ColdStart";
  const p = Number(prediction?.positiveProbability);
  const med = Number(prediction?.medianReturnPct);
  const online = Number(prediction?.calibratedProbability);
  const prob = Number.isFinite(online) ? online : p;
  const rawSpread = Number(prediction?.q90ReturnPct) - Number(prediction?.q10ReturnPct);
  const uncertainty = Number.isFinite(rawSpread) ? Math.max(0, rawSpread) : 0;
  const strategyMatched = strategy?.current?.matched === true;
  const risk = Number(strategy?.current?.values?.risk ?? strategy?.recommendation?.profiles?.balanced?.diagnostics?.risk);
  let action = "WATCH";
  if (Number.isFinite(prob) && prob >= 0.68 && med > 0 && strategyMatched) action = "BUY";
  else if (Number.isFinite(prob) && prob >= 0.58 && med > 0) action = "WATCH";
  else if (Number.isFinite(prob) && prob <= 0.22 && med < -2) action = "EXIT";
  else if (Number.isFinite(prob) && prob <= 0.34 && med < 0) action = "REDUCE";
  else if (strategyMatched) action = "HOLD";
  if (coldStart) action = "WATCH";
  if (Number.isFinite(risk) && risk >= 80 && action === "BUY") action = "WATCH";
  const center = Number.isFinite(prob) ? prob : .5;
  let confidence = Math.round(Math.max(0, Math.min(100, (Math.abs(center - .5) * 150 + Math.max(0, 35 - uncertainty * 2)))));
  const sampleRuns = Number(prediction?.sampleRuns);
  if (Number.isFinite(sampleRuns) && sampleRuns > 0) {
    const sampleCap = sampleRuns < 3 ? 52 : sampleRuns === 3 ? 72 : sampleRuns <= 5 ? 86 : 94;
    confidence = Math.min(confidence, sampleCap);
  }
  if (coldStart) confidence = Math.min(confidence, 35);
  return { action, confidence, probability: Number.isFinite(prob) ? prob : null, uncertaintyPct: Number.isFinite(uncertainty) ? uncertainty : null, coldStart, shadowOnly: true };
}

const aiClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
const aiRound = (v, d = 2) => Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : null;

/**
 * 新股不足 40 根日 K 时的安全降级。这里只描述已经发生的短样本统计，
 * 不补齐、不合成历史，也不伪装成 Kronos 的未来预测。
 */
export function buildColdStartPrediction(candles = [], context = {}) {
  const rows = (Array.isArray(candles) ? candles : []).filter((x) => Number.isFinite(Number(x?.close)) && Number(x.close) > 0);
  const closes = rows.map((x) => Number(x.close));
  const returns = closes.slice(1).map((close, i) => (close / closes[i] - 1) * 100).filter(Number.isFinite);
  const change = (days) => closes.length > 1
    ? aiRound((closes.at(-1) / closes[Math.max(0, closes.length - 1 - days)] - 1) * 100, 2)
    : null;
  let peak = closes[0] || null;
  let maxDrawdownPct = 0;
  for (const close of closes) {
    peak = peak == null ? close : Math.max(peak, close);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - close) / peak * 100);
  }
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const dailyVolatilityPct = returns.length && mean != null
    ? Math.sqrt(returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / returns.length)
    : null;
  const volumes = rows.map((x) => Number(x.volume)).filter((x) => Number.isFinite(x) && x >= 0);
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const recentAvg = avg(volumes.slice(-5));
  const priorAvg = avg(volumes.slice(Math.max(0, volumes.length - 25), Math.max(0, volumes.length - 5)));
  const return5Pct = change(5);
  const return10Pct = change(10);
  const directionScore = aiClamp(50 + (return5Pct || 0) * 1.4 + (return10Pct || 0) * .6 - (dailyVolatilityPct || 0) * 1.2 - maxDrawdownPct * .25, 30, 70);
  return {
    modelId: "cold-start-statistics",
    base: "ColdStart",
    sourceMode: "cold_start",
    generatedAt: Number(context.generatedAt) || Date.now(),
    lastClose: closes.at(-1) || null,
    predLen: 0,
    sampleRuns: 0,
    positiveProbability: aiRound(directionScore / 100, 4),
    calibratedProbability: null,
    medianReturnPct: null,
    q10ReturnPct: null,
    q90ReturnPct: null,
    trajectory: [],
    features: null,
    monitorEligible: false,
    observed: {
      bars: rows.length,
      listingReturnPct: closes.length > 1 ? aiRound((closes.at(-1) / closes[0] - 1) * 100, 2) : null,
      return5Pct,
      return10Pct,
      maxDrawdownPct: aiRound(maxDrawdownPct, 2),
      dailyVolatilityPct: aiRound(dailyVolatilityPct, 2),
      volumeRatio: recentAvg != null && priorAvg > 0 ? aiRound(recentAvg / priorAvg, 2) : null,
    },
    online: { updates: 0, coldStart: true },
  };
}

/**
 * 把 Kronos 路径预测、规则策略与盘中状态组合成有有效期的决策支持快照。
 * suggestedConfig 只用于本次 AI 监控计算，不会覆盖用户保存的基准参数。
 */
export function buildAdaptiveAiPlan(prediction, strategy = null, context = {}) {
  const coldStart = prediction?.sourceMode === "cold_start" || prediction?.base === "ColdStart";
  const decision = decisionFromPrediction(prediction, strategy);
  const cfg = { ...(strategy?.config || context.baseConfig || {}) };
  const values = strategy?.current?.values || {};
  const prob = Number(decision.probability);
  const med = Number(prediction?.medianReturnPct);
  const q10 = Number(prediction?.q10ReturnPct);
  const q90 = Number(prediction?.q90ReturnPct);
  const spread = Number(decision.uncertaintyPct);
  const matched = strategy?.current?.matched === true;
  const completion = Number(context.completion);
  const risk = Number(values.risk);
  const generatedAt = Number(prediction?.generatedAt || context.generatedAt || Date.now());
  const lastClose = Number(prediction?.lastClose);
  const path = (Array.isArray(prediction?.trajectory) ? prediction.trajectory : []).map((close, i) => ({
    day: i + 1,
    close: aiRound(close, 3),
    returnPct: lastClose > 0 ? aiRound((Number(close) / lastClose - 1) * 100, 2) : null,
  })).filter((x) => Number.isFinite(x.close));
  const peak = path.reduce((best, x) => best == null || Number(x.returnPct) > Number(best.returnPct) ? x : best, null);
  const trough = path.reduce((best, x) => best == null || Number(x.returnPct) < Number(best.returnPct) ? x : best, null);

  let phase = "observe", label = "等待方向确认", urgency = "low", window = "未来1—3个交易日继续观察";
  const reasons = [];
  if (coldStart) {
    label = "新股冷启动，仅做短样本观察";
    window = `再积累 ${Math.max(0, 40 - Number(prediction?.observed?.bars || 0))} 根日 K 后解锁 Kronos 预测`;
    reasons.push("当前历史不足40根，未运行Kronos，也未生成未来收益路径");
  } else if (decision.action === "BUY") {
    phase = context.intradayConfirmed === false ? "confirm" : "entry";
    label = context.intradayConfirmed === false ? "模型偏多，等待分时确认" : "模型与规则共振";
    urgency = "high"; window = context.intradayConfirmed === false ? "等待价格重新站上分时均价或放量转强" : "当前至下一交易日开盘前复核";
    reasons.push("上涨概率、预测收益与规则入场条件形成共振");
  } else if (decision.action === "EXIT") {
    phase = "exit"; label = "高优先级退出核查"; urgency = "critical"; window = "当前交易时段优先检查减仓或退出条件";
    reasons.push("下行概率与预测中位收益同时达到退出阈值");
  } else if (decision.action === "REDUCE") {
    phase = "defend"; label = "转入防守，核查减仓"; urgency = "high"; window = "当前至下一交易日内复核风险与止损";
    reasons.push("模型下行概率占优，暂不适合放宽入场条件");
  } else if (decision.action === "HOLD") {
    phase = "hold"; label = "规则已触发，模型建议持有观察"; urgency = "medium"; window = "按动态止损跟踪，下一次预测重新评估";
    reasons.push("规则条件满足，但模型优势不足以升级为买入确认");
  } else if (matched) {
    phase = "confirm"; label = "规则偏多，AI尚未确认"; urgency = "medium"; window = "暂缓追价，等待下一次模型或分时确认";
    reasons.push("规则与模型方向不完全一致");
  }
  if (Number.isFinite(prob)) reasons.push(`${coldStart ? "短样本方向分" : "校准上涨概率"} ${(prob * 100).toFixed(1)}%`);
  if (prediction?.medianReturnPct != null && Number.isFinite(med)) reasons.push(`${prediction?.predLen || 5}日中位收益 ${med >= 0 ? "+" : ""}${med.toFixed(2)}%`);

  const suggestedConfig = { ...cfg };
  const changes = [];
  const change = (key, value, labelText) => {
    if (coldStart) return;
    if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(cfg[key]))) return;
    const next = aiRound(value, 1);
    if (next === aiRound(cfg[key], 1)) return;
    suggestedConfig[key] = next;
    changes.push({ key, label: labelText, from: aiRound(cfg[key], 1), to: next });
  };
  if (decision.action === "BUY" && decision.confidence >= 60 && Number.isFinite(q10) && q10 > -4) {
    change("entryScore", aiClamp(Number(cfg.entryScore) - 3, -20, 90), "入场分");
    if (Number.isFinite(q90) && q90 > 0) change("takeProfitPct", aiClamp(Math.max(Number(cfg.takeProfitPct), q90 * .8), 2, 80), "止盈");
  }
  if (["REDUCE","EXIT"].includes(decision.action)) {
    change("entryScore", aiClamp(Number(cfg.entryScore) + (decision.action === "EXIT" ? 8 : 5), -20, 90), "入场分");
    change("maxRisk", aiClamp(Number(cfg.maxRisk) - 8, 10, 100), "最大风险");
    if (Number.isFinite(q10) && q10 < 0) change("stopLossPct", aiClamp(Math.min(Number(cfg.stopLossPct), Math.max(2.5, Math.abs(q10) * .8)), 1, 30), "止损");
  }
  if (Number.isFinite(spread) && spread >= 8) {
    change("entryScore", aiClamp(Number(suggestedConfig.entryScore) + 4, -20, 90), "入场分");
    change("maxRisk", aiClamp(Number(suggestedConfig.maxRisk) - 5, 10, 100), "最大风险");
    reasons.push("预测区间较宽，临时收紧风险阈值");
  }
  if (Number.isFinite(prediction?.predLen)) change("maxHoldDays", aiClamp(Math.min(Number(cfg.maxHoldDays), Number(prediction.predLen) * 2), 1, 120), "最长持有");

  const riskFlags = [];
  if (coldStart) riskFlags.push("历史不足40根：AI提醒和动态参数均已锁定");
  if (Number(prediction?.sampleRuns) < 3) riskFlags.push("采样次数较少");
  if (Number(prediction?.online?.updates) < 8) riskFlags.push("在线校准样本不足");
  if (Number.isFinite(spread) && spread >= 8) riskFlags.push("预测分歧较大");
  if (Number.isFinite(q10) && q10 <= -5) riskFlags.push("悲观情景跌幅较大");
  if (prediction?.online?.lastDriftAt && generatedAt - Number(prediction.online.lastDriftAt) < 24 * 3600000) riskFlags.push("在线层检测到近期漂移");

  return {
    version: 1, generatedAt, decision, phase, label, urgency, window,
    horizonDays: coldStart ? 0 : Number(prediction?.predLen) || 5,
    reasons, riskFlags, path, peak, trough,
    baselineConfig: cfg, suggestedConfig, changes,
    effectiveUntil: generatedAt + Math.max(30, Number(context.maxAgeMin) || 120) * 60000,
    fingerprint: [decision.action, phase, decision.confidence, ...changes.map((x) => `${x.key}:${x.to}`)].join("|"),
    monitorEligible: !coldStart,
    advisoryOnly: true,
  };
}
