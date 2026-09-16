import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { analyzeDaily, analyzeSignals } from "../engine/indicators.js";
import { analyzeTrendHorizons } from "../engine/trend-horizons.js";
import { createSignalService } from "../engine/signal-service.js";

function candles(step, count=160) {
  let p=100;
  return Array.from({length:count},(_,i)=>{const o=p;p*=typeof step === "function" ? step(i) : step;return {time:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),open:o,close:p,high:Math.max(o,p)*1.01,low:Math.min(o,p)*.99,volume:1000};});
}
for (const [step, direction] of [[1,"neutral"],[1.01,"bullish"],[.99,"bearish"]]) {
  const bars=candles(step), sig=analyzeSignals(analyzeDaily(bars));
  assert.equal(sig.direction,direction);
  assert.equal(sig.verdict,direction==="bullish"?"buy":direction==="bearish"?"sell":"hold");
  for(const h of analyzeTrendHorizons(bars)) assert.equal(h.direction,direction);
  if(step===1) assert.equal(sig.score,0);
}
const mixed=analyzeTrendHorizons(candles(i=>i<150?.99:1.03));
assert.equal(mixed[0].direction,"bullish");
assert.equal(mixed[2].direction,"bearish");
assert.equal(analyzeTrendHorizons(candles(1.01,40))[2].status,"insufficient");
const invalid=candles(1);invalid[159].close=null;
assert.ok(analyzeTrendHorizons(invalid).every(h=>h.status==="insufficient"));
const strong=analyzeSignals(analyzeDaily(candles(1.02)));
assert.ok(strong.score>0);
assert.ok(strong.signals.filter(s=>s.label==="风险偏高").every(s=>s.type==="info" && s.weight===0));

let at=0, calls=0, stale=false, release;
let gate=null;
const service=createSignalService({
  now:()=>at,
  getKline:async(code,period,count,opts)=>{calls++;assert.equal(opts.force,true);assert.equal(count,750);if(gate)await gate;return {candles:candles(code==="down"?.99:1.01),stale};},
  getMinute:async(code,opts)=>{assert.equal(opts.force,true);return {points:[],changePercent:10};},
});
const first=await service.get("up");assert.equal(first.daily.horizons.length,3);assert.ok(first.asOf);assert.equal(calls,1);
assert.equal((await service.get("up")).cached,true);assert.equal(calls,1);
await service.get("up",true);assert.equal(calls,2);
at=61000;await service.get("up");assert.equal(calls,3);
assert.equal((await service.get("down")).daily.verdict,"sell");
gate=new Promise(r=>release=r);const start=calls;
const one=service.get("parallel",true),two=service.get("parallel",true);
release();await Promise.all([one,two]);gate=null;assert.equal(calls,start+1);
stale=true;const cached=await service.get("stale");assert.equal(cached.stale,true);assert.ok(cached.dataWarning);
const before=calls;await service.get("stale");assert.equal(calls,before+1);
service.clear();stale=false;const after=calls;await service.get("up");assert.equal(calls,after+1);
// 实际渲染函数：三个周期、时间、缺失提示、强制刷新按钮。
const source=readFileSync(new URL("../renderer/app.js",import.meta.url),"utf8");
const panel=source.slice(source.indexOf("function renderSignalPanel(sig)"),source.indexOf("// ================= 选股面板"));
const nodes=new Map();let forced=false;
runInNewContext(`${panel}; renderSignalPanel(sig);`,{
  sig:first, state:{marketRegime:null}, esc:s=>String(s??""), pctCls:()=>"",loadSignal:f=>forced=f,
  $:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},
});
const html=nodes.get("#panel-body").innerHTML;
for(const label of ["短期趋势","中期趋势","长期趋势","日K截至","不决定上方方向","独立口径"]) assert.ok(html.includes(label));
nodes.get("#sig-refresh").onclick();assert.equal(forced,true);
const young=await createSignalService({getKline:async()=>({candles:candles(1.01,20)}),getMinute:async()=>({points:[]})}).get("young");
assert.equal(young.daily,null);assert.equal(young.horizons[0].status,"ok");assert.equal(young.horizons[2].status,"insufficient");
runInNewContext(`${panel}; renderSignalPanel(sig);`,{sig:young,state:{},esc:s=>String(s??""),pctCls:()=>"",loadSignal:()=>{},$:id=>nodes.get(id)});
assert.ok(nodes.get("#panel-body").innerHTML.includes("数据不足"));
assert.ok(!nodes.get("#panel-body").innerHTML.includes("undefined"));
// 切股期间旧请求不得覆盖新股票；静默刷新不能重复发请求。
const loader=source.slice(source.indexOf("let signalLoadToken = 0"),source.indexOf("function renderSignalStrip"));
const pending=[],drawn=[];const state={activeCode:"A",panel:"signal"};
const load=runInNewContext(`${loader}; loadSignal`,{
  state, $:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},
  api:{getSignal:(code,force)=>new Promise(resolve=>pending.push({code,force,resolve}))},
  renderSignalStrip:s=>drawn.push(s.code),renderSignalPanel:()=>{},updateConnectionStatus:()=>{},esc:String,
});
const oldRequest=load();state.activeCode="B";const newRequest=load(true);
await load(false,true);assert.equal(pending.length,2);assert.equal(pending[1].force,true);
pending[1].resolve({code:"B"});await newRequest;pending[0].resolve({code:"A"});await oldRequest;
assert.deepEqual(drawn,["B"]);
console.log("signal-trends-check: PASS (flat/up/down/mixed/insufficient, freshness, force, coalescing, stale)");
