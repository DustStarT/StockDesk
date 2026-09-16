/** 新股/次新股短历史回归：有限样本、AI冷启动和能力门槛。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runStrategyLab } from "../engine/strategy-lab.js";
import { buildColdStartPrediction, decisionFromPrediction, buildAdaptiveAiPlan } from "../engine/local-ai.js";

function candles(count) {
  return Array.from({ length: count }, (_, i) => {
    const close = 40 + i * .35 + Math.sin(i / 2) * 1.4;
    return {
      time: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
      open: close - .3,
      high: close + 1.1,
      low: close - 1.2,
      close,
      volume: 1000000 + i * 17000,
    };
  });
}

const rows27 = candles(27);
const limited = runStrategyLab(rows27, { mode: "smart", profile: "balanced" });
assert.equal(limited.status, "limited");
assert.equal(limited.historyBars, 27);
assert.equal(limited.metrics, undefined, "短历史不得伪造回测指标");
assert.equal(limited.current.matched, false, "短历史不得生成正式买点");
assert.equal(limited.limitedAnalysis.capabilities.find((x) => x.key === "technical").ready, true);
assert.equal(limited.limitedAnalysis.capabilities.find((x) => x.key === "kronos").ready, false);
assert.equal(limited.limitedAnalysis.capabilities.find((x) => x.key === "strategy").ready, false);

const prediction = buildColdStartPrediction(rows27);
assert.equal(prediction.base, "ColdStart");
assert.equal(prediction.sourceMode, "cold_start");
assert.equal(prediction.observed.bars, 27);
assert.equal(prediction.predLen, 0);
assert.deepEqual(prediction.trajectory, []);
assert.equal(prediction.medianReturnPct, null, "冷启动不得伪造未来收益");
assert.equal(prediction.monitorEligible, false);
const decision = decisionFromPrediction(prediction, limited);
assert.equal(decision.action, "WATCH");
assert.ok(decision.confidence <= 35);
const plan = buildAdaptiveAiPlan(prediction, limited, { maxAgeMin: 120 });
assert.equal(plan.monitorEligible, false);
assert.equal(plan.horizonDays, 0);
assert.deepEqual(plan.changes, [], "冷启动不得动态修改策略参数");
assert.ok(plan.riskFlags.some((x) => x.includes("不足40根")));

const rows40 = runStrategyLab(candles(40), { mode: "smart" });
assert.equal(rows40.status, "limited");
assert.equal(rows40.limitedAnalysis.capabilities.find((x) => x.key === "kronos").ready, true);
assert.equal(rows40.limitedAnalysis.capabilities.find((x) => x.key === "strategy").ready, false);

const rows100 = runStrategyLab(candles(100), { mode: "manual", presetId: "trend_breakout" }, { scan: false });
assert.equal(rows100.status, "ok");
assert.ok(rows100.metrics, "100根时应恢复正式策略回测");

const dirty = runStrategyLab([...rows27, { time: "bad", open: null, high: null, low: null, close: null }], { mode: "smart" });
assert.equal(dirty.historyBars, 27, "无效K线不能用于凑足能力门槛");

const root = new URL("..", import.meta.url);
const main = readFileSync(new URL("main.js", root), "utf8");
const renderer = readFileSync(new URL("renderer/app.js", root), "utf8");
const shadow = main.slice(main.indexOf("async function runLocalAiShadowOnce"), main.indexOf("async function processMatureLocalAiLabels"));
assert.ok(shadow.includes("if (validCandles.length < 40)"));
assert.ok(shadow.indexOf("if (validCandles.length < 40)") < shadow.indexOf("await startLocalAiService()"), "短历史必须在启动Python前分流");
assert.ok(shadow.includes("buildColdStartPrediction"));
assert.ok(main.includes('PYTHONUTF8: "1"') && main.includes('PYTHONIOENCODING: "utf-8"'), "Python管道必须强制UTF-8");
assert.ok(main.includes("plan?.monitorEligible !== false"), "冷启动不得进入AI主动提醒");
assert.ok(renderer.includes("function limitedStrategyHtml"));
assert.ok(renderer.includes("Kronos 没有运行，也没有生成未来收益预测"));

console.log("StockDesk v1.9.2 new-stock checks: PASS | 27→cold-start 40→Kronos 100→backtest");
