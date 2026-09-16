/** StockDesk v1.9 本地AI基础设施离线检查：注册表/硬件推荐/影子决策/持久化/sidecar NDJSON。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { MODEL_REGISTRY, recommendAiProfile, decisionFromPrediction, buildAdaptiveAiPlan, latestShadowPrediction, reconcileAiState, saveAiState, loadAiState, appendShadowHistory, loadShadowHistory, defaultAiState } from "../engine/local-ai.js";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
for(const id of ["kronos-mini","kronos-small","kronos-base","master-csi300","master-csi800","qlib-tra"]) assert.ok(MODEL_REGISTRY.some(x=>x.id===id),`missing model ${id}`);
for(const id of ["kronos-mini","kronos-small","kronos-base"]){const m=MODEL_REGISTRY.find(x=>x.id===id);assert.equal(m.license,"MIT");assert.equal(m.openWeights,true);assert.equal(m.role,"financial_kline_forecaster");}
const defaults=defaultAiState();assert.equal(defaults.enabled,false);assert.equal(defaults.mode,"shadow");assert.equal(defaults.autoShadow,false);assert.equal(defaults.adaptiveStrategy,true);assert.equal(defaults.decisionAlerts,true);assert.equal(defaults.maxPredictionAgeMin,120);
const ks=MODEL_REGISTRY.find(x=>x.id==="kronos-small");assert.equal(ks.modelId,"NeoQuasar/Kronos-small");assert.ok(ks.sourceUrl.startsWith("https://github.com/"));
assert.equal(recommendAiProfile({ramGB:8,cpu:{logicalCores:4},gpu:{cudaCapable:false}}).modelId,"kronos-mini");
assert.equal(recommendAiProfile({ramGB:16,cpu:{logicalCores:8},gpu:{cudaCapable:false}}).modelId,"kronos-small");
assert.equal(recommendAiProfile({ramGB:32,cpu:{logicalCores:12},gpu:{cudaCapable:true,vramMB:8192}}).modelId,"kronos-base");
const buy=decisionFromPrediction({positiveProbability:.8,calibratedProbability:.78,medianReturnPct:3,q10ReturnPct:-1,q90ReturnPct:7},{current:{matched:true,values:{risk:30}}});assert.equal(buy.action,"BUY");assert.equal(buy.shadowOnly,true);
const noBuy=decisionFromPrediction({positiveProbability:.8,calibratedProbability:.78,medianReturnPct:3,q10ReturnPct:-1,q90ReturnPct:7},{current:{matched:true,values:{risk:90}}});assert.notEqual(noBuy.action,"BUY","hard high risk must prevent shadow BUY");
const lowSample=decisionFromPrediction({sampleRuns:2,positiveProbability:1,calibratedProbability:1,medianReturnPct:4,q10ReturnPct:2,q90ReturnPct:5},{current:{matched:true,values:{risk:20}}});assert.ok(lowSample.confidence<=52,"two samples must never be presented as high-confidence AI evidence");
const exit=decisionFromPrediction({positiveProbability:.18,calibratedProbability:.15,medianReturnPct:-3,q10ReturnPct:-7,q90ReturnPct:1},{current:{matched:false,values:{risk:70}}});assert.equal(exit.action,"EXIT","EXIT must be checked before the wider REDUCE branch");
const baseConfig={entryScore:20,maxRisk:72,stopLossPct:6,takeProfitPct:16,trailingStopPct:7,maxHoldDays:15};
const prediction={positiveProbability:.8,calibratedProbability:.78,medianReturnPct:3,q10ReturnPct:-1,q90ReturnPct:7,predLen:5,sampleRuns:3,lastClose:10,trajectory:[10.1,10.2,10.3,10.25,10.4],generatedAt:Date.now(),online:{updates:12}};
const plan=buildAdaptiveAiPlan(prediction,{config:baseConfig,current:{matched:true,values:{risk:30}}},{intradayConfirmed:true,maxAgeMin:120});
assert.equal(plan.decision.action,"BUY");assert.equal(plan.phase,"entry");assert.equal(plan.path.length,5);assert.ok(plan.changes.some(x=>x.key==="entryScore"));assert.equal(baseConfig.entryScore,20,"adaptive plan must not mutate baseline config");assert.ok(plan.effectiveUntil>plan.generatedAt);
const dir=mkdtempSync(join(tmpdir(),"stockdesk-ai-"));
try{const st=saveAiState(dir,{enabled:true,modelId:"kronos-small"});assert.equal(loadAiState(dir).enabled,true);appendShadowHistory(dir,{code:"sh600000",generatedAt:Date.now(),decision:{action:"WATCH"}});appendShadowHistory(dir,{code:"sz300221",generatedAt:Date.now(),decision:{action:"BUY"}});assert.equal(loadShadowHistory(dir,10).items[0].code,"sz300221");assert.equal(latestShadowPrediction(dir,"sh600000",60000).row.code,"sh600000");assert.equal(latestShadowPrediction(dir,"sh600000",60000).fresh,true);assert.equal(latestShadowPrediction(dir,"sz000001",60000),null);assert.ok(existsSync(join(dir,"ai-engine","state.json")));const aiHome=join(dir,"ai-engine");const py=process.platform==="win32"?join(aiHome,"venv","Scripts","python.exe"):join(aiHome,"venv","bin","python");mkdirSync(dirname(py),{recursive:true});writeFileSync(py,"");writeFileSync(join(aiHome,"install-manifest.json"),JSON.stringify({models:["kronos-small"]}));const repaired=reconcileAiState(dir,{engineStatus:"error",lastError:"AI进程退出(null)"});assert.equal(repaired.engineStatus,"stopped");assert.equal(repaired.lastError,null);}finally{rmSync(dir,{recursive:true,force:true});}
const pyCandidates=process.platform==="win32"?[["py",["-3"]],["python",[]]]:[["python3",[]],["python",[]]];
let py=null,prefix=[];for(const [c,p] of pyCandidates){const x=spawnSync(c,[...p,"--version"],{encoding:"utf8"});if(x.status===0){py=c;prefix=p;break;}}
if(py){for(const f of ["install.py","service.py","data_provider_bridge.py"]){const r=spawnSync(py,[...prefix,"-m","py_compile",join(root,"python-ai",f)],{encoding:"utf8"});assert.equal(r.status,0,`${f} python syntax fail: ${r.stderr}`);}
  const child=spawn(py,[...prefix,join(root,"python-ai","service.py")],{stdio:["pipe","pipe","pipe"],env:{...process.env,STOCKDESK_AI_HOME:join(tmpdir(),"stockdesk-ai-sidecar-test")}});let out="";child.stdout.setEncoding("utf8");child.stdout.on("data",x=>out+=x);child.stdin.write(JSON.stringify({id:"ping1",action:"ping"})+"\n");await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("sidecar ping timeout")),5000);const tick=()=>{if(out.includes('"pong": true')||out.includes('"pong":true')){clearTimeout(t);resolve();}else setTimeout(tick,20)};tick();});child.stdin.write(JSON.stringify({id:"bye",action:"shutdown"})+"\n");await new Promise(resolve=>child.once("exit",resolve));}
console.log("StockDesk v1.9.2 local AI checks: PASS");
