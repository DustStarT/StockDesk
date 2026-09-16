/** 可选公网冒烟：验证真实新股历史不会进入异常链路。 */
import assert from "node:assert/strict";
import { configureDataSources, DEFAULT_DATA_SOURCE_CONFIG, getKline } from "../engine/data-provider-hub.js";
import { runStrategyLab } from "../engine/strategy-lab.js";
import { buildColdStartPrediction, decisionFromPrediction, buildAdaptiveAiPlan } from "../engine/local-ai.js";

const code = process.argv[2] || "sh688825";
configureDataSources(DEFAULT_DATA_SOURCE_CONFIG);
const result = await getKline(code, "day", 750, { force: true });
assert.ok(result.candles.length > 0, `未取得 ${code} 日 K：${result.error || "数据源无结果"}`);
const strategy = runStrategyLab(result.candles, { mode: "smart", profile: "balanced" }, { scan: false });
let ai = { mode: "kronos_ready" };
if (result.candles.length < 40) {
  const prediction = buildColdStartPrediction(result.candles);
  const decision = decisionFromPrediction(prediction, strategy);
  const plan = buildAdaptiveAiPlan(prediction, strategy);
  assert.equal(decision.action, "WATCH");
  assert.equal(plan.monitorEligible, false);
  ai = { mode: prediction.sourceMode, confidence: decision.confidence, monitorEligible: plan.monitorEligible };
}
console.log(JSON.stringify({ code, provider: result.provider, bars: result.candles.length, strategy: strategy.status, ai }, null, 2));
