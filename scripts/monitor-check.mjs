/** StockDesk v1.9.2 策略监控纯逻辑测试：状态机、持仓退出、交易时段。 */
import assert from "node:assert/strict";
import { evaluateMonitorSnapshot, normalizeMonitorConfig, chinaTradingSession } from "../engine/strategy-monitor.js";

const candles=Array.from({length:240},(_,i)=>{const c=10+i*.04;return{time:`2026-${String(1+Math.floor(i/28)).padStart(2,"0")}-${String(1+i%28).padStart(2,"0")}`,open:c-.02,high:c+.12,low:c-.10,close:c,volume:100000+i*1000};});
const permissive={presetId:"trend_breakout",entryScore:-20,minTrend:-100,minMomentum:-100,minVolume:-100,maxRisk:100,minVolRatio:0,breakoutWithinPct:-30,requireAboveMa20:false,stopLossPct:6,takeProfitPct:16,trailingStopPct:8,maxHoldDays:20};
const base=normalizeMonitorConfig({config:permissive,confirmIntraday:false,autoPaperPosition:true});
const aiMonitor=normalizeMonitorConfig({mode:"ai",config:permissive,aiAssist:true,aiAdaptive:true,aiMinConfidence:65,aiMaxAgeMin:60,notifyTypes:{ai:true}});
assert.equal(aiMonitor.mode,"ai");assert.equal(aiMonitor.aiAssist,true);assert.equal(aiMonitor.aiAdaptive,true);assert.equal(aiMonitor.aiMinConfidence,65);assert.equal(aiMonitor.aiMaxAgeMin,60);assert.equal(aiMonitor.notifyTypes.ai,true);
let snap=evaluateMonitorSnapshot({candles,quote:{price:candles.at(-1).close},minute:{points:[]},monitor:base,previous:{stage:"idle"}});
assert.equal(snap.status,"ok");
assert.equal(snap.stage,"entry");
assert.equal(snap.completion,100);
assert.ok(snap.change.stageChanged);

// 未全部满足但达到阈值时进入接近买点。
const near=normalizeMonitorConfig({config:{...permissive,minMomentum:99},nearEntryPct:80,confirmIntraday:false});
snap=evaluateMonitorSnapshot({candles,quote:{price:candles.at(-1).close},minute:{points:[]},monitor:near,previous:{stage:"idle"}});
assert.equal(snap.stage,"near_entry");
assert.ok(snap.completion>=80&&snap.completion<100);

// 持仓达到止损线时必须进入退出状态，并提供动态止损价。
const holding=normalizeMonitorConfig({config:permissive,position:{kind:"actual",entryPrice:20,entryDate:"2026-08-01",highestPrice:21}});
snap=evaluateMonitorSnapshot({candles,quote:{price:18.5},minute:{points:[]},monitor:holding,previous:{stage:"holding"}});
assert.equal(snap.stage,"exit");
assert.ok(/止损/.test(snap.reason));
assert.ok(Number.isFinite(snap.levels.effectiveStop));

// 正常持仓时最高价应向上更新，供移动止损使用。
snap=evaluateMonitorSnapshot({candles,quote:{price:21.5},minute:{points:[]},monitor:holding,previous:{stage:"holding"}});
assert.ok(snap.position.highestPrice>=21.5);
assert.ok(snap.levels.trailing>0);

// 北京时间周一10:00开盘，12:00午休。
assert.equal(chinaTradingSession(new Date("2026-08-31T02:00:00Z")).open,true);
assert.equal(chinaTradingSession(new Date("2026-08-31T04:00:00Z")).open,false);
assert.equal(chinaTradingSession(new Date("2026-08-30T02:00:00Z")).open,false); // 周日
console.log("StockDesk v1.9.2 monitor checks: PASS");
