/** StockDesk v1.9.2 自主外部研究 Agent 状态机测试（完全离线，不访问公网）。 */
import assert from "node:assert/strict";
import { runAutonomousResearchAgent, RESEARCH_MODES } from "../engine/research-agent.js";

const plans=[];
async function planRound(_report,ledger,_settings,_key,budget){
  plans.push({round:budget.round,sourceCount:ledger.sources.length});
  if(budget.round===1){
    return {parseOk:true,parseMode:"direct",rawAttempt:{label:"mock_plan_1",text:'{"decision":"continue"}',usage:{inputTokens:10,outputTokens:5,totalTokens:15}},plan:{
      decision:"continue",focus:"确认海外政策与同行经营变化",reason:"本地数据缺少近期外部事件",queries:[
        {query:"company official latest project policy",purpose:"核验项目政策",priority:"high",preferred_sources:["official"],read_top:1},
        {query:"global peer latest guidance",purpose:"核验海外同行经营指引",priority:"medium",preferred_sources:["company_ir","major_media"],read_top:1},
      ],remaining_questions:["政策是否直接影响公司项目"],stop_reason:""
    }};
  }
  assert.ok(ledger.sources.length>=2,"第二轮规划必须看到第一轮资料");
  return {parseOk:true,parseMode:"direct",rawAttempt:{label:"mock_plan_2",text:'{"decision":"stop"}',usage:{inputTokens:12,outputTokens:4,totalTokens:16}},plan:{decision:"stop",focus:"证据复核",reason:"关键事实已有两个独立来源",queries:[],remaining_questions:[],stop_reason:"新增搜索的信息增益较低"}};
}

async function runQueries(queries,opts){
  assert.equal(queries.length,2);
  assert.ok(queries.every((q)=>q.query.includes("测试股份")&&q.query.includes("600000")),"研究查询必须锚定当前企业名称和代码");
  assert.equal(opts.companyScope?.name,"测试股份");
  return {
    sources:[
      {id:"R1",query:queries[0].query,purpose:queries[0].purpose,title:"Official policy update",url:"https://example.gov/policy",domain:"example.gov",sourceGrade:"A",sourceCategory:"official_or_primary",sourceLabel:"一手/官方来源",snippet:"policy fact",page:"full official text",trust:"untrusted_external_text"},
      {id:"R2",query:queries[1].query,purpose:queries[1].purpose,title:"Peer guidance",url:"https://example.com/ir",domain:"example.com",sourceGrade:"A",sourceCategory:"official_or_primary",sourceLabel:"一手/官方来源",snippet:"peer guidance",page:null,trust:"untrusted_external_text"},
    ],queryLog:queries.map((q,i)=>({query:q.query,purpose:q.purpose,resultCount:1,sourceIds:[`R${i+1}`]})),rejected:[],pagesRead:1,nextSeq:3,
  };
}

const report={meta:{code:"sh600000",name:"测试股份"},overview:{industry:"测试行业"},evidence:{dataGaps:["海外政策影响未知"]},globalContext:{assets:[]}};
const result=await runAutonomousResearchAgent(report,{researchMode:"standard",researchAllowPageRead:true},"dummy",{planRound,runQueries});
assert.equal(result.status,"completed");
assert.equal(result.rounds.length,2);
assert.equal(result.sources.length,2);
assert.equal(result.usage.queries,2);
assert.equal(result.usage.pages,1);
assert.match(result.stopReason,/信息增益/);
assert.equal(result.rawAttempts.length,2);
assert.equal(result.modelUsage.inputTokens,22);
assert.equal(plans.length,2);
assert.equal(RESEARCH_MODES.standard.maxRounds,3);
console.log("StockDesk v1.9.2 research agent checks: PASS");
