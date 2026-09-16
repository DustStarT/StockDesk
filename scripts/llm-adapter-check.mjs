/** StockDesk v1.9.2 LLM 适配器 Mock：
 * 1) OpenAI-compatible response_format 降级；
 * 2) 正式请求不带客户端输出上限；
 * 3) reasoning_content 本身是完整研报 JSON 时直接回收，不二次调用；
 * 4) reasoning_content 只是普通思考文本时才自动关闭思考模式重试；
 * 5) JSON 修复/检索规划使用非思考模式；
 * 6) reasoning token 与可见输出 token 分开统计。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { planWebResearch, planAutonomousResearchRound, generateAiResearchReport } from "../engine/llm-service.js";

const requests=[];
const validReport=()=>JSON.stringify({
  title:"测试股份智能分析",stance:"中性偏多",executive_summary:"多空证据平衡后的测试结论。",evidence_quality:{score:82,reason:"结构化数据完整"},
  sections:{technical:{summary:"趋势略强",details:[],evidence_refs:["technical.factors"]}},
  technical_indicator_review:{coverage:"22/22",family_summaries:[{family:"趋势",summary:"趋势族偏强",key_indicators:["MACD"],evidence_refs:["technical.advancedIndicatorAnalysis.families.trend"]}],notable_signals:[]},
  cross_module_consensus:[{type:"差异",impact:"仅降低置信度",summary:"短中周期存在差异",evidence_refs:["technical.factors"]}],
  key_bull_points:[{text:"趋势证据偏正",evidence_refs:["technical.factors"]}],key_bear_points:[],
  external_research_summary:{used:true,summary:"使用联网补充资料",source_ids:["R1"]},
  watch_conditions:[],invalidation_conditions:[],data_gaps:[],disclaimer:"仅供研究，不构成投资建议。"
});

const server=http.createServer(async (req,res)=>{
  if(req.method!=="POST" || req.url!=="/v1/chat/completions"){res.writeHead(404);res.end();return;}
  let raw=""; for await(const c of req) raw+=c;
  const body=JSON.parse(raw||"{}"); requests.push(body);
  const sys=String(body.messages?.[0]?.content||"");
  const usr=String(body.messages?.[1]?.content||"");

  // 模拟兼容服务不支持 response_format，验证自动降级。
  if(body.response_format){
    res.writeHead(400,{"content-type":"application/json"});
    res.end(JSON.stringify({error:{message:"response_format unsupported"}}));
    return;
  }

  let content="", reasoning_content="";
  let usage={prompt_tokens:321,completion_tokens:123,total_tokens:444,completion_tokens_details:{reasoning_tokens:0}};
  if(sys.includes("自主证券外部研究 Agent")){
    assert.equal(body.thinking?.type,"disabled","Research Agent 规划应关闭 DeepSeek 思考模式");
    content=JSON.stringify({decision:"continue",focus:"自主核验外部变化",reason:"存在外部资料缺口",queries:[{query:"test official policy",purpose:"核验政策",priority:"high",preferred_sources:["official"],freshness_days:30,read_top:1}],remaining_questions:["是否直接影响公司"],stop_reason:""});
  } else if(sys.includes("检索规划器")){
    assert.equal(body.thinking?.type,"disabled","联网检索规划应关闭 DeepSeek 思考模式");
    content=JSON.stringify({focus:"补充近期事实",queries:["测试股份 最新公告","测试行业 最新供需"]});
  } else if(body.thinking?.type==="disabled") {
    content=validReport();
    usage={prompt_tokens:333,completion_tokens:777,total_tokens:1110,completion_tokens_details:{reasoning_tokens:0}};
  } else if(usr.includes("直收股份")) {
    // 复现用户真实档案：完整合法研报 JSON 被服务商放进 reasoning_content，content 为空。
    content="";
    reasoning_content=validReport();
    usage={prompt_tokens:333,completion_tokens:1200,total_tokens:1533,completion_tokens_details:{reasoning_tokens:1200}};
  } else {
    // 普通空正文：reasoning_content 只是思考文本，不是最终研报，必须关闭思考模式重试。
    content="";
    reasoning_content="这里是很长的模型推理，但没有最终可展示 JSON。";
    usage={prompt_tokens:333,completion_tokens:1500,total_tokens:1833,completion_tokens_details:{reasoning_tokens:1500}};
  }
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({model:"deepseek-v4-flash",choices:[{message:{content,reasoning_content},finish_reason:"stop"}],usage}));
});

await new Promise(r=>server.listen(0,"127.0.0.1",r));
try{
  const port=server.address().port;
  const settings={provider:"deepseek",adapter:"openai",endpoint:`http://127.0.0.1:${port}/v1`,model:"deepseek-v4-flash",temperature:.2,deepseekThinkingMode:"low",billingMode:"unknown"};
  const local={meta:{name:"测试股份",code:"sh600000"},overview:{industry:"测试行业"},evidence:{dataGaps:["近期公告"]},news:{general:[]},technical:{factors:[],indicators:[]}};
  const plan=await planWebResearch(local,settings,"dummy");
  assert.equal(plan.plan.queries.length,2);
  const agentPlan=await planAutonomousResearchRound(local,{rounds:[],sources:[],unresolvedQuestions:[]},settings,"dummy",{round:1,maxRounds:3,maxQueriesThisRound:3,remainingQueries:10,remainingPages:12,remainingSources:30,secondsRemaining:90});
  assert.equal(agentPlan.plan.decision,"continue");
  assert.equal(agentPlan.plan.queries.length,1);
  // Case A：完整研报 JSON 被放进 reasoning_content，必须直接回收，不能重复调用模型。
  const directLocal={...local,meta:{name:"直收股份",code:"sh600001"}};
  const directBefore=requests.length;
  const direct=await generateAiResearchReport(directLocal,settings,"dummy");
  const directRequests=requests.slice(directBefore);
  assert.equal(direct.report.stance,"中性偏多");
  assert.equal(direct.parseDiagnostics.reasoningContentPromoted,true);
  assert.equal(direct.parseDiagnostics.emptyContentRecovered,true);
  assert.equal(direct.rawAttempts.length,1,"reasoning 已是完整研报时不应产生第二次逻辑调用");
  assert.equal(direct.usage.inputTokens,333);
  assert.equal(direct.usage.outputTokens,1200);
  assert.ok(directRequests.some(x=>x.thinking?.type==="enabled"));
  assert.ok(!directRequests.some(x=>x.thinking?.type==="disabled"),"reasoning 直收场景不应关闭思考再重试");

  // Case B：reasoning 只是普通思考文本时，仍应关闭思考模式重试。
  const full={...local,externalResearch:{sources:[{id:"R1",title:"测试来源",snippet:"测试摘要",trust:"untrusted_external_text"}]}};
  const result=await generateAiResearchReport(full,settings,"dummy");

  assert.equal(result.report.stance,"中性偏多");
  assert.equal(result.report.technical_indicator_review.coverage,"22/22");
  assert.equal(result.report.cross_module_consensus[0].impact,"仅降低置信度");
  assert.equal(result.parseDiagnostics.emptyContentRecovered,true);
  assert.equal(result.parseDiagnostics.reasoningContentPromoted,false);
  assert.ok(result.parseDiagnostics.primaryReasoningChars>0);
  assert.equal(result.parseDiagnostics.primaryContentChars,0);
  assert.ok((result.usage.reasoningTokens||0)>=1500);
  assert.ok((result.usage.visibleOutputTokens||0)>0);

  assert.ok(requests.some(x=>x.response_format));
  assert.ok(requests.some(x=>!x.response_format));
  assert.ok(requests.some(x=>x.thinking?.type==="enabled" && x.reasoning_effort==="low"),"正式第一次应按设置启用低强度思考");
  assert.ok(requests.some(x=>x.thinking?.type==="disabled"),"空正文后应有非思考模式重试");
  // 所有正式 planner/report 请求都不得设置人为输出上限。
  for(const b of requests){ assert.equal("max_tokens" in b,false); assert.equal("max_completion_tokens" in b,false); }

  console.log(`StockDesk v1.9.2 LLM adapter checks: PASS (${requests.length} mock requests)`);
} finally { server.close(); }
