import assert from "node:assert/strict";
import { resolveGlobalProfile, summarizeGlobalSeries, compactGlobalContext } from "../engine/global-context.js";
import { buildStructuredResearchReport, compactForLlm } from "../engine/research-report.js";
import { buildPrompt, normalizeAiReport } from "../engine/llm-service.js";

const semi=resolveGlobalProfile("中芯国际","半导体");
assert.equal(semi.id,"semiconductor");
assert.ok(semi.assets.includes("sox"));
const gold=resolveGlobalProfile("紫金矿业","贵金属");
assert.ok(["precious_metals","copper_mining"].includes(gold.id));
const general=resolveGlobalProfile("某公司","其他");
assert.equal(general.id,"general");

const rows=[]; let p=100;
for(let i=0;i<30;i++){p*=1.002;rows.push({date:`2026-07-${String(i+1).padStart(2,"0")}`,close:p});}
const series=summarizeGlobalSeries({symbol:"TEST",name:"测试",strength:.5},{meta:{currency:"USD"},rows});
assert.equal(series.available,true); assert.ok(series.change5d>0); assert.ok(series.change20d>0);
const c=compactGlobalContext({assets:Array.from({length:12},(_,i)=>({symbol:String(i)})),policies:[{id:"G1"}],industryNews:[{id:"G2"}],searchQueries:["legacy"]});
assert.equal(c.assets.length,8); assert.deepEqual(c.policies,[]); assert.deepEqual(c.industryNews,[]); assert.deepEqual(c.searchQueries,[]);

const gc={enabled:true,version:"1.9.1",externalImpactScore:32,externalImpactLabel:"外部环境偏强",mapping:{profileLabel:"半导体",method:"只做结构化资产映射"},assets:[{symbol:"^SOX",name:"费城半导体指数",change5d:3.2}],policies:[],industryNews:[],openResearchOwner:"llm_research_agent",dataGaps:[]};
const report=buildStructuredResearchReport({code:"sh688981",deep:null,signal:{daily:{score:10,factors:[]}},strategy:null,market:null,indicators:[],indicatorAnalysis:null,supplement:{name:"中芯国际",quote:{price:100,changePct:1,industry:"半导体"},relatedQuotes:{},transaction:{},capitalFlow:{main10dNetYi:0,rows:[]},research:{rows:[]},news:{general:[],sector:[]}},globalContext:gc});
assert.equal(report.meta.version,"1.9.3");
assert.equal(report.globalContext.externalImpactScore,32);
assert.ok(report.evidence.positive.some(x=>x.includes("全球关联环境")));
const compact=compactForLlm(report); assert.ok(compact.globalContext);
const prompt=buildPrompt(compact); assert.ok(prompt.user.includes("globalContext")); assert.ok(prompt.system.includes("Research Agent"));
const normalized=normalizeAiReport({title:"测试",stance:"中性",sections:{global_context:{summary:"海外同行偏强",details:[],evidence_refs:["globalContext.assets"]}}});
assert.equal(normalized.sections.global_context.summary,"海外同行偏强");
console.log("StockDesk v1.9.2 global context checks: PASS");
