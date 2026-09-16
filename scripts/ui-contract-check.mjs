/** StockDesk v1.9.2 UI/IPC 合约检查：防止 renderer/preload/main 三层接口漂移与重复静态 DOM id。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const root=new URL("..",import.meta.url);
const preload=readFileSync(new URL("preload.js",root),"utf8");
const main=readFileSync(new URL("main.js",root),"utf8");
const renderer=readFileSync(new URL("renderer/app.js",root),"utf8");
const html=readFileSync(new URL("renderer/index.html",root),"utf8");
assert.deepEqual([...html.matchAll(/data-panel="([^"]+)"/g)].map(x=>x[1]),['signal','screen','strategy','report']);
assert.ok(!preload.includes('get-deep') && !preload.includes('get-versus'));
assert.ok(!main.includes('getDeepAnalysis') && !main.includes('deepAnalyze'));

// 性能契约：切股时只等待一个信号 IPC，后台不得再串行抓取大盘；过期结果与异常都要被处理。
const signalLoader=renderer.slice(renderer.indexOf("async function loadSignal"),renderer.indexOf("function renderSignalStrip"));
assert.ok(signalLoader.includes("await api.getSignal(code, force)"));
assert.ok(renderer.includes('loadSignal(true)') && renderer.includes('loadSignal(false, true)'));
assert.ok(renderer.includes('horizonHtml') && renderer.includes('sig.asOf'));
assert.ok(!signalLoader.includes("Promise.all(") && !signalLoader.includes("getMarketRegime"));
assert.ok(signalLoader.includes("signalLoadToken") && signalLoader.includes("catch (e)"));
const signalHandler=main.slice(main.indexOf('ipcMain.handle("get-signal"'),main.indexOf("// v1.5",main.indexOf('ipcMain.handle("get-signal"')));
assert.ok(signalHandler.includes("signalService.get(code, !!force)"));
const service=readFileSync(new URL("engine/signal-service.js",root),"utf8");
assert.ok(service.includes("Promise.all([") && service.includes('getMinute(key, { force: true })'));

// 日 K 只抓一份长历史并供图表切片、信号、策略与研报复用。
assert.ok(main.includes('period === "day" ? 750 : 120'));
assert.ok(main.includes('const candles = safePeriod === "day" ? history.slice(-180) : history'));
assert.ok(main.includes('const data = await cachedKline(code, "day")'));
assert.ok(main.includes("coalesce(klineInflight"));
assert.ok(main.includes("Promise.resolve(cachedMarketRegime())"));

// 结构化研报应先显示；AI 额度估算和历史恢复在后台并发补齐。
const reportLoader=renderer.slice(renderer.indexOf("async function renderReport"),renderer.indexOf("async function hydrateReportExtras"));
assert.ok(reportLoader.indexOf("renderReportResult()")>=0);
assert.ok(reportLoader.indexOf("renderReportResult()")<reportLoader.indexOf("hydrateReportExtras"));
assert.ok(renderer.includes("await Promise.allSettled(["));
const invokes=[...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(m=>m[1]);
const handlers=new Set([...main.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map(m=>m[1]));
for(const ch of invokes) assert.ok(handlers.has(ch),`preload invokes missing main handler: ${ch}`);
const preloadMethods=new Set([...preload.matchAll(/^\s*([A-Za-z_$][\w$]*):\s*\(/gm)].map(m=>m[1]));
const rendererMethods=new Set([...renderer.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)].map(m=>m[1]));
for(const name of rendererMethods) assert.ok(preloadMethods.has(name),`renderer uses missing preload API: ${name}`);
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
const dup=ids.filter((x,i)=>ids.indexOf(x)!==i); assert.deepEqual([...new Set(dup)],[],`duplicate static ids: ${dup}`);
for(const id of ["llm-web-research","llm-research-mode","llm-web-pages","set-close-tray","indicator-param-modal","btn-monitor","monitor-modal","position-modal","set-monitor-enabled","set-strategy-alerts","set-monitor-poll","set-monitor-cooldown","set-market-hours","data-source-open","data-source-modal","data-source-routing","data-source-builtins","data-source-save","data-source-test"]){assert.ok(ids.includes(id),`missing UX control ${id}`);}

const css=readFileSync(new URL("renderer/styles.css",root),"utf8");
assert.ok(renderer.includes('<details class="ai-evidence-readable"><summary>'),"AI依据必须使用默认折叠 details");
assert.ok(!renderer.includes('<details class="ai-evidence-readable" open'),"AI依据不能默认展开");
assert.ok(renderer.includes('maximumFractionDigits:2'),"AI证据数值应限制到最多两位小数");
assert.ok(css.includes('.ai-evidence-readable > summary'),"缺少折叠依据样式");
assert.ok(renderer.includes('data-strategy-mode="smart"'),"策略页缺少智能推荐模式入口");
assert.ok(renderer.includes('data-strategy-profile="${id}"'),"策略页缺少三档推荐配置渲染");
assert.ok(css.includes('.strategy-profile-grid'),"缺少智能策略推荐样式");
assert.ok(renderer.includes("strategy-monitor-enable"),"策略页缺少启用实时监控入口");
assert.ok(renderer.includes("openMonitorModal"),"缺少提醒中心交互");
assert.ok(css.includes(".monitor-alert-item"),"缺少提醒历史样式");
assert.ok(main.includes("startMonitoring()"),"主进程缺少独立策略监控定时器");
assert.ok(main.includes("windowHidden = true") && !main.includes("mainWindow.on(\"hide\", () => { if (settings.pauseWhenHidden !== false) stopPolling()"),"隐藏窗口不应停止后台提醒链路");
assert.ok(preload.includes("get-data-source-state") && preload.includes("set-data-source-config") && preload.includes("test-data-sources"),"preload缺少多数据源 IPC");
assert.ok(main.includes("dataHub.getQuotes") && main.includes("get-data-source-state"),"主进程未接入 Provider Hub");
assert.ok(renderer.includes("openDataSourceModal"),"缺少数据源管理交互");
assert.ok(renderer.includes("researchAgentHtml"),"外部研究页缺少 Research Agent 审计视图");
assert.ok(html.includes("LLM 自主外部研究 Agent"),"模型设置缺少自主研究开关文案");
assert.ok(renderer.includes("localAiCardHtml"),"策略实验室缺少本地AI增强卡片");
assert.ok(renderer.includes("local-ai-run"),"策略实验室缺少影子预测入口");
assert.ok(preload.includes('invoke("get-local-ai-state"'),"preload缺少本地AI状态接口");
assert.ok(main.includes('ipcMain.handle("run-local-ai-shadow"'),"主进程缺少本地AI影子预测IPC");
assert.ok(main.includes('allowed.mode = "shadow"'),"v1.9本地AI必须强制影子模式");
assert.ok(renderer.includes('data-strategy-mode="ai"'),"AI策略必须与智能推荐、手动高级同级");
assert.equal((renderer.match(/\$\{localAiCardHtml\(r\)\}/g)||[]).length,1,"AI决策台只能在AI一级模式渲染，不能继续挤占智能/手动内容");
assert.ok(renderer.includes('<details class="local-ai-hardware"><summary>本机配置检查与运行建议'),"本机配置检查必须为折叠区");
assert.ok(!renderer.includes('<details class="local-ai-hardware" open'),"本机配置检查不得默认展开");
for(const id of ["local-ai-alerts","local-ai-adaptive","local-ai-confidence","local-ai-max-age","local-ai-monitor"])assert.ok(renderer.includes(`id="${id}"`),`missing AI strategy control ${id}`);
assert.ok(renderer.includes('filter(x=>String(x?.code||"")===String(state.activeCode||""))'),"AI历史必须按当前股票隔离");
assert.ok(renderer.includes("strategyLoadToken"),"策略页缺少切股竞态保护");
const selectStockBody=renderer.slice(renderer.indexOf("function selectStock"),renderer.indexOf("// ================= 详情头"));
assert.ok(selectStockBody.includes('state.panel === "strategy"') && selectStockBody.includes('state.panel === "report"'),"切换股票后策略与研报面板未同步刷新");
assert.ok(renderer.includes("chartLoadToken"),"主图缺少切股竞态保护");
assert.ok(main.includes("localAiPredictionInflight"),"同股AI预测缺少请求合并");
assert.ok(main.includes('String(aiRow.code || "") === String(code)'),"AI监控必须拒绝异股预测");
assert.ok(main.includes("aiByCode.set(key, row)"),"监控轮询必须按代码分发AI预测");
assert.ok(main.includes("effectiveConfig: aiContext.applied ? effectiveSafe.config : null"),"AI临时策略快照缺少运行态审计");
const metricClass=renderer.slice(renderer.indexOf("function strategyMetricClass"),renderer.indexOf("function strategyScoreClass"));
assert.ok(metricClass.includes('return n > 0 ? "up" : n < 0 ? "down"'),"策略收益色必须遵循A股红涨绿跌");
assert.ok(renderer.includes("红色 = 上涨 / 偏多")&&renderer.includes("绿色 = 下跌 / 偏空"),"AI决策台缺少颜色图例");
assert.ok(renderer.includes("为什么得到这个结论")&&renderer.includes("ai-decision-chain"),"AI决策台缺少可解释决策链");
assert.ok(renderer.includes("可信度不是上涨概率")&&renderer.includes("不是可信度"),"AI概率与可信度未明确区分");
assert.ok(renderer.includes("searchSeq")&&renderer.includes("seq!==searchSeq"),"股票动态搜索缺少竞态保护");
assert.ok(main.includes("dataHub.searchMarketSymbols")&&main.includes("dataHub.getQuote(exactCode.symbol)"),"股票搜索缺少最新证券库与代码验证降级");
assert.ok(main.includes('dataHub.getMarketStockDirectory("bj")'),"本地证券名单缺少完整北交所目录补全");
assert.ok(renderer.includes("function normalizeUiCode")&&renderer.includes("该股票已在当前分组中"),"添加自选缺少代码规范化与重复拦截");
assert.ok(main.includes("function normalizeSymbolList")&&main.includes("if (JSON.stringify(watchlist) !== before) saveWatchlist()"),"旧自选代码缺少迁移与去重");
assert.ok(renderer.includes("function removeGroup(index)")&&renderer.includes("group-tab-del"),"自选分组缺少删除入口");
assert.ok(css.includes("overflow-x: hidden")&&css.includes("repeat(2,minmax(0,1fr))"),"窄右栏缺少横向溢出约束");
assert.ok(css.includes("height: calc(100% - 16px)"),"带 8px 外边距的应用容器高度仍会超出窗口");
assert.ok(renderer.includes("企业公告与动态")&&renderer.includes("企业财报与业绩披露"),"资讯页未聚焦所选企业");
assert.ok(renderer.includes("officialAnnouncementCount"),"研报资讯页缺少法定披露公告统计");
console.log(`StockDesk v1.9.2 UI/IPC contract checks: PASS | IPC=${invokes.length} rendererAPI=${rendererMethods.size} staticIDs=${ids.length}`);
