import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { emCapitalFlow, parseCapitalFlowLine } from "../engine/market-fetchers.js";
import { summarizeCapitalFlow, buildStructuredResearchReport } from "../engine/research-report.js";
import { configureDataSources, resetProviderBreaker } from "../engine/data-provider-hub.js";

const line = "2026-09-15,-62055328,-25459,62080784,-91890944,29835616,-3.53,0,3.53,-5.23,1.70,1272.75,-0.41";
const missing = parseCapitalFlowLine("2026-09-14,-,-,-,-,-,-,-,-,-,-,-,-");
assert.equal(missing.mainNet, null);
assert.equal(parseCapitalFlowLine("bad,123"), null);
assert.equal(summarizeCapitalFlow([]).main10dNetYi, null);
assert.equal(summarizeCapitalFlow([missing]).status, "unavailable");
assert.equal(summarizeCapitalFlow([], "接口失败").message, "接口失败");
const parsed = parseCapitalFlowLine(line);
assert.equal(parsed.mainNet, -62055328);
assert.equal(parsed.changePct, -0.41);
assert.equal(summarizeCapitalFlow([parsed]).status, "partial");
assert.equal(summarizeCapitalFlow([parsed, missing]).validDays, 1);
const ten = Array.from({length:10}, (_, i) => ({...parsed, date:`2026-09-${String(i+1).padStart(2,"0")}`, mainNet:0}));
assert.equal(summarizeCapitalFlow(ten).status, "ok");
assert.equal(summarizeCapitalFlow(ten).main10dNetYi, 0);
assert.equal(summarizeCapitalFlow([{...parsed,mainNet:1}]).main10dNetYi, 1e-8);
for (const capitalFlow of [summarizeCapitalFlow([]), summarizeCapitalFlow([parsed])]) {
  const report=buildStructuredResearchReport({code:"sh600519",supplement:{capitalFlow}});
  assert.ok(report.evidence.dataGaps.some(x=>x.startsWith("资金流：")));
  assert.ok(![...report.evidence.positive,...report.evidence.negative].some(x=>x.includes("近10日主力资金")));
}

const source = readFileSync(new URL("../renderer/app.js", import.meta.url), "utf8");
const formatter = source.match(/function fmtMoneyYi\(v\) \{[\s\S]*?\n\}/)[0];
const fmt = runInNewContext(`${formatter}; fmtMoneyYi`);
assert.equal(fmt(null), "—"); assert.equal(fmt(undefined), "—"); assert.equal(fmt(""), "—");
assert.equal(fmt(0), "+0.00亿"); assert.equal(fmt(-0.62055328), "-0.62亿");
assert.notEqual(fmt(1e-8), "+0.00亿");

const originalFetch = globalThis.fetch;
configureDataSources({providers:{eastmoney:{enabled:true,globalMinIntervalMs:250,minIntervals:{aux:250}}}});
resetProviderBreaker();
try {
  const seen=[];
  let mode="success";
  globalThis.fetch=async (input)=>{
    const url=new URL(input); seen.push(url);
    assert.equal(url.searchParams.get("lmt"),"10");
    assert.ok(url.searchParams.get("ut"));
    const fail=mode==="empty" || (mode==="fallback" && url.hostname==="push2his.eastmoney.com");
    return new Response(JSON.stringify(fail?{rc:100,data:null}:{rc:0,data:{klines:[line]}}),{status:200});
  };
  const rows=await emCapitalFlow("sh600519");
  assert.equal(seen[0].hostname,"push2his.eastmoney.com");
  assert.equal(rows[0].mainNet,-62055328);
  mode="fallback";
  const start=seen.length;
  assert.equal((await emCapitalFlow("sz000001"))[0].mainNet,-62055328);
  assert.deepEqual(seen.slice(start).map(x=>x.hostname),["push2his.eastmoney.com","push2delay.eastmoney.com"]);
  mode="empty";
  await assert.rejects(emCapitalFlow("bj920186"),/资金流接口未返回有效数据/);
  mode="success";
  assert.equal((await emCapitalFlow("bj920186"))[0].mainNet,-62055328,"empty responses must not be cached");
} finally { globalThis.fetch=originalFetch; }
console.log("capital-flow-check: PASS (endpoint, fallback, missing/zero/partial, formatting)");
