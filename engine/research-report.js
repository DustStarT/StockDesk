/**
 * StockDesk v1.3 · 综合研报数据编排
 * 关联报价 / 交易查询 / 资金流 / 企业公告与新闻 / 财报披露 / 技术/回测
 */
import * as em from "./market-fetchers.js";
import { searchBlob } from "./company-search.js";

const num = (v, d = null) => Number.isFinite(Number(v)) ? Number(v) : d;
const round = (v, d = 2) => Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : null;

function cleanText(text, max = 360) {
  let s = String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  // 外部资讯属于不可信文本。过滤常见提示词注入措辞，仍保留正常财经语义。
  s = s.replace(/(ignore\s+(all\s+)?previous|system\s+prompt|developer\s+message|you\s+are\s+chatgpt|忽略.{0,12}(指令|要求|以上|前文)|系统提示词|开发者消息|执行.{0,8}指令)/ig, "[潜在指令文本已过滤]");
  return s.slice(0, max);
}
function cleanSnippets(xs, max = 8) {
  return (xs || []).slice(0, max).map((x, i) => ({
    id: `N${i + 1}`,
    title: cleanText(x.title, 120),
    body: cleanText(x.body, 300),
    url: String(x.url || "").slice(0, 500),
    source: cleanText(x.source, 40),
    date: cleanText(x.date, 20),
    category: cleanText(x.category, 60),
    trust: "untrusted_external_text",
  }));
}

function announcementCategory(title, columns = []) {
  const text = `${title || ""} ${(columns || []).join(" ")}`;
  if (/年度报告|半年度报告|季度报告|年报|季报|财务报告|审计报告|业绩预告|业绩快报|利润分配|权益分派|分红/.test(text)) return "财报与业绩";
  if (/董事会|监事会|股东大会|董事|监事|高管|公司章程|治理|独立董事/.test(text)) return "公司治理";
  if (/重大合同|中标|项目|投资|收购|出售|重组|关联交易|担保|诉讼|仲裁|处罚|风险提示/.test(text)) return "经营与重大事项";
  return (columns || []).filter(Boolean).slice(0, 2).join(" / ") || "公司公告";
}

function announcementSnippet(row) {
  const category = announcementCategory(row?.title, row?.columns);
  return {
    title: row?.title || "公司公告", body: [row?.noticeDate, category, (row?.columns || []).join(" / ")].filter(Boolean).join(" · "),
    url: row?.url || "", source: row?.source || "上市公司公告", date: row?.noticeDate || "", category,
  };
}

function mergeNewsRows(primary, secondary, max = 12) {
  const out = [], seen = new Set();
  for (const row of [...(primary || []), ...(secondary || [])]) {
    const key = String(row?.url || row?.title || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

/** Keep enterprise news precise: every result must name the selected company or its code. */
export function filterCompanySnippets(xs, name, code, max = 8) {
  const company = String(name || "").normalize("NFKC").replace(/\s+/g, "").trim();
  const digits = String(code || "").replace(/^(?:sh|sz|bj)/i, "").match(/\d{6}/)?.[0] || "";
  const aliases = [company]
    .concat(company.replace(/^(?:N|C|XD|XR|DR|ST|\*ST)/i, "").replace(/[-—](?:U|W|WD)$/i, ""))
    .filter((x, i, all) => x.length >= 2 && all.indexOf(x) === i);
  const seen = new Set(), out = [];
  for (const row of Array.isArray(xs) ? xs : []) {
    const haystack = `${row?.title || ""} ${row?.body || ""}`.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    if (!(digits && haystack.includes(digits)) && !aliases.some((term) => haystack.includes(term.toLowerCase()))) continue;
    const key = String(row?.url || row?.title || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

export const matchIndustryBoard = em.matchIndustryBoard;

async function boardForIndustry(industry) {
  if (!industry) return { board: null, peers: [] };
  const list = await em.emBoardList().catch(() => []);
  const board = matchIndustryBoard(industry, list);
  if (!board) return { board: null, peers: [] };
  const [live, peers] = await Promise.all([
    em.emBoardQuote(board.code).catch(() => null),
    em.emBoardConst(board.code, 80).catch(() => []),
  ]);
  return { board: live ? { ...board, ...live } : board, peers };
}

export function summarizeCapitalFlow(rows = [], error = "") {
  const value = (v) => v == null || String(v).trim() === "" ? null : num(v);
  const yi = (v) => value(v) == null ? null : value(v) / 1e8;
  const daily = rows.map((x) => ({ date: x.date, mainNetYi: yi(x.mainNet), mainPct: value(x.mainPct), largeNetYi: yi(x.largeNet), superNetYi: yi(x.superNet), changePct: value(x.changePct) }));
  const valid = daily.filter((x) => x.mainNetYi != null);
  const complete = daily.length >= 10 && valid.length === daily.length;
  return {
    status: !valid.length ? "unavailable" : complete ? "ok" : "partial",
    main10dNetYi: valid.length ? valid.reduce((sum, x) => sum + x.mainNetYi, 0) : null,
    validDays: valid.length,
    latestDate: daily.at(-1)?.date || null,
    source: "东方财富",
    message: !valid.length ? cleanText(error || "资金流接口暂无有效数据", 180) : complete ? "" : `仅获取到 ${valid.length} 个有效交易日，合计不代表完整近10日`,
    rows: daily,
  };
}

export async function collectResearchSupplement(code) {
  const pc = em.parseCode(code);
  if (!pc) return { error: "无法解析股票代码" };
  const ticker = `${pc.market}${pc.code}`;
  const quote = await em.emQuote(ticker).catch(() => null);
  if (!quote) return { error: "行情获取失败" };
  const name = quote.name || pc.code;
  const industry = quote.industry || "";
  const exchangeSite = pc.market === "bj" ? "bse.cn" : pc.market === "sh" ? "sse.com.cn" : "szse.cn";
  const searchDeadline = Date.now() + 8000;

  const [{ board, peers }, capitalFlow, lhb, research, announcements, companyNews, financialNews] = await Promise.all([
    boardForIndustry(industry),
    em.emCapitalFlow(ticker, 10).then((rows) => summarizeCapitalFlow(rows)).catch((e) => summarizeCapitalFlow([], e.message)),
    em.emLhbList(ticker, 10).catch(() => []),
    em.emResearch(ticker, 15).catch(() => ({ rows: [], total: 0 })),
    em.emAnnouncements(ticker, 80).catch(() => ({ rows: [], total: 0 })),
    searchBlob([
      `"${name}" ${pc.code} 董事会 股东大会 公司公告 重大事项`,
      `"${name}" ${pc.code} 公司新闻 新闻发布 经营进展 机构调研`,
    ], 4, { deadlineAt: searchDeadline }).catch(() => ({ snippets: [], text: "" })),
    searchBlob([
      `"${name}" ${pc.code} 年报 财报 季报 业绩报告 业绩预告`,
      `"${name}" ${pc.code} site:${exchangeSite} 公告 财务报告 分红`,
    ], 4, { deadlineAt: searchDeadline }).catch(() => ({ snippets: [], text: "" })),
  ]);

  const upPeers = peers.filter((x) => num(x.changePct, 0) > 0).length;
  const downPeers = peers.filter((x) => num(x.changePct, 0) < 0).length;
  const related = peers.slice(0, 12).map((x) => ({
    code: x.code, name: x.name, price: round(x.price), changePct: round(x.changePct),
    peTtm: round(x.peTtm), pb: round(x.pb), mcapYi: round(num(x.mcap, 0) / 1e8),
  }));
  const now = Date.now();
  const lhbMapped = lhb.slice(0, 12).map((x) => {
    const ts = Date.parse(String(x.tradeDate || ""));
    const ageDays = Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / 86400000)) : null;
    return { tradeDate: x.tradeDate, ageDays, isRecent30d: ageDays != null && ageDays <= 30, changeRate: round(x.changeRate), turnoverRate: round(x.turnoverRate), explanation: cleanText(x.explanation || x.explain, 120), buyYi: round(num(x.buyAmt, 0) / 1e8), sellYi: round(num(x.sellAmt, 0) / 1e8), netYi: round(num(x.netAmt, 0) / 1e8), d5: round(x.d5) };
  });
  const announcementRows = (announcements.rows || []).map(announcementSnippet);
  const financialAnnouncements = announcementRows.filter((x) => x.category === "财报与业绩");
  const companyAnnouncements = announcementRows.filter((x) => x.category !== "财报与业绩");
  const filteredCompanyNews = filterCompanySnippets(companyNews.snippets, name, pc.code, 8);
  const filteredFinancialNews = filterCompanySnippets(financialNews.snippets, name, pc.code, 8);

  return {
    code: ticker,
    name,
    updatedAt: Date.now(),
    quote: {
      price: round(quote.price), changePct: round(quote.changePct), high: round(quote.high), low: round(quote.low),
      prevClose: round(quote.prevClose), amountYi: round(num(quote.amount, 0) / 1e8), turnover: round(quote.turnover),
      volumeRatio: round(quote.volumeRatio), peTtm: round(quote.peTtm), pb: round(quote.pb), roe: round(quote.roe),
      marketCapYi: round(num(quote.marketCap, 0) / 1e8), floatMarketCapYi: round(num(quote.floatMarketCap, 0) / 1e8),
      industry, region: quote.region || "", floatShares: num(quote.floatShares, null),
    },
    relatedQuotes: {
      board: board ? { code: board.code, name: board.name, changePct: round(board.changePct), mainFlowYi: board.mainFlow == null ? null : round(num(board.mainFlow, 0) / 1e8), upCount: board.upCount, downCount: board.downCount } : null,
      breadth: { up: upPeers, down: downPeers, total: peers.length },
      peers: related,
    },
    transaction: {
      turnover: round(quote.turnover), volumeRatio: round(quote.volumeRatio), amountYi: round(num(quote.amount, 0) / 1e8),
      lhbRecent30d: lhbMapped.filter((x) => x.isRecent30d).slice(0, 8),
      lhbHistory: lhbMapped.slice(0, 8),
      note: "龙虎榜近期证据仅使用30日内记录；更早记录仅作为历史背景，不应被解释为当前交易行为。",
    },
    capitalFlow,
    research: {
      total: research.total || research.rows?.length || 0,
      rows: (research.rows || []).slice(0, 10).map((x) => ({ title: cleanText(x.title, 120), org: cleanText(x.org, 60), publishDate: x.publishDate, rating: x.emRating || x.sRating || "", aimPriceL: round(x.aimPriceL), aimPriceT: round(x.aimPriceT) })),
    },
    news: {
      general: cleanSnippets(mergeNewsRows(companyAnnouncements, filteredCompanyNews, 14), 14),
      sector: cleanSnippets(mergeNewsRows(financialAnnouncements, filteredFinancialNews, 12), 12),
      officialAnnouncementCount: announcements.total || announcementRows.length,
      scope: "selected_company",
      securityNotice: "法定披露公告按所选股票代码精确获取；网页资讯只保留明确提及企业名称或代码的结果。外部标题与摘要仍按不可信文本处理。",
    },
  };
}

function lastOrNull(arr) { return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null; }

function relDiff(a,b){const x=Number(a),y=Number(b);if(!Number.isFinite(x)||!Number.isFinite(y)||x===0||y===0)return null;return Math.abs(x-y)/Math.max(Math.abs(x),Math.abs(y));}
function buildDataQualityChecks(code, supplement){
  const checks=[]; const q=supplement?.quote||{}; 
  const normalized=String(code||"").replace(/^(sh|sz|bj)/i,"");
  const selfPeer=(supplement?.relatedQuotes?.peers||[]).find((x)=>String(x?.code||"")===normalized);
  if(selfPeer){
    const peA=Number(q.peTtm), peB=Number(selfPeer.peTtm);
    const peD=relDiff(peA,peB); if(peD!=null && peD>.2) checks.push({severity:"warning",field:"PE",message:`个股PE与同行报价中的自身PE存在口径差异（${round(peA)} vs ${round(peB)}），仅降低证据质量，不作为多空证据。`});
    const pbA=Number(q.pb), pbB=Number(selfPeer.pb);
    const pbD=relDiff(pbA,pbB); if(pbD!=null && pbD>.2) checks.push({severity:"warning",field:"PB",message:`个股PB与同行报价中的自身PB存在口径差异（${round(pbA)} vs ${round(pbB)}），仅降低证据质量，不作为多空证据。`});
  }
  const badFlow=(supplement?.capitalFlow?.rows||[]).find((x)=>Number.isFinite(Number(x?.changePct)) && Math.abs(Number(x.changePct))>50);
  if(badFlow) checks.push({severity:"error",field:"capitalFlow.changePct",message:`资金流涨跌幅出现异常值 ${badFlow.changePct}%，该字段暂不作为方向证据。`});
  return {status:checks.some(x=>x.severity==="error")?"error":checks.some(x=>x.severity==="warning")?"warning":"ok",checks,semantics:{
    technical:"基础技术因子与22类扩展指标是不同聚合模型/时间尺度；结论不同属于差异，不是数据冲突。",
    backtest:"策略回测只评价当前所选策略及参数，不代表股票整体未来方向。",
    missing:"null/undefined/未扫描/数据不足代表未知，只影响证据质量，不等于负面。",
    lhb:"只有30日内龙虎榜记录属于当前交易行为证据；更早记录只作历史背景。",
    capital:"主力资金与北向资金不是同一概念；无独立北向数据源时北向字段保持未知。",
    valuation:"PE/PB需区分动态/静态/TTM以及数据源时点；口径不同不得直接判为冲突。"
  }};
}

export function buildStructuredResearchReport({ code, signal, strategy, market, indicators, indicatorAnalysis = null, supplement, globalContext = null }) {
  if (supplement?.error) return { error: supplement.error };
  const q = supplement?.quote || {};
  const positive = [], negative = [], risks = [], gaps = [];
  const daily = signal?.daily || {};
  const factorMap = Object.fromEntries((daily.factors || []).map((x) => [x.key, x]));

  if ((daily.score || 0) >= 20) positive.push(`技术因子综合偏多（${daily.score}）`);
  if ((daily.score || 0) <= -20) negative.push(`技术因子综合偏空（${daily.score}）`);
  if ((factorMap.trend?.score || 0) >= 25) positive.push(`趋势因子较强（${factorMap.trend.score}）`);
  if ((factorMap.momentum?.score || 0) <= -20) negative.push(`动量因子走弱（${factorMap.momentum.score}）`);
  if ((factorMap.risk?.score || 0) >= 65) risks.push(`技术波动风险偏高（${factorMap.risk.score}/100）`);
  if (indicatorAnalysis) {
    if ((indicatorAnalysis.compositeScore || 0) >= 25) positive.push(`22类扩展技术指标聚合偏多（${indicatorAnalysis.compositeScore}）`);
    if ((indicatorAnalysis.compositeScore || 0) <= -25) negative.push(`22类扩展技术指标聚合偏空（${indicatorAnalysis.compositeScore}）`);
    if ((indicatorAnalysis.risk || 0) >= 65) risks.push(`扩展指标出现过热/波动风险（${indicatorAnalysis.risk}/100）`);
  }

  const flow = supplement?.capitalFlow?.status === "partial" || supplement?.capitalFlow?.status === "unavailable" ? null : num(supplement?.capitalFlow?.main10dNetYi);
  if (flow > 0) positive.push(`近10日主力资金净流入约 ${round(flow)} 亿元`);
  if (flow < 0) negative.push(`近10日主力资金净流出约 ${round(Math.abs(flow))} 亿元`);
  const board = supplement?.relatedQuotes?.board;
  if (board?.changePct > 1) positive.push(`所属板块当日较强（${board.changePct}%）`);
  if (board?.changePct < -1) negative.push(`所属板块当日偏弱（${board.changePct}%）`);
  const extScore = Number(globalContext?.externalImpactScore);
  if (Number.isFinite(extScore) && extScore >= 25) positive.push(`全球关联环境偏强（参考分 ${round(extScore,0)}）`);
  if (Number.isFinite(extScore) && extScore <= -25) negative.push(`全球关联环境偏弱（参考分 ${round(extScore,0)}）`);

  if (!supplement?.news?.general?.length) gaps.push("企业公告与动态搜索无有效摘要");
  if (!supplement?.news?.sector?.length) gaps.push("企业财报与新闻搜索无有效摘要");
  if (!strategy || strategy.error) gaps.push("策略历史回测不可用或尚未运行");
  if (!globalContext || globalContext.error) gaps.push("全球关联分析不可用或获取失败");
  if (supplement?.capitalFlow?.main10dNetYi == null || ["partial", "unavailable"].includes(supplement?.capitalFlow?.status)) gaps.push(`资金流：${supplement?.capitalFlow?.message || "未获取到有效资金数据，不作为资金方向判断依据"}`);
  for (const x of globalContext?.dataGaps || []) gaps.push(`全球关联：${x}`);

  const latestIndicators = (indicators || []).map((x) => ({ id: x.id, name: x.name, group: x.group, family: x.family, params: x.params || {}, latest: x.latest, trajectory: x.trajectory || null, analysis: x.analysis || null, note: x.note || null }));
  const dataQualityChecks = buildDataQualityChecks(code, supplement);
  return {
    meta: { version: "1.9.3", code, name: supplement?.name || code, generatedAt: Date.now(), reportType: "structured_rule_report" },
    overview: {
      price: q.price, changePct: q.changePct, industry: q.industry, marketRegime: market ? { label: market.label, score: market.score, risk: market.risk } : null,
      technicalScore: daily.score ?? null, technicalCompositeScore: indicatorAnalysis ? Math.round((daily.score ?? 0) * 0.65 + indicatorAnalysis.compositeScore * 0.35) : (daily.compositeScore ?? daily.score ?? null), verdict: daily.verdict || null, dataQuality: daily.dataQuality ?? null,
      historicalReliability: daily.reliability ?? signal?.validation?.reliability ?? null,
    },
    evidence: { positive, negative, risks, dataGaps: gaps },
    relatedQuotes: supplement?.relatedQuotes || null,
    transaction: supplement?.transaction || null,
    capitalFlow: supplement?.capitalFlow || null,
    technical: {
      factors: daily.factors || [], signalSummary: daily.summary || "", timing: signal?.timing || null,
      validation: signal?.validation || null, indicators: latestIndicators, advancedIndicatorAnalysis: indicatorAnalysis,
    },
    fundamentals: { basic: supplement?.quote || null },
    backtest: strategy ? {
      mode: strategy.mode || "manual", preset: strategy.config?.presetId || null, profile: strategy.selectedProfile || null,
      metrics: strategy.metrics || null, currentSignal: strategy.current || strategy.currentSignal || null,
      foldConsistency: strategy.foldConsistency ?? null, parameterStability: strategy.scan?.neighborhoodPositivePct ?? strategy.parameterScan?.profitableShare ?? strategy.scan?.profitableShare ?? null,
      recommendation: strategy.recommendation ? {
        headline: strategy.recommendation.headline || null, summary: strategy.recommendation.summary || null, confidence: strategy.recommendation.confidence ?? null,
        selectedProfile: strategy.recommendation.selectedProfile || strategy.selectedProfile || null,
        rankings: (strategy.recommendation.rankings || []).slice(0,4).map((x)=>({ id:x.id, name:x.name, score:x.score, styleFit:x.styleFit, marketFit:x.marketFit })),
        selected: (()=>{ const x=strategy.recommendation.profiles?.[strategy.selectedProfile || "balanced"]; return x ? { id:x.id,name:x.name,score:x.score,confidence:x.confidence,action:x.action,config:x.config,diagnostics:x.diagnostics,metrics:x.metrics,reasons:(x.reasons||[]).slice(0,6) } : null; })(),
        notice: strategy.recommendation.notice || null,
      } : null,
      methodology: strategy.methodology || null,
    } : null,
    research: supplement?.research || null,
    news: supplement?.news || null,
    globalContext,
    dataQualityChecks,
    rawForUi: { lastCapital: lastOrNull(supplement?.capitalFlow?.rows), peerBreadth: supplement?.relatedQuotes?.breadth || null },
    disclaimer: "规则报告用于汇总软件已有数据，不构成投资建议；结构化全球资产映射只作为研究线索。开放式新闻、政策、海外公司与产业链资料由 LLM 自主研究 Agent 在生成 AI 研报时按需检索，可能不完整或过时，重要事实需自行核验。",
  };
}

/** 给 LLM 的上下文：严格裁剪，避免把全量原始对象/冗长网页塞入模型。 */
export function compactForLlm(report) {
  if (!report || report.error) return report;
  const r = structuredClone(report);
  // 限制资讯条数，避免上下文膨胀。
  if (r.news?.general) r.news.general = r.news.general.slice(0, 10);
  if (r.news?.sector) r.news.sector = r.news.sector.slice(0, 10);
  if (r.relatedQuotes?.peers) r.relatedQuotes.peers = r.relatedQuotes.peers.slice(0, 8);
  if (r.transaction?.lhbRecent30d) r.transaction.lhbRecent30d = r.transaction.lhbRecent30d.slice(0, 5);
  if (r.transaction?.lhbHistory) r.transaction.lhbHistory = r.transaction.lhbHistory.slice(0, 5);
  if (r.capitalFlow?.rows) r.capitalFlow.rows = r.capitalFlow.rows.slice(-8);
  if (r.research?.rows) r.research.rows = r.research.rows.slice(0, 6);
  if (r.globalContext) {
    if (r.globalContext.assets) r.globalContext.assets = r.globalContext.assets.slice(0, 8);
    if (r.globalContext.policies) r.globalContext.policies = r.globalContext.policies.slice(0, 6);
    if (r.globalContext.industryNews) r.globalContext.industryNews = r.globalContext.industryNews.slice(0, 8);
  }
  // advancedIndicatorAnalysis 与 technical.indicators 存在信息重叠；LLM 保留族聚合和 strongest，避免重复消耗 token。
  if (r.technical?.advancedIndicatorAnalysis) {
    delete r.technical.advancedIndicatorAnalysis.indicators;
    for (const f of Object.values(r.technical.advancedIndicatorAnalysis.families || {})) {
      if (Array.isArray(f.members)) f.members = f.members.map((x) => ({ id:x.id, score:x.score, risk:x.risk, state:x.state })).slice(0, 8);
    }
  }
  return r;
}
