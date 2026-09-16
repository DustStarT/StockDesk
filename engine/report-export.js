/**
 * StockDesk v1.5.0 · AI 研报导出
 * - HTML: 供 Electron printToPDF 使用
 * - DOCX: 零额外依赖生成标准 OOXML/ZIP 文档
 */

function escXml(v) {
  return String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function arr(v) { return Array.isArray(v) ? v : []; }
function when(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.toLocaleString("zh-CN", { hour12: false });
}


const EVIDENCE_LABELS = {
  "technical.factors":"基础技术因子", "technical.validation":"历史信号验证",
  "technical.advancedIndicatorAnalysis":"22类扩展指标聚合", "capitalFlow.main10dNetYi":"近10日主力资金净额",
  "capitalFlow.rows":"每日主力资金流", "relatedQuotes.board":"所属行业板块",
  "relatedQuotes.breadth":"板块涨跌宽度", "relatedQuotes.peers":"同行关联报价",
  "transaction.turnover":"换手率", "transaction.volumeRatio":"量比", "transaction.amountYi":"成交额",
  "transaction.lhbRecent30d":"近30日龙虎榜", "transaction.lhbHistory":"历史龙虎榜",
  "riskScan":"扫雷结果", "research.rows":"机构研报", "news.general":"综合资讯", "news.sector":"板块资讯",
  "backtest.metrics":"历史回测指标", "backtest.currentSignal":"当前策略触发状态", "backtest.parameterStability":"参数稳定性",
  "overview.marketRegime":"市场状态", "overview.technicalCompositeScore":"融合技术评分",
  "fundamentals.features.roe_latest":"最新ROE", "fundamentals.features.revenue_latest_yi":"最新营收",
  "fundamentals.features.net_profit_latest_yi":"最新归母净利润", "fundamentals.features.pe":"市盈率",
  "fundamentals.features.pb":"市净率"
};
const FAMILY_LABELS={trend:"趋势",momentum:"动量",volume:"量价",sentiment:"情绪",volatility:"波动",support:"支撑压力",cost:"成本"};

const PATH_SEGMENT_LABELS={
  overview:"综合概览",changePct:"涨跌幅",historicalReliability:"历史可靠度",verdict:"基础技术结论",marketRegime:"市场状态",technicalCompositeScore:"融合技术评分",
  relatedQuotes:"关联报价",peers:"同行股票",board:"所属板块",breadth:"板块宽度",mainFlowYi:"主力资金净额(亿元)",upCount:"上涨家数",downCount:"下跌家数",peTtm:"市盈率TTM",pb:"市净率",
  technical:"技术分析",factors:"基础技术因子",trend:"趋势",momentum:"动量",volume:"量价",risk:"风险",validation:"历史信号验证",sampleSize:"历史样本数",reliability:"历史可靠度",horizons:"持有周期",hitRate:"历史胜率",indicators:"扩展技术指标",advancedIndicatorAnalysis:"扩展指标聚合",families:"指标族",score:"评分",state:"状态",summary:"摘要",latest:"最新值",trajectory:"曲线轨迹",lines:"曲线",recentCross:"最近交叉",
  fundamentals:"基本面",features:"基本面特征",basic:"基础财务/估值",methods:"估值模型",dcf:"DCF估值",intrinsic_per_share:"每股内在价值",safety_margin_pct:"安全边际",tv_pct_of_ev:"永续价值占企业价值比例",sensitivity_table:"敏感性分析表",base_fcf_yi:"基础自由现金流(亿元)",roe_latest:"最新ROE",roe_5y_min:"近5年最低ROE",roe_5y_above_15:"近5年ROE>15%次数",roe_trend_up:"ROE趋势向上",net_profit_growth_latest:"最新净利润增速",revenue_growth_latest:"最新营收增速",gross_margin:"毛利率",pe_quantile_5y:"PE五年分位",peg:"PEG",eps:"每股收益EPS",fcf_margin:"自由现金流率",fcf_positive:"自由现金流为正",lhb_30d_count:"近30日龙虎榜次数",matched_youzi_count:"识别游资席位数",sentiment_heat:"资讯热度",sentiment_positive_pct:"正面资讯占比",has_positive_catalyst:"存在正面催化",has_negative_catalyst:"存在负面催化",vs_peer_avg_pe:"相对同业PE",volatility_1y:"一年波动率",max_drawdown_1y:"一年最大回撤",pct_from_year_high:"距年内高点幅度",roic:"投入资本回报率ROIC",pe:"市盈率",revenue_latest_yi:"最新营收(亿元)",net_profit_latest_yi:"最新归母净利润(亿元)",
  capitalFlow:"资金流向",main10dNetYi:"近10日主力资金净额",rows:"明细",largeNetYi:"大单净额(亿元)",superNetYi:"超大单净额(亿元)",mainPct:"主力净占比",
  transaction:"交易行为",turnover:"换手率",volumeRatio:"量比",amountYi:"成交额(亿元)",lhb:"龙虎榜",lhbRecent30d:"近30日龙虎榜",lhbHistory:"历史龙虎榜",netYi:"净额(亿元)",d5:"上榜后5日表现",tradeDate:"交易日期",
  research:"机构研报",total:"数量",rating:"评级",title:"标题",org:"机构",news:"资讯",general:"综合资讯",sector:"板块资讯",securityNotice:"资讯安全说明",
  backtest:"历史回测",metrics:"回测指标",currentSignal:"当前策略触发",parameterStability:"参数稳定性",foldConsistency:"分段一致性",
  riskScan:"扫雷结果",externalResearch:"自主外部研究",analysis:"指标分析",riskScore:"风险评分",evidence:"计算依据",params:"参数"
};
function genericChinesePathLabel(path){
  const cleaned=String(path||"").replace(/\[([^\]]+)\]/g,".$1");
  const segs=cleaned.split(".").filter(Boolean);
  const labels=[];
  for(const seg of segs){
    if(/^\d+$/.test(seg)){labels.push(`第${Number(seg)+1}项`);continue;}
    if(/^N\d+$/i.test(seg)){labels.push(`资讯${seg.toUpperCase()}`);continue;}
    const low=String(seg).toLowerCase();
    if(FAMILY_LABELS[low]){labels.push(`${FAMILY_LABELS[low]}族`);continue;}
    labels.push(PATH_SEGMENT_LABELS[seg]||PATH_SEGMENT_LABELS[low]||String(seg).replace(/_/g," "));
  }
  return labels.filter((v,i,a)=>v&&v!==a[i-1]).join(" · ")||"软件内部证据";
}
export function evidenceLabel(path) {
  const x=String(path||"");
  if (/^R\d+$/.test(x)) return `外部研究资料 ${x}`;
  if (EVIDENCE_LABELS[x]) return EVIDENCE_LABELS[x];
  const fam=x.match(/(?:technical\.)?advancedIndicatorAnalysis\.families\.(trend|momentum|volume|sentiment|volatility|support|cost)/i);
  if (fam) return `扩展指标 · ${FAMILY_LABELS[String(fam[1]).toLowerCase()]||fam[1]}族`;
  const im=x.match(/technical\.indicators(?:\[([^\]]+)\]|\.([A-Z0-9-]+))/i);
  if (im) {
    const id=im[1]||im[2]; const rest=x.slice((im.index||0)+im[0].length).replace(/^\./,"");
    return `扩展技术指标 · ${id}${rest?` · ${genericChinesePathLabel(rest)}`:""}`;
  }
  for (const [k,v] of Object.entries(EVIDENCE_LABELS)) if (x.startsWith(k+".")) {
    const suffix=x.slice(k.length+1);
    return suffix ? `${v} · ${genericChinesePathLabel(suffix)}` : v;
  }
  return genericChinesePathLabel(x);
}

function getPath(root,path){
  let cur=root;
  try {
    for(const part of String(path||"").replace(/\[(\d+)\]/g,".$1").split(".")){ if(!part)continue; cur=cur?.[part]; if(cur==null)break; }
    return cur;
  } catch { return undefined; }
}
function humanNumber(v){
  const n=Number(v); if(!Number.isFinite(n))return "";
  if(Number.isInteger(n))return n.toLocaleString("zh-CN");
  if(Math.abs(n)>0&&Math.abs(n)<0.01)return n>0?"<0.01":">-0.01";
  return n.toLocaleString("zh-CN",{maximumFractionDigits:2,minimumFractionDigits:0,useGrouping:true});
}
function compactEvidenceValue(v,maxChars=120){
  if(v==null)return "";
  if(typeof v==="number")return humanNumber(v);
  if(typeof v==="boolean")return v?"是":"否";
  if(typeof v==="string"){
    const t=v.trim(); if(/^[-+]?\d+(?:\.\d+)?$/.test(t))return humanNumber(Number(t));
    return t.length>maxChars?`${t.slice(0,maxChars-1)}…`:t;
  }
  if(Array.isArray(v))return v.every(x=>x==null||typeof x!=="object")?`${v.slice(0,4).map(x=>compactEvidenceValue(x,28)).join(" / ")}${v.length>4?` · 另${v.length-4}项`:""}`:`${v.length}项结构化数据`;
  if(typeof v==="object"){
    const labels={score:"评分",state:"状态",summary:"摘要",risk:"风险",hitRate:"胜率",sampleSize:"样本",reliability:"可靠度",upCount:"上涨",downCount:"下跌",changePct:"涨跌幅",mainNetYi:"主力净额"};
    const parts=[];
    for(const k of ["score","state","summary","risk","hitRate","sampleSize","reliability","upCount","downCount","changePct","mainNetYi"]){
      if(v[k]==null||typeof v[k]==="object")continue;
      const val=compactEvidenceValue(v[k],58); if(val)parts.push(`${labels[k]||k} ${val}${(/Pct$|hitRate/i.test(k)&&!val.includes("%"))?"%":""}`);
      if(parts.length>=4)break;
    }
    return parts.length?parts.join(" · "):`${Object.keys(v).length}项结构化数据`;
  }
  return "";
}
function evidenceValue(path, source){
  const x=String(path||"");
  if(/^R\d+$/.test(x)){
    const row=source?.externalResearch?.sources?.find?.((r)=>r.id===x);
    if(!row)return "";
    return compactEvidenceValue(`${row.title||row.query||x}${row.snippet?` · ${row.snippet}`:""}`,120);
  }
  if(/^G\d+$/.test(x)){
    const rows=[...(source?.globalContext?.policies||[]),...(source?.globalContext?.industryNews||[])];
    const row=rows.find((r)=>r.id===x); if(!row)return "";
    return compactEvidenceValue(`${row.title||x}${row.body?` · ${row.body}`:""}`,120);
  }
  return compactEvidenceValue(getPath(source,x),120);
}
function sourceAwareEvidenceLabel(path,source){
  const x=String(path||""); const m=x.match(/technical\.indicators\[(\d+)\]/i);
  if(m){const idx=Number(m[1]);const id=source?.technical?.indicators?.[idx]?.id||source?.technical?.indicators?.[idx]?.name;if(id){const rest=x.slice(m.index+m[0].length).replace(/^\./,"");return `扩展技术指标 · ${id}${rest?` · ${genericChinesePathLabel(rest)}`:""}`;}}
  return evidenceLabel(x);
}
function evidenceRows(refs, source){
  return [...new Set(arr(refs).filter(Boolean).map(String))].map((path)=>({path,label:sourceAwareEvidenceLabel(path,source),value:evidenceValue(path,source)}));
}

const SECTION_LABELS = {
  market_and_related: "市场环境与关联报价",
  technical: "技术面与量价",
  fundamentals: "基本面与估值",
  capital_and_trading: "资金与交易行为",
  news_and_sector: "综合资讯与板块",
  global_context: "全球关联环境",
  backtest: "历史回测与策略验证",
  risk: "风险与扫雷",
};

function normalizeArchive(input) {
  const archive = input?.result ? input : { result: input };
  const report = archive?.result?.report || archive?.report || {};
  return { archive, report, source: archive?.inputSnapshot || archive?.sourceReport || null };
}

function refsHtml(refs, source) {
  const rows=evidenceRows(refs,source);
  if(!rows.length)return "";
  return `<div class="refs"><b>依据：</b>${rows.map((r)=>`<span class="ev"><strong>${escHtml(r.label)}</strong>${r.value?`：${escHtml(r.value)}`:""}</span>`).join("")}<details><summary>技术审计路径 · ${rows.length}</summary>${rows.map((r)=>`<code>${escHtml(r.path)}</code>`).join(" ")}</details></div>`;
}
function pointsHtml(items, tone = "", source = null) {
  if (!arr(items).length) return `<div class="empty">暂无</div>`;
  return `<div class="points">${arr(items).map((x) => `<div class="point ${tone}"><div>${escHtml(x?.text || x?.condition || x?.summary || x || "")}</div>${x?.why ? `<small>${escHtml(x.why)}</small>` : ""}${refsHtml(x?.evidence_refs, source)}</div>`).join("")}</div>`;
}

export function buildAiReportHtml(input) {
  const { archive, report, source } = normalizeArchive(input);
  const stockName = archive?.stock?.name || source?.meta?.name || source?.name || "股票";
  const code = archive?.stock?.code || source?.meta?.code || "";
  const generatedAt = archive?.generatedAt || archive?.result?.generatedAt || Date.now();
  const llm = archive?.llm || {};
  const usage = archive?.result?.usage || {};
  const cost = archive?.result?.actualCost;
  const sections = Object.entries(report.sections || {});
  const conflicts = arr(report.cross_module_consensus || report.conflicts);
  const scenarios = report.scenarios || report.scenario_analysis || {};
  const action = report.action_framework || null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(report.title || `${stockName} 智能分析报告`)}</title><style>
  @page{size:A4;margin:16mm 15mm 18mm}*{box-sizing:border-box}body{font-family:"Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif;color:#172033;background:#fff;font-size:12.5px;line-height:1.7;margin:0}h1{font-size:24px;margin:0 0 5px}.sub{color:#64748b;margin-bottom:16px}.hero{border:1px solid #dbe4f0;border-radius:14px;padding:16px 18px;background:#f8fafc;margin-bottom:14px}.stance{display:inline-block;border-radius:999px;padding:4px 10px;background:#e8eef9;font-weight:700;margin-right:8px}.score{float:right;font-weight:700}.summary{font-size:14px;margin:10px 0 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{border:1px solid #dbe4f0;border-radius:10px;padding:12px;margin:9px 0;break-inside:avoid}.card h2{font-size:15px;margin:0 0 7px}.card h3{font-size:13px;margin:8px 0 5px}.detail{padding:7px 9px;background:#f8fafc;border-radius:7px;margin:6px 0}.refs{color:#64748b;font-size:10.5px;margin-top:4px}.refs .ev{display:block;margin-top:3px}.refs .ev strong{color:#334155}.refs code{background:#eef2f7;border-radius:4px;padding:1px 4px;margin-right:3px}.point{border-left:3px solid #94a3b8;padding:5px 9px;margin:6px 0}.point.pos{border-color:#16a34a}.point.neg{border-color:#dc2626}.point.warn{border-color:#d97706}.point small{display:block;color:#475569}.meta{margin-top:16px;border-top:1px solid #dbe4f0;padding-top:9px;color:#64748b;font-size:10.5px}.empty{color:#94a3b8}.scenario{display:grid;grid-template-columns:76px 1fr;gap:8px;padding:6px 0;border-bottom:1px dashed #e2e8f0}.scenario:last-child{border-bottom:0}.pill{font-weight:700}.disclaimer{margin-top:14px;padding:10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#7c2d12}@media print{.card,.hero{break-inside:avoid}}
  </style></head><body>
  <h1>${escHtml(report.title || `${stockName} 智能分析报告`)}</h1><div class="sub">${escHtml(stockName)} ${escHtml(code)} · ${escHtml(when(generatedAt))}</div>
  <div class="hero"><span class="stance">${escHtml(report.stance || "—")}</span><span class="score">证据质量 ${escHtml(report.evidence_quality?.score ?? "—")}/100</span><div class="summary">${escHtml(report.executive_summary || "")}</div>${report.evidence_quality?.reason ? `<div class="refs">${escHtml(report.evidence_quality.reason)}</div>` : ""}</div>
  ${report._parse_warning ? `<div class="card" style="border-color:#f59e0b;background:#fffbeb"><b>模型输出恢复提示</b><div>${escHtml(report._parse_warning)}</div></div>` : ""}
  <div class="grid"><div class="card"><h2>主要支持证据</h2>${pointsHtml(report.key_bull_points, "pos", source)}</div><div class="card"><h2>主要反向与风险证据</h2>${pointsHtml(report.key_bear_points, "neg", source)}</div></div>
  ${sections.map(([k, v]) => `<div class="card"><h2>${escHtml(SECTION_LABELS[k] || k)}</h2><div>${escHtml(v?.summary || "")}</div>${arr(v?.details).map((d) => `<div class="detail"><b>${escHtml(d?.point || d?.title || "补充分析")}</b>${d?.interpretation ? `<div>${escHtml(d.interpretation)}</div>` : ""}${refsHtml(d?.evidence_refs, source)}</div>`).join("")}${refsHtml(v?.evidence_refs, source)}</div>`).join("")}
  ${report.technical_indicator_review ? `<div class="card"><h2>22类技术指标专项解读</h2><div>覆盖：${escHtml(report.technical_indicator_review.coverage||"—")}</div>${arr(report.technical_indicator_review.family_summaries).map((x)=>`<div class="detail"><b>${escHtml(x.family||"指标族")}</b><div>${escHtml(x.summary||"")}</div>${arr(x.key_indicators).length?`<div class="refs">关键指标：${escHtml(arr(x.key_indicators).join(" / "))}</div>`:""}${refsHtml(x.evidence_refs, source)}</div>`).join("")}${arr(report.technical_indicator_review.notable_signals).map((x)=>`<div class="detail"><b>${escHtml(x.indicator||"指标")}</b><div>${escHtml(x.observation||"")}${x.interpretation?` · ${escHtml(x.interpretation)}`:""}</div>${refsHtml(x.evidence_refs, source)}</div>`).join("")}</div>` : ""}
  ${report.external_research_summary?.used || source?.externalResearch?.sources?.length ? `<div class="card"><h2>LLM 自主外部研究</h2><div>${escHtml(report.external_research_summary?.summary||`本次检索到 ${source?.externalResearch?.sources?.length||0} 条资料。`)}</div>${refsHtml(report.external_research_summary?.source_ids, source)}${arr(source?.externalResearch?.rounds).length?`<div class="detail"><b>研究过程</b>${arr(source.externalResearch.rounds).slice(0,6).map(r=>`<div>第 ${escHtml(r.round)} 轮：${escHtml(r.plan?.focus||"")} · ${(r.plan?.queries||[]).map(q=>escHtml(q.query||q)).join(" / ")}</div>`).join("")}<div class="refs">停止原因：${escHtml(source.externalResearch.stopReason||"—")}</div></div>`:""}${arr(source?.externalResearch?.sources).slice(0,20).map((r)=>`<div class="detail"><b>${escHtml(r.id||"")} · ${escHtml(r.title||r.query||"")}</b><div>${escHtml(r.snippet||r.page||"")}</div>${r.sourceGrade?`<div class="refs">来源等级：${escHtml(r.sourceGrade)} · ${escHtml(r.sourceLabel||"")}</div>`:""}${r.url?`<div class="refs">来源：${escHtml(r.url)}</div>`:""}</div>`).join("")}</div>` : ""}
  ${conflicts.length ? `<div class="card"><h2>跨模块一致性与差异</h2>${conflicts.map((x) => `<div class="detail"><b>${escHtml(x.type || "观察")}</b> ${escHtml(x.summary || x.text || "")}${refsHtml(x.evidence_refs, source)}</div>`).join("")}</div>` : ""}
  ${Object.keys(scenarios).length ? `<div class="card"><h2>情景推演</h2>${Object.entries(scenarios).map(([k,v]) => `<div class="scenario"><span class="pill">${escHtml(k)}</span><div>${escHtml(v?.summary || v?.implication || v || "")}${v?.trigger ? `<div class="refs">触发：${escHtml(v.trigger)}</div>` : ""}${refsHtml(v?.evidence_refs, source)}</div></div>`).join("")}</div>` : ""}
  ${action ? `<div class="card"><h2>当前研究框架</h2><div>${escHtml(action.summary || action.current || "")}</div>${arr(action.steps).map((x) => `<div class="detail">${escHtml(x)}</div>`).join("")}</div>` : ""}
  <div class="grid"><div class="card"><h2>后续观察条件</h2>${pointsHtml(report.watch_conditions, "", source)}</div><div class="card"><h2>结论失效条件</h2>${pointsHtml(report.invalidation_conditions, "warn", source)}</div></div>
  <div class="card"><h2>数据缺口 / 待核验</h2>${arr(report.data_gaps).map((x) => `<div class="point">${escHtml(x)}</div>`).join("") || '<div class="empty">暂无明确缺口</div>'}</div>
  <div class="disclaimer">${escHtml(report.disclaimer || "仅供研究，不构成投资建议。")}</div>
  <div class="meta">模型：${escHtml(llm.provider || "—")} / ${escHtml(llm.model || archive?.result?.rawModel || "—")} · 输入 ${escHtml(usage.inputTokens ?? "—")} tokens · 输出 ${escHtml(usage.outputTokens ?? "—")} tokens${cost?.totalCost != null ? ` · 估算 ${escHtml(cost.currency || "")} ${Number(cost.totalCost).toFixed(4)}` : ""} · 报告档案 ID：${escHtml(archive?.id || "—")}</div>
  </body></html>`;
}

function xmlRun(text, { bold = false, color = null, size = 22 } = {}) {
  const props = [bold ? "<w:b/>" : "", color ? `<w:color w:val="${color}"/>` : "", `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`, '<w:rFonts w:eastAsia="Microsoft YaHei" w:ascii="Calibri" w:hAnsi="Calibri"/>'].join("");
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${escXml(text)}</w:t></w:r>`;
}
function para(text, style = null, opts = {}) {
  const ppr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${ppr}${xmlRun(text, opts)}</w:p>`;
}
function bullet(text) { return para(`• ${text}`, null, { size: 21 }); }
function refsDoc(refs, source) {
  const rows=evidenceRows(refs,source);
  if(!rows.length)return "";
  const readable=rows.map((r)=>`${r.label}${r.value?`：${r.value}`:""}`).join("；");
  const audit=rows.map((r)=>r.path).join(" · ");
  return para(`依据：${readable}`, "Evidence") + para(`技术审计路径：${audit}`, "Evidence");
}
function buildDocumentXml(input) {
  const { archive, report, source } = normalizeArchive(input);
  const stockName = archive?.stock?.name || source?.meta?.name || "股票";
  const code = archive?.stock?.code || source?.meta?.code || "";
  const generatedAt = archive?.generatedAt || archive?.result?.generatedAt || Date.now();
  const llm = archive?.llm || {};
  const usage = archive?.result?.usage || {};
  const cost = archive?.result?.actualCost;
  const out = [];
  out.push(para(report.title || `${stockName} 智能分析报告`, "Title"));
  out.push(para(`${stockName} ${code}  |  ${when(generatedAt)}`, "Subtitle"));
  out.push(para(`总体观点：${report.stance || "—"}    证据质量：${report.evidence_quality?.score ?? "—"}/100`, "Heading2"));
  if (report.executive_summary) out.push(para(report.executive_summary));
  if (report.evidence_quality?.reason) out.push(para(`证据质量说明：${report.evidence_quality.reason}`, "Evidence"));
  if (report._parse_warning) out.push(para(`模型输出恢复提示：${report._parse_warning}`, "Disclaimer"));

  out.push(para("主要支持证据", "Heading1"));
  for (const x of arr(report.key_bull_points)) { out.push(bullet(x?.text || x)); out.push(refsDoc(x?.evidence_refs, source)); }
  if (!arr(report.key_bull_points).length) out.push(para("暂无。", "Evidence"));
  out.push(para("主要反向与风险证据", "Heading1"));
  for (const x of arr(report.key_bear_points)) { out.push(bullet(x?.text || x)); out.push(refsDoc(x?.evidence_refs, source)); }
  if (!arr(report.key_bear_points).length) out.push(para("暂无。", "Evidence"));

  for (const [k, v] of Object.entries(report.sections || {})) {
    out.push(para(SECTION_LABELS[k] || k, "Heading1"));
    if (v?.summary) out.push(para(v.summary));
    for (const d of arr(v?.details)) {
      if (d?.point || d?.title) out.push(para(d.point || d.title, "Heading3"));
      if (d?.interpretation) out.push(para(d.interpretation));
      out.push(refsDoc(d?.evidence_refs, source));
    }
    out.push(refsDoc(v?.evidence_refs, source));
  }

  if (report.technical_indicator_review) {
    out.push(para("22类技术指标专项解读", "Heading1"));
    if (report.technical_indicator_review.coverage) out.push(para(`覆盖：${report.technical_indicator_review.coverage}`, "Evidence"));
    for (const x of arr(report.technical_indicator_review.family_summaries)) {
      out.push(para(x.family || "指标族", "Heading3"));
      if (x.summary) out.push(para(x.summary));
      if (arr(x.key_indicators).length) out.push(para(`关键指标：${arr(x.key_indicators).join(" / ")}`, "Evidence"));
      out.push(refsDoc(x.evidence_refs, source));
    }
    for (const x of arr(report.technical_indicator_review.notable_signals)) {
      out.push(para(x.indicator || "关键指标", "Heading3"));
      out.push(para(`${x.observation || ""}${x.interpretation ? ` · ${x.interpretation}` : ""}`));
      out.push(refsDoc(x.evidence_refs, source));
    }
  }
  if (report.external_research_summary?.used || source?.externalResearch?.sources?.length) {
    out.push(para("LLM 自主外部研究", "Heading1"));
    out.push(para(report.external_research_summary?.summary || `本次检索到 ${source?.externalResearch?.sources?.length || 0} 条资料。`));
    out.push(refsDoc(report.external_research_summary?.source_ids, source));
    if (arr(source?.externalResearch?.rounds).length) {
      out.push(para("研究过程", "Heading2"));
      for (const rr of arr(source.externalResearch.rounds).slice(0,6)) out.push(bullet(`第 ${rr.round} 轮：${rr.plan?.focus || "自主研究"} · ${(rr.plan?.queries || []).map(q=>q.query||q).join(" / ")}`));
      if (source.externalResearch.stopReason) out.push(para(`停止原因：${source.externalResearch.stopReason}`, "Evidence"));
    }
    for (const r of arr(source?.externalResearch?.sources).slice(0,20)) {
      out.push(para(`${r.id || ""} · ${r.title || r.query || "资料"}`, "Heading3"));
      if (r.snippet || r.page) out.push(para(String(r.snippet || r.page).slice(0,900)));
      if (r.sourceGrade) out.push(para(`来源等级：${r.sourceGrade} · ${r.sourceLabel || ""}`, "Evidence"));
      if (r.url) out.push(para(`来源：${r.url}`, "Evidence"));
    }
  }

  const conflicts = arr(report.cross_module_consensus || report.conflicts);
  if (conflicts.length) {
    out.push(para("跨模块一致性与差异", "Heading1"));
    for (const x of conflicts) { out.push(bullet(`${x.type ? x.type + "：" : ""}${x.summary || x.text || ""}`)); out.push(refsDoc(x.evidence_refs, source)); }
  }
  const scenarios = report.scenarios || report.scenario_analysis || {};
  if (Object.keys(scenarios).length) {
    out.push(para("情景推演", "Heading1"));
    for (const [k, v] of Object.entries(scenarios)) {
      out.push(para(k, "Heading3"));
      out.push(para(v?.summary || v?.implication || String(v || "")));
      if (v?.trigger) out.push(para(`触发：${v.trigger}`, "Evidence"));
      out.push(refsDoc(v?.evidence_refs, source));
    }
  }
  if (report.action_framework) {
    out.push(para("当前研究框架", "Heading1"));
    out.push(para(report.action_framework.summary || report.action_framework.current || ""));
    for (const x of arr(report.action_framework.steps)) out.push(bullet(x));
  }
  out.push(para("后续观察条件", "Heading1"));
  for (const x of arr(report.watch_conditions)) { out.push(bullet(`${x.condition || x}: ${x.why || ""}`)); out.push(refsDoc(x.evidence_refs, source)); }
  out.push(para("结论失效条件", "Heading1"));
  for (const x of arr(report.invalidation_conditions)) { out.push(bullet(`${x.condition || x}: ${x.why || ""}`)); out.push(refsDoc(x.evidence_refs, source)); }
  out.push(para("数据缺口 / 待核验", "Heading1"));
  for (const x of arr(report.data_gaps)) out.push(bullet(x));
  if (!arr(report.data_gaps).length) out.push(para("暂无明确缺口。", "Evidence"));
  out.push(para(report.disclaimer || "仅供研究，不构成投资建议。", "Disclaimer"));
  out.push(para(`模型：${llm.provider || "—"} / ${llm.model || archive?.result?.rawModel || "—"}；输入 ${usage.inputTokens ?? "—"} tokens；输出 ${usage.outputTokens ?? "—"} tokens${cost?.totalCost != null ? `；估算 ${cost.currency || ""} ${Number(cost.totalCost).toFixed(4)}` : ""}；档案 ID：${archive?.id || "—"}`, "Evidence"));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${out.filter(Boolean).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:eastAsia="Microsoft YaHei" w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="180"/></w:pPr><w:rPr><w:b/><w:sz w:val="38"/><w:rFonts w:eastAsia="Microsoft YaHei"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="64748B"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1E3A5F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Evidence"><w:name w:val="Evidence"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="64748B"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Disclaimer"><w:name w:val="Disclaimer"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="9A3412"/><w:b/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`;

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function zipStore(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of entries) {
    const nameBuf = Buffer.from(name, "utf8"), data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nameBuf.length),u16(0),nameBuf,data]);
    locals.push(local);
    const central = Buffer.concat([u32(0x02014b50),u16(20),u16(20),u16(0x0800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nameBuf.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),nameBuf]);
    centrals.push(central); offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(centralBuf.length),u32(offset),u16(0)]);
  return Buffer.concat([...locals, centralBuf, end]);
}

export function buildAiReportDocx(input) {
  const now = new Date().toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>StockDesk AI Research Report</dc:title><dc:creator>StockDesk</dc:creator><cp:lastModifiedBy>StockDesk</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const entries = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ["docProps/core.xml", core],
    ["docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>StockDesk</Application></Properties>`],
    ["word/document.xml", buildDocumentXml(input)],
    ["word/styles.xml", stylesXml],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`],
  ];
  return zipStore(entries);
}
