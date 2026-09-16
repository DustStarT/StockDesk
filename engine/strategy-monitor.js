/**
 * StockDesk v1.6 · 策略实时监控纯逻辑层
 * 不负责网络和系统通知，只把当前行情/日线/策略配置转换为可持久化的监控状态。
 */
import { analyzeDaily, analyzeSignals, computeTiming } from "./indicators.js";
import { normalizeStrategyConfig } from "./strategy-lab.js";

const finite=(v)=>typeof v==="number"&&Number.isFinite(v);
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const round=(v,d=2)=>finite(v)?Number(v.toFixed(d)):null;

function factor(sig,key,fallback=0){
  const f=sig?.factors?.find((x)=>x.key===key);
  return finite(f?.score)?f.score:fallback;
}

function pushCondition(rows,label,pass,value=null,threshold=null,kind="min"){
  rows.push({label,pass:!!pass,value:finite(value)?round(value,2):value,threshold:finite(threshold)?round(threshold,2):threshold,kind});
}

/** 当前一根日线下的入场条件，供实时监控和策略实验室 UI 共用。 */
export function evaluateEntryConditions(daily,signal,inputConfig={}){
  const cfg=normalizeStrategyConfig(inputConfig);
  if(!daily||!signal) return {matched:false,completion:0,failed:["数据不足"],conditions:[],values:{}};
  const trend=factor(signal,"trend"), momentum=factor(signal,"momentum"), volume=factor(signal,"volume"), risk=factor(signal,"risk",100);
  const rows=[];
  pushCondition(rows,"综合分",signal.score>=cfg.entryScore,signal.score,cfg.entryScore,"min");
  pushCondition(rows,"趋势",trend>=cfg.minTrend,trend,cfg.minTrend,"min");
  pushCondition(rows,"动量",momentum>=cfg.minMomentum,momentum,cfg.minMomentum,"min");
  pushCondition(rows,"量价",volume>=cfg.minVolume,volume,cfg.minVolume,"min");
  pushCondition(rows,"风险",risk<=cfg.maxRisk,risk,cfg.maxRisk,"max");
  if(cfg.requireAboveMa20) pushCondition(rows,"站上MA20",finite(daily.close)&&finite(daily.ma20)&&daily.close>daily.ma20,daily.pctFromMa20,0,"min");
  if(cfg.minVolRatio>0) pushCondition(rows,"量比",finite(daily.volRatio)&&daily.volRatio>=cfg.minVolRatio,daily.volRatio,cfg.minVolRatio,"min");
  if(cfg.breakoutWithinPct!=null) pushCondition(rows,"接近20日高点",finite(daily.pctFrom20dHigh)&&daily.pctFrom20dHigh>=cfg.breakoutWithinPct,daily.pctFrom20dHigh,cfg.breakoutWithinPct,"min");
  if(cfg.ma20MinPct!=null) pushCondition(rows,"回踩区间下沿",finite(daily.pctFromMa20)&&daily.pctFromMa20>=cfg.ma20MinPct,daily.pctFromMa20,cfg.ma20MinPct,"min");
  if(cfg.ma20MaxPct!=null) pushCondition(rows,"回踩区间上沿",finite(daily.pctFromMa20)&&daily.pctFromMa20<=cfg.ma20MaxPct,daily.pctFromMa20,cfg.ma20MaxPct,"max");
  if(cfg.rsiMin!=null) pushCondition(rows,"RSI下限",finite(daily.rsi)&&daily.rsi>=cfg.rsiMin,daily.rsi,cfg.rsiMin,"min");
  if(cfg.rsiMax!=null) pushCondition(rows,"RSI上限",finite(daily.rsi)&&daily.rsi<=cfg.rsiMax,daily.rsi,cfg.rsiMax,"max");
  if(cfg.minRet20!=null) pushCondition(rows,"20日收益",finite(daily.ret20)&&daily.ret20>=cfg.minRet20,daily.ret20,cfg.minRet20,"min");
  const passed=rows.filter((x)=>x.pass).length;
  const completion=rows.length?Math.round(passed/rows.length*100):0;
  return {
    matched:rows.length>0&&passed===rows.length,
    completion,
    failed:rows.filter((x)=>!x.pass).map((x)=>x.label),
    conditions:rows,
    values:{score:round(signal.score,1),trend:round(trend,1),momentum:round(momentum,1),volume:round(volume,1),risk:round(risk,1)},
  };
}

export function evaluateCurrentStrategy(candles,inputConfig={}){
  const cfg=normalizeStrategyConfig(inputConfig);
  if(!Array.isArray(candles)||candles.length<60) return {status:"insufficient",config:cfg,entry:{matched:false,completion:0,failed:["历史数据不足"],conditions:[]},factorExit:false};
  const daily=analyzeDaily(candles);
  const signal=analyzeSignals(daily);
  const entry=evaluateEntryConditions(daily,signal,cfg);
  const trend=factor(signal,"trend");
  const factorExit=!!signal&&(signal.score<=cfg.exitScore||trend<=Math.min(-10,cfg.minTrend*-0.45));
  return {
    status:"ok",config:cfg,entry,factorExit,
    daily:{close:daily?.close,ma20:daily?.ma20,rsi:daily?.rsi,volRatio:daily?.volRatio,ret20:daily?.ret20,pctFrom20dHigh:daily?.pctFrom20dHigh,pctFromMa20:daily?.pctFromMa20,atr14Pct:daily?.atr14Pct},
    signal:{score:signal?.score,direction:signal?.direction,verdict:signal?.verdict,summary:signal?.summary,factors:signal?.factors||[]},
  };
}

export function normalizeMonitorConfig(input={}){
  const types=input.notifyTypes&&typeof input.notifyTypes==="object"?input.notifyTypes:{};
  return {
    enabled:input.enabled!==false,
    profile:["conservative","balanced","aggressive","manual"].includes(String(input.profile||""))?String(input.profile):"balanced",
    mode:["manual","ai"].includes(input.mode)?input.mode:"smart",
    strategyName:String(input.strategyName||"策略监控").slice(0,80),
    config:normalizeStrategyConfig(input.config||{}),
    aiAssist:input.aiAssist===true,
    aiAdaptive:input.aiAdaptive!==false,
    aiMinConfidence:clamp(Math.round(Number(input.aiMinConfidence)||55),40,95),
    aiMaxAgeMin:clamp(Math.round(Number(input.aiMaxAgeMin)||120),15,1440),
    nearEntryPct:clamp(Math.round(Number(input.nearEntryPct)||80),50,100),
    confirmIntraday:input.confirmIntraday!==false,
    autoPaperPosition:input.autoPaperPosition!==false,
    notifyTypes:{
      nearEntry:types.nearEntry!==false,
      entry:types.entry!==false,
      risk:types.risk!==false,
      exit:types.exit!==false,
      event:types.event===true,
      ai:types.ai!==false,
    },
    position:normalizePosition(input.position),
    createdAt:Number(input.createdAt)||Date.now(),
    updatedAt:Number(input.updatedAt)||Date.now(),
  };
}

export function normalizePosition(p){
  if(!p||typeof p!=="object") return null;
  const entryPrice=Number(p.entryPrice);
  if(!(entryPrice>0)) return null;
  return {
    kind:p.kind==="actual"?"actual":"paper",
    entryPrice:round(entryPrice,3),
    entryDate:String(p.entryDate||new Date().toISOString().slice(0,10)),
    highestPrice:round(Math.max(entryPrice,Number(p.highestPrice)||entryPrice),3),
    createdAt:Number(p.createdAt)||Date.now(),
  };
}

function intradayConfirmed(timing){
  if(!timing) return false;
  if(timing.type==="buy") return true;
  const h=String(timing.hint||"");
  return /沿均价上方上行|站上均价走强/.test(h);
}

function holdingDays(candles,entryDate){
  if(!entryDate||!Array.isArray(candles)) return null;
  const xs=candles.filter((x)=>String(x?.time||"")>=String(entryDate));
  return xs.length||null;
}

/**
 * 生成实时监控快照。stage: idle | near_entry | entry_ready | entry | holding | risk | exit
 */
export function evaluateMonitorSnapshot({candles,quote=null,minute=null,monitor={},previous=null}={}){
  const spec=normalizeMonitorConfig(monitor);
  const current=evaluateCurrentStrategy(candles,spec.config);
  const price=Number(quote?.price??minute?.price??current.daily?.close);
  const timing=computeTiming({points:minute?.points||[],prevClose:minute?.prevClose,price,direction:current.signal?.direction||"neutral"});
  if(current.status!=="ok"||!(price>0)) return {status:"insufficient",stage:"idle",price:finite(price)?price:null,current,timing,position:spec.position};

  const risk=Number(current.entry?.values?.risk);
  const eventFlags={
    high20:finite(current.daily?.pctFrom20dHigh)&&current.daily.pctFrom20dHigh>=-0.5,
    highVolume:finite(current.daily?.volRatio)&&current.daily.volRatio>=2,
    highVolatility:finite(current.daily?.atr14Pct)&&current.daily.atr14Pct>=5,
  };

  let position=spec.position?{...spec.position}:null;
  if(position) position.highestPrice=round(Math.max(position.highestPrice||position.entryPrice,price),3);
  let stage="idle", action="继续观察", levels=null, reason="";

  if(position){
    const cfg=spec.config;
    const stop=cfg.stopLossPct>0?position.entryPrice*(1-cfg.stopLossPct/100):null;
    const trailing=cfg.trailingStopPct>0?position.highestPrice*(1-cfg.trailingStopPct/100):null;
    const stopLine=[stop,trailing].filter(finite).length?Math.max(...[stop,trailing].filter(finite)):null;
    const take=cfg.takeProfitPct>0?position.entryPrice*(1+cfg.takeProfitPct/100):null;
    const days=holdingDays(candles,position.entryDate);
    levels={stop:round(stop,3),trailing:round(trailing,3),effectiveStop:round(stopLine,3),take:round(take,3),holdingDays:days};
    if(finite(stopLine)&&price<=stopLine){stage="exit";action="退出触发";reason=trailing>=stop?"移动止损触发":"止损触发";}
    else if(finite(take)&&price>=take){stage="exit";action="止盈触发";reason="达到止盈目标";}
    else if(finite(days)&&days>=cfg.maxHoldDays){stage="exit";action="退出触发";reason="达到最长持有期";}
    else if(current.factorExit){stage="risk";action="减仓/退出预警";reason="策略因子转弱";}
    else if(finite(risk)&&risk>cfg.maxRisk){stage="risk";action="风险预警";reason=`风险 ${round(risk,1)} 高于策略上限 ${cfg.maxRisk}`;}
    else {stage="holding";action="持仓跟踪";reason="尚未触发退出条件";}
  }else{
    const confirmed=!spec.confirmIntraday||intradayConfirmed(timing)||!Array.isArray(minute?.points)||minute.points.length<5;
    if(current.entry.matched&&confirmed){stage="entry";action="正式买点";reason=timing?.hint||"策略条件全部满足";}
    else if(current.entry.matched){stage="entry_ready";action="等待分时确认";reason=timing?.hint||"日线条件已满足";}
    else if(current.entry.completion>=spec.nearEntryPct){stage="near_entry";action="接近买点";reason=`入场条件完成 ${current.entry.completion}%`+ (current.entry.failed?.length?`，待满足：${current.entry.failed.slice(0,3).join("、")}`:"");}
  }

  const completion=current.entry?.completion??0;
  const change={
    stageChanged:stage!==previous?.stage,
    riskCrossed:finite(risk)&&risk>spec.config.maxRisk&&!(finite(previous?.risk)&&previous.risk>spec.config.maxRisk),
    eventChanged:Object.entries(eventFlags).some(([k,v])=>v&&!previous?.eventFlags?.[k]),
  };
  return {status:"ok",stage,action,reason,price:round(price,3),risk:finite(risk)?round(risk,1):null,completion,current,timing,position,levels,eventFlags,change,checkedAt:Date.now()};
}

/** 中国A股常规连续竞价时间（节假日需由行情是否更新进一步确认）。 */
export function chinaTradingSession(date=new Date()){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(date);
  const obj=Object.fromEntries(parts.map((x)=>[x.type,x.value]));
  const weekday=obj.weekday;
  const mins=Number(obj.hour)*60+Number(obj.minute);
  const workday=!['Sat','Sun'].includes(weekday);
  const morning=mins>=570&&mins<=690; // 09:30-11:30
  const afternoon=mins>=780&&mins<=900; // 13:00-15:00
  return {open:workday&&(morning||afternoon),workday,session:morning?"morning":afternoon?"afternoon":"closed",beijingMinute:mins};
}
