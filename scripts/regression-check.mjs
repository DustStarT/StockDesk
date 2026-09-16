/** StockDesk v1.9.2 回归测试：针对真实 LLM 案例暴露的数据口径/指标边界问题。全离线。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEmQuoteData, parseBoardConstRow, parseCapitalFlowLine, parseBoardListRow } from "../engine/market-fetchers.js";
import { INDICATOR_CATALOG, computeTechnicalIndicators, analyzeTechnicalIndicatorSet, indicatorSnapshot } from "../engine/technical-indicators.js";
import { buildPrompt, normalizeAiReport } from "../engine/llm-service.js";
import { buildStructuredResearchReport, compactForLlm, matchIndustryBoard } from "../engine/research-report.js";
import { buildAiReportHtml, buildAiReportDocx, evidenceLabel } from "../engine/report-export.js";
import { runStrategyLab } from "../engine/strategy-lab.js";

// 1) 东财实时快照字段映射：高/低/开不能串位。
const quote=parseEmQuoteData({
  f57:"601899",f58:"紫金矿业",f43:3465,f44:3510,f45:3401,f46:3420,f47:12345,f48:1e9,
  f60:3430,f71:3450,f50:125,f51:3773,f52:3087,f162:1400,f163:1500,f164:1362,f167:477,f168:201,f169:35,f170:102,f171:317
});
assert.equal(quote.price,34.65); assert.equal(quote.open,34.20); assert.equal(quote.high,35.10); assert.equal(quote.low,34.01);

// 2) fltt=2 的成分股估值已经格式化，不能再 /100。
const peer=parseBoardConstRow({f12:"601899",f14:"紫金矿业",f2:34.65,f3:1.02,f8:2.01,f9:14.12,f20:8e11,f23:4.77,f115:13.62});
assert.equal(peer.peTtm,13.62); assert.equal(peer.pb,4.77); assert.equal(peer.turnover,2.01);

// 2b) 关联板块必须按标准化后的行业名匹配，且关联报告必须真正等待板块查询完成。
const matchedBoard=matchIndustryBoard("塑料",[
  {code:"BK0001",name:"塑料制品"},{code:"BK0002",name:"塑料包装"},{code:"BK0003",name:"化学制品"},
]);
assert.equal(matchedBoard?.code,"BK0001");
assert.equal(matchIndustryBoard("半导体行业",[{code:"BK1",name:"半导体材料"},{code:"BK2",name:"半导体"}])?.code,"BK2");
const boardQuote=parseBoardListRow({f12:"BK0001",f14:"塑料制品",f3:1.23,f20:8e11,f62:-2.5e8,f104:30,f105:18,f106:2});
assert.equal(boardQuote.changePct,1.23); assert.equal(boardQuote.mainFlow,-2.5e8); assert.equal(boardQuote.count,50);
const researchSource=readFileSync(new URL("../engine/research-report.js",import.meta.url),"utf8");
assert.ok((researchSource.match(/boardForIndustry\(industry\)/g)||[]).length>=2,"关联板块查询必须接入报告采集流程");
assert.doesNotMatch(researchSource,/const\s+board\s*=\s*boardForIndustry\(industry\)(?!\s*[,;)])/,"板块 Promise 不得被当作普通对象使用");

// 3) 资金流字段：f62 是收盘价，f63 才是涨跌幅。
const flow=parseCapitalFlowLine("2026-08-28,-62000000,100,200,300,400,-0.5,0.1,0.2,0.3,0.4,34.65,1.04");
assert.equal(flow.price,34.65); assert.equal(flow.changePct,1.04); assert.equal(flow.mainNet,-62000000);

// 5) 完全平盘不能因为“不是大于”被判成系统性看空。
const flat=Array.from({length:240},(_,i)=>({time:`2026-${String(1+Math.floor(i/28)).padStart(2,"0")}-${String(1+i%28).padStart(2,"0")}`,open:10,high:10,low:10,close:10,volume:100000}));
const flatIndicators=computeTechnicalIndicators(INDICATOR_CATALOG.map(x=>x.id),flat,{floatShares:1e9},{});
const flatAnalysis=analyzeTechnicalIndicatorSet(flatIndicators,flat);
assert.ok(Math.abs(flatAnalysis.compositeScore)<=5, `flat composite should be neutral, got ${flatAnalysis.compositeScore}`);
for(const row of flatIndicators){
  assert.ok(Number.isFinite(row.analysis?.score ?? 0), `${row.id} score invalid`);
  assert.ok(Math.abs(row.analysis?.score ?? 0)<=65, `${row.id} flat score too extreme: ${row.analysis?.score}`);
}

// 6) 22 类指标给 LLM 的快照必须包含曲线轨迹，而非只有当前值。
const trend=Array.from({length:260},(_,i)=>{const c=10+i*.03+Math.sin(i/7)*.2;return{time:String(i),open:c-.03,high:c+.12,low:c-.12,close:c,volume:100000+i*500};});
const snaps=indicatorSnapshot(INDICATOR_CATALOG.map(x=>x.id),trend,{floatShares:1e9},{});
assert.equal(snaps.length,22);
for(const row of snaps){
  assert.ok(row.trajectory && typeof row.trajectory==="object", `${row.id} missing trajectory`);
  const line=Object.values(row.trajectory.lines||{})[0];
  assert.ok(line && Array.isArray(line.recent12), `${row.id} missing recent12`);
  assert.ok(Object.prototype.hasOwnProperty.call(line,"slope5"), `${row.id} missing slope5`);
}
// 结构化研报与 LLM 裁剪后也必须保留 trajectory；此前曾在这一步被意外丢弃。
const structured=buildStructuredResearchReport({code:"sh601899",deep:{name:"紫金矿业",features:{pe:13.62,pb:4.77,revenue_latest_yi:3490,market_cap_yi:8000},basic:{pe:13.62,pb:4.77}},signal:{daily:{score:10,factors:[],dataQuality:90},validation:{}},strategy:null,market:null,indicators:snaps,indicatorAnalysis:analyzeTechnicalIndicatorSet(computeTechnicalIndicators(INDICATOR_CATALOG.map(x=>x.id),trend,{floatShares:1e9},{}),trend),supplement:{name:"紫金矿业",quote:{price:34.65,changePct:1,industry:"有色",peTtm:13.62,pb:4.77},relatedQuotes:{peers:[{code:"601899",peTtm:13.62,pb:4.77}]},transaction:{},capitalFlow:{main10dNetYi:0,rows:[]},research:{rows:[]},news:{general:[],sector:[]}}});
const compact=compactForLlm(structured);
assert.equal(compact.technical.indicators.length,22);
assert.ok(compact.technical.indicators[0].trajectory?.lines);
assert.equal(compact.dataQualityChecks.status,"ok");
const badQuality=buildStructuredResearchReport({code:"sh601899",deep:{name:"紫金矿业",features:{pe:13.62,pb:4.77,revenue_latest_yi:3490,market_cap_yi:8000},basic:{pe:13.62,pb:4.77}},signal:{daily:{score:0,factors:[],dataQuality:90},validation:{}},strategy:null,market:null,indicators:snaps,indicatorAnalysis:null,supplement:{name:"紫金矿业",quote:{price:34.65,changePct:0,industry:"有色",peTtm:13.62,pb:4.77},relatedQuotes:{peers:[{code:"601899",peTtm:.14,pb:.05}]},transaction:{},capitalFlow:{main10dNetYi:0,rows:[{changePct:34.65}]},research:{rows:[]},news:{general:[],sector:[]}}});
assert.equal(badQuality.dataQualityChecks.status,"warning");
assert.ok(badQuality.dataQualityChecks.checks.some(x=>x.field==="PE"));
assert.ok(!(badQuality.evidence.negative||[]).some(x=>String(x).includes("口径")),"data quality warning must not become bearish evidence");

// 7) Prompt 应平衡多空、明确差异不等于负面，并要求分析22类曲线。
const prompt=buildPrompt({meta:{code:"sh601899",name:"紫金矿业"},technical:{indicators:snaps}}).system;
assert.ok(prompt.includes("多空证据对等"));
assert.ok(prompt.includes("“差异”不等于“负面”"));
assert.ok(prompt.includes("22 类扩展指标"));
assert.ok(prompt.includes("trajectory"));
assert.ok(prompt.includes("第一个非空字符必须是 {"));
assert.ok(prompt.includes("普通小数最多保留 2 位"));
assert.ok(prompt.includes("每条结论最多 6 个引用"));
assert.ok(prompt.includes("禁止在 JSON 前后添加说明"));

// 8) 新结构中的“差异”允许只降低置信度，不应被强制改为负面。
const normalized=normalizeAiReport({
  title:"测试",stance:"中性",executive_summary:"",evidence_quality:{score:70,reason:""},
  cross_module_consensus:[{type:"差异",impact:"仅降低置信度",summary:"不同时间尺度结论不同",evidence_refs:["technical.factors"]}],
  technical_indicator_review:{coverage:"22/22",family_summaries:[],notable_signals:[]}
});
assert.equal(normalized.cross_module_consensus[0].impact,"仅降低置信度");

// 9) 面向用户/导出的证据需是中文标签，英文技术路径只保留审计用途。
assert.equal(evidenceLabel("capitalFlow.main10dNetYi"),"近10日主力资金净额");
assert.equal(evidenceLabel("technical.advancedIndicatorAnalysis.families.trend.score"),"扩展指标 · 趋势族");
const archive={id:"test",stock:{code:"sh601899",name:"紫金矿业"},generatedAt:Date.now(),llm:{provider:"test",model:"mock"},inputSnapshot:{capitalFlow:{main10dNetYi:-0.62},technical:{factors:[{key:"trend",score:30}]}},result:{usage:{inputTokens:10,outputTokens:20},report:{title:"测试报告",stance:"中性",executive_summary:"摘要",evidence_quality:{score:80,reason:"完整"},sections:{technical:{summary:"技术说明",details:[],evidence_refs:["capitalFlow.main10dNetYi"]}},key_bull_points:[{text:"测试",evidence_refs:["capitalFlow.main10dNetYi"]}],key_bear_points:[],watch_conditions:[],invalidation_conditions:[],data_gaps:[],disclaimer:"仅供研究"}}};
const html=buildAiReportHtml(archive);
assert.ok(html.includes("近10日主力资金净额"));
assert.ok(html.includes("技术审计路径"));
const docx=buildAiReportDocx(archive); assert.ok(docx.length>5000 && docx.subarray(0,2).toString("ascii")==="PK");


// 10) LLM 即便不完全遵守格式，归一化层也要限制层级/引用数量并清理浮点尾数。
const noisy=normalizeAiReport({
  title:"格式测试",stance:"中性",executive_summary:"ROE 33.040000000000006%，DCF 41.97000000000001 元。",evidence_quality:{score:81.7,reason:"数据完整度 92.0000001%。"},
  sections:{technical:{summary:"动量 -13.0000000001",details:Array.from({length:8},(_,i)=>({point:`观察${i} 7.020999999999997`,interpretation:"说明",evidence_refs:Array.from({length:10},(_,j)=>`technical.path${j}`)})),evidence_refs:Array.from({length:10},(_,j)=>`technical.root${j}`)}},
  key_bull_points:Array.from({length:8},(_,i)=>({text:`支持${i}`,evidence_refs:Array.from({length:8},(_,j)=>`p${j}`)})),
  key_bear_points:Array.from({length:8},(_,i)=>({text:`风险${i}`})),
  watch_conditions:Array.from({length:9},(_,i)=>({condition:`条件${i}`,why:"原因"})),
  technical_indicator_review:{family_summaries:Array.from({length:9},(_,i)=>({family:"趋势",summary:String(i)})),notable_signals:Array.from({length:12},(_,i)=>({indicator:`I${i}`,observation:"o",interpretation:"i"}))}
});
assert.ok(noisy.executive_summary.includes("33.04%") && noisy.executive_summary.includes("41.97 元"), noisy.executive_summary);
assert.equal(noisy.sections.technical.details.length,4);
assert.equal(noisy.sections.technical.evidence_refs.length,6);
assert.equal(noisy.sections.technical.details[0].evidence_refs.length,6);
assert.equal(noisy.key_bull_points.length,4); assert.equal(noisy.key_bear_points.length,4);
assert.equal(noisy.watch_conditions.length,6);
assert.equal(noisy.technical_indicator_review.family_summaries.length,7);
assert.equal(noisy.technical_indicator_review.notable_signals.length,8);

// 11) 导出证据也必须人类可读：浮点数收敛、指标数组下标显示真实指标名，不直接 JSON.stringify 对象。
const polishedArchive={id:"fmt",stock:{code:"sh601899",name:"紫金矿业"},generatedAt:Date.now(),llm:{provider:"mock",model:"mock"},inputSnapshot:{technical:{indicators:[{id:"MACD",analysis:{score:-13,state:"偏空",summary:"DIF低于DEA",risk:20}}]},fundamentals:{features:{roe_latest:33.040000000000006}}},result:{report:{title:"格式测试",stance:"中性",executive_summary:"摘要",evidence_quality:{score:80,reason:"完整"},sections:{technical:{summary:"说明",details:[{point:"MACD",interpretation:"动量走弱",evidence_refs:["technical.indicators[0].analysis","fundamentals.features.roe_latest"]}],evidence_refs:[]}},key_bull_points:[],key_bear_points:[],watch_conditions:[],invalidation_conditions:[],data_gaps:[],disclaimer:"仅供研究"}}};
const polishedHtml=buildAiReportHtml(polishedArchive);
assert.ok(polishedHtml.includes("扩展技术指标 · MACD"));
assert.ok(polishedHtml.includes("评分 -13 · 状态 偏空"));
assert.ok(polishedHtml.includes("33.04"));
assert.ok(!polishedHtml.includes("33.040000000000006"));
assert.ok(!polishedHtml.includes('{&quot;score&quot;'));

// 12) 平盘/无交易样本不能被智能推荐器包装成高可信“最优策略”。
const flatSmart=runStrategyLab(flat,{mode:"smart",profile:"balanced"},{marketRegime:{state:"range"},scan:true});
assert.equal(flatSmart.recommendation?.status,"ok");
const flatRec=flatSmart.recommendation.profiles?.balanced;
assert.ok(flatRec);
assert.ok((flatRec.confidence??100)<=48,`flat confidence too high: ${flatRec.confidence}`);
assert.ok(String(flatRec.action||"").includes("样本")||String(flatRec.action||"").includes("不优先"),`flat action=${flatRec.action}`);

console.log("StockDesk v1.9.2 regression checks: PASS");
