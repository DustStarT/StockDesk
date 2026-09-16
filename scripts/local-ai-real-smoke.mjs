/** Optional real-network + installed-Kronos smoke test. Not part of the offline release gate. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureDataSources, DEFAULT_DATA_SOURCE_CONFIG, getKline } from "../engine/data-provider-hub.js";
import { buildAdaptiveAiPlan, enginePython, readInstallManifest } from "../engine/local-ai.js";
import { runStrategyLab } from "../engine/strategy-lab.js";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir=join(homedir(),".stockdesk");
const aiHome=join(dataDir,"ai-engine");
const python=enginePython(dataDir);
const manifest=readInstallManifest(dataDir);
if(!python||!(manifest.models||[]).includes("kronos-small")){
  console.log("StockDesk v1.9.2 real local AI smoke: SKIPPED | kronos-small not installed");
  process.exit(0);
}

configureDataSources(DEFAULT_DATA_SOURCE_CONFIG);
const market=await getKline("sz300221","day",360,{force:true});
assert.ok(market.candles.length>=100,"insufficient real K-line history");
const candles=market.candles;
const strategy=runStrategyLab(candles,{mode:"smart",profile:"balanced"},{scan:false});
assert.equal(strategy.status,"ok");

const child=spawn(python,[join(root,"python-ai","service.py")],{
  windowsHide:true,stdio:["pipe","pipe","pipe"],
  env:{...process.env,STOCKDESK_AI_HOME:aiHome,PYTHONUNBUFFERED:"1"},
});
let buffer="",seq=0;
const pending=new Map();
child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
child.stdout.on("data",(chunk)=>{
  buffer+=chunk;let index;
  while((index=buffer.indexOf("\n"))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    let row;try{row=JSON.parse(line);}catch{continue;}
    const waiter=pending.get(row.id);if(!waiter)continue;
    pending.delete(row.id);clearTimeout(waiter.timer);
    row.ok?waiter.resolve(row.result):waiter.reject(new Error(row.error||"AI request failed"));
  }
});
function request(payload,timeoutMs=240000){
  const id=`smoke_${++seq}`;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`AI smoke timeout: ${payload.action}`));},timeoutMs);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({id,...payload})+"\n");
  });
}

const startedAt=Date.now();
try{
  const status=await request({action:"status"},30000);
  assert.ok((status.models||[]).includes("kronos-small"));
  const prediction=await request({
    action:"predict",code:"sz300221",modelId:"kronos-small",
    candles:candles.map(x=>({...x,amount:Number(x.amount)||Number(x.volume||0)*((Number(x.open)+Number(x.close))/2||0)})),
    predLen:5,sampleRuns:2,onlineHorizonMin:30,
    extra:{strategyScore:strategy.current?.values?.score??null,risk:strategy.current?.values?.risk??null},
  });
  assert.equal(prediction.trajectory.length,5);
  assert.ok(Number.isFinite(prediction.calibratedProbability));
  const plan=buildAdaptiveAiPlan(prediction,strategy,{maxAgeMin:120,intradayConfirmed:false});
  assert.ok(plan.decision?.action);assert.equal(plan.path.length,5);assert.ok(plan.effectiveUntil>plan.generatedAt);
  console.log(JSON.stringify({
    result:"PASS",elapsedMs:Date.now()-startedAt,provider:market.provider,
    action:plan.decision.action,confidence:plan.decision.confidence,
    probability:prediction.calibratedProbability,medianReturnPct:prediction.medianReturnPct,
    changes:plan.changes.map(x=>`${x.label}:${x.from}->${x.to}`),path:plan.path.map(x=>x.returnPct),
  }));
}finally{
  try{await request({action:"shutdown"},3000);}catch{}
  if(!child.killed)child.kill();
}
