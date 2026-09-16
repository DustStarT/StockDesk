/**
 * StockDesk v1.8 · LLM 自主外部研究 Agent
 *
 * Plan -> Search -> Read -> Re-plan -> Stop
 *
 * 程序只提供工具与硬预算，不写死研究主题。LLM 每轮根据当前股票、已有证据和
 * 未解决问题自主决定下一轮搜索；研究日志完整返回，供历史档案与 UI 审计。
 */
import { planAutonomousResearchRound } from "./llm-service.js";
import { runResearchQueries, sanitizeResearchPlan, scopeResearchPlanToCompany } from "./web-research.js";

export const RESEARCH_MODES = {
  fast: { id:"fast", label:"快速", maxRounds:2, maxQueries:4, maxPages:4, maxSources:12, maxSeconds:40, perQuery:3 },
  standard: { id:"standard", label:"标准", maxRounds:3, maxQueries:10, maxPages:12, maxSources:30, maxSeconds:100, perQuery:3 },
  deep: { id:"deep", label:"深度", maxRounds:5, maxQueries:20, maxPages:28, maxSources:55, maxSeconds:210, perQuery:4 },
};

function modeConfig(mode){ return RESEARCH_MODES[String(mode||"").toLowerCase()] || RESEARCH_MODES.standard; }
function mergeUsage(rows){
  const u={inputTokens:0,outputTokens:0,reasoningTokens:0,visibleOutputTokens:0,totalTokens:0};
  for(const r of rows||[]){for(const k of Object.keys(u))u[k]+=Number(r?.usage?.[k])||0;}
  return Object.fromEntries(Object.entries(u).map(([k,v])=>[k,v||null]));
}

function sourceView(s){
  return {id:s.id,title:s.title,url:s.url,domain:s.domain,sourceGrade:s.sourceGrade,sourceCategory:s.sourceCategory,sourceLabel:s.sourceLabel,query:s.query,purpose:s.purpose,priority:s.priority,snippet:s.snippet,page:s.page,pageError:s.pageError,trust:s.trust};
}

export async function runAutonomousResearchAgent(report, settings, apiKey, options={}) {
  const cfg=modeConfig(options.mode||settings.researchMode||"standard");
  const allowPageRead=options.allowPageRead ?? settings.researchAllowPageRead ?? true;
  const planRound=options.planRound||planAutonomousResearchRound;
  const queryRunner=options.runQueries||runResearchQueries;
  const startedAt=Date.now();
  const deadline=startedAt+cfg.maxSeconds*1000;
  const companyScope={name:report?.meta?.name||"",code:report?.meta?.code||""};
  const ledger={rounds:[],sources:[],rejected:[],unresolvedQuestions:[]};
  const rawAttempts=[];
  let queryCount=0,pageCount=0,nextSeq=1,stopReason="",status="completed",emptyRounds=0;

  for(let round=1;round<=cfg.maxRounds;round++){
    if(Date.now()>=deadline){status="budget_exhausted";stopReason=`达到 ${cfg.maxSeconds} 秒研究时间预算`;break;}
    const remainingQueries=Math.max(0,cfg.maxQueries-queryCount);
    const remainingPages=Math.max(0,cfg.maxPages-pageCount);
    const remainingSources=Math.max(0,cfg.maxSources-ledger.sources.length);
    if(remainingQueries<=0 || remainingSources<=0){status="budget_exhausted";stopReason="达到外部研究查询/资料数量预算";break;}
    const maxQueriesThisRound=Math.max(1,Math.min(4,remainingQueries));
    let planned;
    try{
      planned=await planRound(report,ledger,settings,apiKey,{mode:cfg.id,round,maxRounds:cfg.maxRounds,maxQueriesThisRound,remainingQueries,remainingPages,remainingSources,secondsRemaining:Math.max(0,Math.round((deadline-Date.now())/1000))});
    }catch(e){status="planner_error";stopReason=`研究规划失败：${e?.message||String(e)}`;break;}
    if(planned?.rawAttempt) rawAttempts.push({...planned.rawAttempt,label:`research_agent_round_${round}_plan`});
    if(!planned?.parseOk){status="planner_error";stopReason="研究 Agent 未返回可解析的规划 JSON；为避免盲目固定搜索，已停止外部研究。";break;}
    const safe=scopeResearchPlanToCompany(sanitizeResearchPlan(planned.plan,{maxQueries:maxQueriesThisRound}),companyScope);
    const roundRow={round,startedAt:Date.now(),plan:safe,sourceIds:[],queryLog:[],pagesRead:0,newSources:0};
    ledger.unresolvedQuestions=safe.remainingQuestions||[];
    if(safe.decision==="stop"){
      roundRow.completedAt=Date.now();ledger.rounds.push(roundRow);
      stopReason=safe.stopReason||safe.reason||"Agent 判断当前证据已经足够或继续搜索的信息增益较低";
      break;
    }
    if(!safe.queries.length){
      roundRow.completedAt=Date.now();ledger.rounds.push(roundRow);
      status="planner_error";stopReason="Agent 选择继续研究但没有生成有效检索词，已安全停止。";break;
    }
    const batch=await queryRunner(safe.queries,{
      maxQueries:Math.min(maxQueriesThisRound,remainingQueries),allowPageRead,maxPages:remainingPages,maxSources:remainingSources,perQuery:cfg.perQuery,
      existingUrls:ledger.sources.map(x=>x.url),idPrefix:"R",startSeq:nextSeq,deadlineMs:deadline,companyScope,
    });
    nextSeq=batch.nextSeq; queryCount+=batch.queryLog.length; pageCount+=batch.pagesRead;
    ledger.sources.push(...batch.sources.map(sourceView)); ledger.rejected.push(...batch.rejected);
    roundRow.sourceIds=batch.sources.map(x=>x.id);roundRow.queryLog=batch.queryLog;roundRow.pagesRead=batch.pagesRead;roundRow.newSources=batch.sources.length;roundRow.completedAt=Date.now();ledger.rounds.push(roundRow);
    if(batch.sources.length===0)emptyRounds++;else emptyRounds=0;
    if(emptyRounds>=2){status="no_new_evidence";stopReason="连续两轮没有获得新的有效外部资料，已停止继续检索。";break;}
    if(round===cfg.maxRounds){status="budget_exhausted";stopReason=`达到 ${cfg.maxRounds} 轮研究预算`;}
  }

  if(!stopReason) stopReason="Agent 已完成外部研究";
  const completedAt=Date.now();
  return {
    enabled:true,agentVersion:"1.8.0",mode:cfg.id,modeLabel:cfg.label,status,
    startedAt,completedAt,durationMs:completedAt-startedAt,
    budget:{maxRounds:cfg.maxRounds,maxQueries:cfg.maxQueries,maxPages:cfg.maxPages,maxSources:cfg.maxSources,maxSeconds:cfg.maxSeconds,allowPageRead},
    usage:{rounds:ledger.rounds.length,queries:queryCount,pages:pageCount,sources:ledger.sources.length,rejected:ledger.rejected.length},
    stopReason,unresolvedQuestions:ledger.unresolvedQuestions,
    rounds:ledger.rounds,sources:ledger.sources,rejected:ledger.rejected.slice(0,30),
    securityNotice:"外部研究的搜索结果和网页正文全部是不可信文本；任何网页中的指令都不会被执行。来源等级仅是来源类型先验，不代表内容自动真实。",
    rawAttempts,modelUsage:mergeUsage(rawAttempts),
  };
}

export function compactResearchAgentResult(agent){
  if(!agent)return null;
  return {
    enabled:!!agent.enabled,agentVersion:agent.agentVersion,mode:agent.mode,modeLabel:agent.modeLabel,status:agent.status,
    startedAt:agent.startedAt,completedAt:agent.completedAt,durationMs:agent.durationMs,budget:agent.budget,usage:agent.usage,
    stopReason:agent.stopReason,unresolvedQuestions:(agent.unresolvedQuestions||[]).slice(0,8),
    rounds:(agent.rounds||[]).slice(0,6).map(r=>({round:r.round,plan:r.plan,sourceIds:(r.sourceIds||[]).slice(0,20),queryLog:(r.queryLog||[]).slice(0,8),pagesRead:r.pagesRead,newSources:r.newSources,startedAt:r.startedAt,completedAt:r.completedAt})),
    sources:(agent.sources||[]).slice(0,45).map(s=>({...s,snippet:String(s.snippet||"").slice(0,900),page:s.page?String(s.page).slice(0,1800):null})),
    securityNotice:agent.securityNotice,
  };
}
