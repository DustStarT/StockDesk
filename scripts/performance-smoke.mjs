/** StockDesk v1.9.2 性能烟雾测试：不是跨机器 benchmark，只防止明显性能回退。 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { INDICATOR_CATALOG, computeTechnicalIndicators, analyzeTechnicalIndicatorSet } from "../engine/technical-indicators.js";
import { runStrategyLab } from "../engine/strategy-lab.js";
function candles(n){let p=15;return Array.from({length:n},(_,i)=>{const o=p;p=Math.max(2,p*(1+.0004+Math.sin(i/17)*.004));return{time:String(i),open:o,close:p,high:Math.max(o,p)*1.01,low:Math.min(o,p)*.99,volume:1e5+(i%30)*4000};});}
const rows=candles(2200);
let t=performance.now(); const inds=computeTechnicalIndicators(INDICATOR_CATALOG.map(x=>x.id),rows,{floatShares:5e9},{}); const indicatorMs=performance.now()-t;
t=performance.now(); const agg=analyzeTechnicalIndicatorSet(inds,rows); const aggregateMs=performance.now()-t;
t=performance.now(); const lab=runStrategyLab(rows,{presetId:"trend_breakout"},{scan:true}); const strategyMs=performance.now()-t;
t=performance.now(); const smart=runStrategyLab(rows,{mode:"smart",profile:"balanced"},{marketRegime:{state:"range_bull"},scan:true}); const smartMs=performance.now()-t;
assert.equal(inds.length,22); assert.ok(Number.isFinite(agg.compositeScore)); assert.equal(lab.status,"ok"); assert.equal(smart.recommendation?.status,"ok");
// 阈值只用于发现数量级退化，给共享 CI/容器留足空间。
assert.ok(indicatorMs<5000,`22 indicators too slow: ${indicatorMs.toFixed(1)}ms`);
assert.ok(aggregateMs<1500,`aggregate too slow: ${aggregateMs.toFixed(1)}ms`);
assert.ok(strategyMs<8000,`strategy lab too slow: ${strategyMs.toFixed(1)}ms`);
assert.ok(smartMs<15000,`smart strategy recommendation too slow: ${smartMs.toFixed(1)}ms`);
console.log(`StockDesk v1.9.2 performance smoke: PASS | 2200 bars: indicators=${indicatorMs.toFixed(1)}ms aggregate=${aggregateMs.toFixed(1)}ms strategy+scan=${strategyMs.toFixed(1)}ms smart=${smartMs.toFixed(1)}ms`);
