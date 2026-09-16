/** StockDesk v1.9.2 真实网络验收：以 Provider Hub 的“至少一个可用源”作为核心行情成功标准。 */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { configureDataSources, DEFAULT_DATA_SOURCE_CONFIG, testDataSources, getQuotes, getKline, getMinute } from "../engine/data-provider-hub.js";
import { emCapitalFlow, emBoardList, emBoardQuote, emBoardConst, matchIndustryBoard } from "../engine/market-fetchers.js";
import { collectGlobalContext } from "../engine/global-context.js";
const coreHosts=["qt.gtimg.cn","push2.eastmoney.com","hq.sinajs.cn"];
let resolved=0; for(const h of coreHosts){try{await lookup(h);resolved++;}catch{}}
if(!resolved){console.log(`StockDesk v1.9.2 network integration: BLOCKED_BY_ENV | 核心行情域名 DNS 均不可用`);process.exit(0);}
try{
  configureDataSources(DEFAULT_DATA_SOURCE_CONFIG);
  const ds=await testDataSources("sh601899");
  const quoteOK=ds.results.filter(x=>x.capability==="quote"&&x.ok);
  const klineOK=ds.results.filter(x=>x.capability==="kline"&&x.ok);
  assert.ok(quoteOK.length>=1,`no quote provider available: ${JSON.stringify(ds.results)}`);
  assert.ok(klineOK.length>=1,`no qfq kline provider available: ${JSON.stringify(ds.results)}`);
  const q=await getQuotes(["sh601899","sh600519"],{force:true}); assert.ok(q.rows.length>=1&&q.rows[0].price>0);
  const k=await getKline("sh601899","day",180,{force:true}); assert.ok(k.candles.length>=100&&k.candles.at(-1).close>0);
  const m=await getMinute("sh601899",{force:true}); assert.ok(Array.isArray(m.points));
  let specialized="specialized=skipped";
  try{
    const [flow,boards]=await Promise.all([emCapitalFlow("sh601899",10),emBoardList()]);
    const board=matchIndustryBoard("贵金属",boards);
    assert.ok(board?.code,`industry association missing: boards=${boards.length}`);
    const [liveBoard,peers]=await Promise.all([emBoardQuote(board.code),emBoardConst(board.code,8)]);
    assert.equal(liveBoard?.code,board.code); assert.ok(peers.length>=1);
    specialized=`flow=${flow.length} boards=${boards.length} matched=${liveBoard.name} peers=${peers.length}`;
  }catch(e){throw new Error(`association integration failed: ${e?.message||e}`);}
  let globalText="global=skipped";try{const g=await collectGlobalContext({code:"sh601899",name:"紫金矿业",industry:"贵金属",maxAssets:3});globalText=`globalAssets=${(g.assets||[]).filter(x=>x.available).length}/${(g.assets||[]).length}`;}catch(e){globalText=`global-partial:${e?.message||e}`;}
  console.log(`StockDesk v1.9.2 network integration: PASS | quoteSources=${quoteOK.map(x=>x.id).join(",")} klineSources=${klineOK.map(x=>x.id).join(",")} activeQuote=${q.provider} activeKline=${k.provider} ${specialized} ${globalText}`);
}catch(e){console.error(`StockDesk v1.9.2 network integration: FAIL | ${e?.stack||e}`);process.exit(1);}
