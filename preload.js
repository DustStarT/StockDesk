/**
 * StockDesk preload — 安全的 IPC 桥接。
 * 渲染进程只能通过 window.stockdesk 访问白名单 API。
 */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  // 状态与配置
  getState: () => ipcRenderer.invoke("get-state"),
  setWatchlist: (groups) => ipcRenderer.invoke("set-watchlist", groups),
  setSettings: (patch) => ipcRenderer.invoke("set-settings", patch),
  pollNow: () => ipcRenderer.invoke("poll-now"),
  getDataSourceState: () => ipcRenderer.invoke("get-data-source-state"),
  setDataSourceConfig: (config) => ipcRenderer.invoke("set-data-source-config", config),
  setDataSourceSecret: (id, secret) => ipcRenderer.invoke("set-data-source-secret", id, secret),
  testDataSources: (sampleCode) => ipcRenderer.invoke("test-data-sources", sampleCode),
  resetDataSourceBreakers: (id = null) => ipcRenderer.invoke("reset-data-source-breakers", id),

  // 数据
  getQuotes: () => ipcRenderer.invoke("get-quotes"),
  getKline: (code, period) => ipcRenderer.invoke("get-kline", code, period),
  getMinute: (code) => ipcRenderer.invoke("get-minute", code),
  getMarketRegime: () => ipcRenderer.invoke("get-market-regime"),
  getSignal: (code, force = false) => ipcRenderer.invoke("get-signal", code, force),
  getStrategyLab: (code, config) => ipcRenderer.invoke("get-strategy-lab", code, config),
  getLocalAiState: (detect = false) => ipcRenderer.invoke("get-local-ai-state", detect),
  setLocalAiSettings: (patch) => ipcRenderer.invoke("set-local-ai-settings", patch),
  installLocalAi: (modelId) => ipcRenderer.invoke("install-local-ai", modelId),
  startLocalAi: () => ipcRenderer.invoke("start-local-ai"),
  stopLocalAi: () => ipcRenderer.invoke("stop-local-ai"),
  runLocalAiShadow: (code, strategyConfig = null) => ipcRenderer.invoke("run-local-ai-shadow", code, strategyConfig),
  getLocalAiHistory: (limit = 100) => ipcRenderer.invoke("get-local-ai-history", limit),
  uninstallLocalAi: () => ipcRenderer.invoke("uninstall-local-ai"),
  getMonitorState: () => ipcRenderer.invoke("get-monitor-state"),
  setStrategyMonitor: (code, patch) => ipcRenderer.invoke("set-strategy-monitor", code, patch),
  setMonitorPosition: (code, position) => ipcRenderer.invoke("set-monitor-position", code, position),
  checkMonitorsNow: () => ipcRenderer.invoke("check-monitors-now"),
  getAlertHistory: (limit = 100) => ipcRenderer.invoke("get-alert-history", limit),
  markAlertsRead: (ids = null) => ipcRenderer.invoke("mark-alerts-read", ids),
  clearAlertHistory: () => ipcRenderer.invoke("clear-alert-history"),
  getIndicatorCatalog: () => ipcRenderer.invoke("get-indicator-catalog"),
  setIndicatorParams: (id, params) => ipcRenderer.invoke("set-indicator-params", id, params),
  resetIndicatorParams: (id = null) => ipcRenderer.invoke("reset-indicator-params", id),
  getIndicators: (code, period, ids) => ipcRenderer.invoke("get-indicators", code, period, ids),
  getResearchReport: (code, force = false) => ipcRenderer.invoke("get-research-report", code, force),
  getLlmState: () => ipcRenderer.invoke("get-llm-state"),
  setLlmSettings: (patch, apiKey = null, clearKey = false) => ipcRenderer.invoke("set-llm-settings", patch, apiKey, clearKey),
  testLlm: (patch, apiKey = null) => ipcRenderer.invoke("test-llm", patch, apiKey),
  estimateAiReport: (code) => ipcRenderer.invoke("estimate-ai-report", code),
  generateAiReport: (code) => ipcRenderer.invoke("generate-ai-report", code),
  getAiReportHistory: (code = null, limit = 30) => ipcRenderer.invoke("get-ai-report-history", code, limit),
  getAiReportEntry: (id) => ipcRenderer.invoke("get-ai-report-entry", id),
  deleteAiReportEntry: (id) => ipcRenderer.invoke("delete-ai-report-entry", id),
  exportAiReport: (id, format) => ipcRenderer.invoke("export-ai-report", id, format),
  openLlmRawOutputDir: (dir = null) => ipcRenderer.invoke("open-llm-raw-output-dir", dir),
  getScreen: (board, method, maxResults = 0) => ipcRenderer.invoke("get-screen", board, method, maxResults),
  searchStocks: (needle) => ipcRenderer.invoke("search-stocks", needle),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  windowControl: (action) => ipcRenderer.invoke("window-control", action),

  // 事件订阅（主进程推送）
  onQuotes: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on("quotes", h); return () => ipcRenderer.removeListener("quotes", h); },
  onAlert: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on("alert", h); return () => ipcRenderer.removeListener("alert", h); },
  onMonitorAlert: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on("monitor-alert", h); return () => ipcRenderer.removeListener("monitor-alert", h); },
  onMonitorState: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on("monitor-state", h); return () => ipcRenderer.removeListener("monitor-state", h); },
  onNavigateStock: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on("navigate-stock", h); return () => ipcRenderer.removeListener("navigate-stock", h); },
  onLocalAiEvent: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on("local-ai-event", h); return () => ipcRenderer.removeListener("local-ai-event", h); },
};

contextBridge.exposeInMainWorld("stockdesk", api);
