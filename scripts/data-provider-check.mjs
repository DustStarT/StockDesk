/** StockDesk v1.9.2 多数据源 Hub 离线回归。 */
import assert from "node:assert/strict";
import {
  parseTencentQuoteText, parseSinaQuoteText, parseEastmoneyBatchQuote, parseEastmoneyKline, parseSinaKline, parseEastmoneyMinute,
  parseEastmoneySuggestions, parseEastmoneySecurityDirectory, normalizeStockCode, sanitizeConfig, DEFAULT_DATA_SOURCE_CONFIG, configureDataSources, getQuotes, getKline, getDataSourceStatus, resetProviderBreaker, isWafLike, providerRequest
} from "../engine/data-provider-hub.js";
import { parseCode as parseResearchCode } from "../engine/market-fetchers.js";

const tq=parseTencentQuoteText('v_sh600519="1~贵州茅台~600519~1500.00~1490.00~1495.00~12345~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260831150000~10.00~0.67~1510.00~1480.00~0~0~12.34";');
assert.equal(tq.length,1); assert.equal(tq[0].name,"贵州茅台"); assert.equal(tq[0].price,1500); assert.equal(tq[0].changePercent,.67);
const sq=parseSinaQuoteText('var hq_str_sh600519="贵州茅台,1495.00,1490.00,1500.00,1510.00,1480.00,0,0,1234500,234567890,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-08-31,15:00:00,00";');
assert.equal(sq.length,1); assert.equal(sq[0].price,1500); assert.ok(sq[0].changePercent>.6);
const eq=parseEastmoneyBatchQuote({data:{diff:[{f2:1500,f3:.67,f4:10,f5:100,f6:200000,f12:"600519",f14:"贵州茅台",f15:1510,f16:1480,f17:1495,f18:1490}]}});
assert.equal(eq.length,1); assert.equal(eq[0].prevClose,1490);
const bj=parseEastmoneyBatchQuote({data:{diff:[{f2:12.3,f3:1.2,f4:.15,f5:100,f6:200000,f12:"832000",f14:"北交测试",f15:12.5,f16:12,f17:12.1,f18:12.15}]}});assert.equal(bj[0].symbol,"bj832000");
assert.equal(normalizeStockCode("920186").symbol,"bj920186");
assert.equal(normalizeStockCode("bj920186").symbol,"bj920186");
assert.equal(normalizeStockCode("sh920186").symbol,"bj920186");
assert.equal(normalizeStockCode("920186").secid,"0.920186");
assert.equal(normalizeStockCode("900901").symbol,"sh900901");
assert.equal(parseResearchCode("920186").secid,"0.920186");
const emIndex=parseEastmoneyBatchQuote({data:{diff:[{f2:4000,f3:1,f12:"000001",f13:1,f14:"上证指数",f18:3960}]}});assert.equal(emIndex[0].symbol,"sh000001");
const em920=parseEastmoneyBatchQuote({data:{diff:[{f2:40,f3:2,f12:"920186",f13:0,f14:"中科仪",f18:39.2}]}});assert.equal(em920[0].symbol,"bj920186");
const suggestions=parseEastmoneySuggestions({QuotationCodeTable:{Data:[{Code:"920186",Name:"中科仪",QuoteID:"0.920186",MktNum:"0",SecurityTypeName:"北证A股"},{Code:"000001",Name:"上证指数",QuoteID:"1.000001",MktNum:"1",SecurityTypeName:"指数"}]}});
assert.deepEqual(suggestions.map(x=>x.symbol),["bj920186","sh000001"]);
const directory=parseEastmoneySecurityDirectory({data:{diff:[{f12:"920186",f13:0,f14:"中科仪"},{f12:"600519",f13:1,f14:"贵州茅台"}]}},"bj");
assert.deepEqual(directory.map(x=>x.symbol),["bj920186"]);
const kl=parseEastmoneyKline({data:{klines:["2026-08-28,10,11,12,9,1000","2026-08-31,11,12,13,10,1200"]}});assert.equal(kl.length,2);assert.equal(kl[1].close,12);
const skl=parseSinaKline([{day:"2026-08-28",open:"10",close:"11",high:"12",low:"9",volume:"1000"}]);assert.equal(skl.length,1);assert.equal(skl[0].close,11);
const mi=parseEastmoneyMinute({data:{name:"测试",prePrice:10,trends:["2026-08-31 09:30,10.1,10.05,10.1,10.0,100,1010,10.05","2026-08-31 09:31,10.2,10.08,10.2,10.1,120,1224,10.08"]}});assert.equal(mi.points.length,2);assert.equal(mi.price,10.2);assert.ok(mi.changePercent>1.9);
assert.equal(isWafLike(429,""),true); assert.equal(isWafLike(200,"Access Denied by WAF"),true); assert.equal(isWafLike(200,"normal"),false);
const cfg=sanitizeConfig({...DEFAULT_DATA_SOURCE_CONFIG,routingMode:"rotate",providers:{tencent:{enabled:true,priority:5,minIntervals:{quote:1}},eastmoney:{enabled:true},sina:{enabled:false}},customProviders:[{id:"x-1",label:"X",capabilities:["quote","bad"],quote:{url:"https://example.com/{symbol}",map:{price:"data.last"}}}]});
assert.equal(cfg.routingMode,"rotate"); assert.equal(cfg.providers.tencent.minIntervals.quote,250); assert.equal(cfg.providers.tencent.globalMinIntervalMs,900); assert.ok(cfg.providers.tdx && cfg.providers.tushare && cfg.providers.baostock && cfg.providers.akshare && cfg.providers.exchange); assert.equal(cfg.customProviders.length,1); assert.deepEqual(cfg.customProviders[0].capabilities,["quote"]);
const migrated=sanitizeConfig({configVersion:1,providers:{tencent:{globalMinIntervalMs:1800,minIntervals:{quote:15000,minute:18000,kline:45000,aux:3000}},eastmoney:{globalMinIntervalMs:1800,minIntervals:{quote:15000,minute:18000,kline:45000,aux:3000}},sina:{globalMinIntervalMs:1800,minIntervals:{quote:15000,aux:4000}}}});
assert.equal(migrated.configVersion,3);assert.equal(migrated.providers.tencent.globalMinIntervalMs,900);assert.equal(migrated.providers.tencent.minIntervals.kline,2500);assert.equal(migrated.providers.tencent.minIntervals.minute,1200);assert.equal(migrated.providers.eastmoney.minIntervals.aux,900);
const migratedV2=sanitizeConfig({...DEFAULT_DATA_SOURCE_CONFIG,configVersion:2,providers:{...DEFAULT_DATA_SOURCE_CONFIG.providers,tencent:{...DEFAULT_DATA_SOURCE_CONFIG.providers.tencent,minIntervals:{...DEFAULT_DATA_SOURCE_CONFIG.providers.tencent.minIntervals,minute:5000}},eastmoney:{...DEFAULT_DATA_SOURCE_CONFIG.providers.eastmoney,minIntervals:{...DEFAULT_DATA_SOURCE_CONFIG.providers.eastmoney.minIntervals,minute:5000}}}});
assert.equal(migratedV2.providers.tencent.minIntervals.minute,1200);assert.equal(migratedV2.providers.eastmoney.minIntervals.minute,1200);

// Mock global fetch to verify two healthy providers alternate; no real network.
const originalFetch=globalThis.fetch; let hits=[];
globalThis.fetch=async (url)=>{hits.push(String(url));if(String(url).includes("qt.gtimg.cn"))return new Response('v_sh600519="1~贵州茅台~600519~1500~1490~1495~100~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~x~10~0.67~1510~1480~0~0~12.3"',{status:200});if(String(url).includes("eastmoney"))return Response.json({data:{diff:[{f2:1501,f3:.74,f4:11,f5:100,f6:200000,f12:"600519",f14:"贵州茅台",f15:1511,f16:1480,f17:1495,f18:1490}]}});return new Response("",{status:404});};
configureDataSources({routingMode:"rotate",providers:{tencent:{enabled:true,minIntervals:{quote:250},priority:20},eastmoney:{enabled:true,minIntervals:{quote:250},priority:10},sina:{enabled:false}}});
resetProviderBreaker();
const a=await getQuotes(["sh600519"],{force:true}); const b=await getQuotes(["sh600519"],{force:true});
assert.ok(a.rows.length&&b.rows.length); assert.notEqual(a.provider,b.provider); assert.ok(hits.length>=2);
// 必须使用真实 GBK 字节测试；直接放 Unicode 中文会掩盖 Response.text() 的乱码问题。
const tencentGbkQuote=Buffer.concat([
  Buffer.from('v_sh600519="1~','ascii'),
  Buffer.from([0xb9,0xf3,0xd6,0xdd,0xc3,0xa9,0xcc,0xa8]),
  Buffer.from('~600519~1500~1490~1495~100~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~x~10~0.67~1510~1480~0~0~12.3"','ascii'),
]);
configureDataSources({routingMode:"priority",providers:{tencent:{enabled:true,priority:1,minIntervals:{quote:250}},eastmoney:{enabled:false},sina:{enabled:false}}});
resetProviderBreaker();
globalThis.fetch=async()=>new Response(tencentGbkQuote,{status:200,headers:{"Content-Type":"text/html; charset=GBK"}});
const decoded=await getQuotes(["sh600519"],{force:true});
assert.equal(decoded.rows[0].name,"贵州茅台");assert.equal(decoded.rows[0].name.includes("�"),false);
// 批量源只返回部分代码时，必须由其他健康源补齐；东财 f13 要保留同号指数的真实市场。
resetProviderBreaker();
configureDataSources({routingMode:"priority",providers:{tencent:{enabled:true,priority:1,globalMinIntervalMs:250,minIntervals:{quote:250}},eastmoney:{enabled:true,priority:2,globalMinIntervalMs:250,minIntervals:{quote:250}},sina:{enabled:false}}});
globalThis.fetch=async (url)=>{
  if(String(url).includes("qt.gtimg.cn"))return new Response('v_sh000001="1~上证指数~000001~4000~3960~3970~100~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~x~40~1.01~4010~3950~0~0~100"',{status:200});
  if(String(url).includes("eastmoney"))return Response.json({data:{diff:[{f2:40,f3:2,f4:.8,f5:100,f6:200000,f12:"920186",f13:0,f14:"中科仪",f15:41,f16:39,f17:39.5,f18:39.2}]}});
  return new Response("",{status:404});
};
const completed=await getQuotes(["sh000001","bj920186"],{force:true});
assert.deepEqual(completed.rows.map(x=>x.symbol),["sh000001","bj920186"]);
assert.deepEqual(completed.providers,["tencent","eastmoney"]);
assert.equal(completed.partial,false);
// 北交所历史必须优先走能返回完整序列的东财，不能先接受腾讯的一根占位 K 线。
resetProviderBreaker();
configureDataSources({routingMode:"priority",providers:{tencent:{enabled:true,priority:1,globalMinIntervalMs:250,minIntervals:{kline:250}},eastmoney:{enabled:true,priority:20,globalMinIntervalMs:250,minIntervals:{kline:250}},sina:{enabled:false}}});
hits=[];
globalThis.fetch=async (url)=>{hits.push(String(url));if(String(url).includes("eastmoney"))return Response.json({data:{klines:["2026-09-03,10,11,12,9,1000","2026-09-04,11,12,13,10,1200"]}});if(String(url).includes("gtimg"))return Response.json({data:{bj920187:{day:[["2026-09-04",11,12,13,10,1200]]}}});return new Response("",{status:404});};
const bjHistory=await getKline("bj920187","day",120,{force:true});
assert.equal(bjHistory.provider,"eastmoney");assert.equal(bjHistory.candles.length,2);assert.ok(!hits.some(x=>x.includes("gtimg")));
// 任意来源的一根北交所占位 K 线都不能被当成完整历史。
globalThis.fetch=async (url)=>{if(String(url).includes("eastmoney"))return Response.json({data:{klines:["2026-09-04,11,12,13,10,1200"]}});if(String(url).includes("gtimg"))return Response.json({data:{bj920188:{day:[["2026-09-04",11,12,13,10,1200]]}}});return new Response("",{status:404});};
const incompleteBjHistory=await getKline("bj920188","day",120,{force:true});
assert.equal(incompleteBjHistory.candles.length,0);assert.equal(incompleteBjHistory.provider,null);assert.match(incompleteBjHistory.error,/empty/);
const st=getDataSourceStatus(); assert.equal(st.providers.find(x=>x.id==="sina").enabled,false);
// WAF/429 must immediately circuit-break the affected source and fall through to another provider.
resetProviderBreaker();
configureDataSources({routingMode:"priority",providers:{tencent:{enabled:true,priority:1,minIntervals:{quote:250},cooldownMinutes:30},eastmoney:{enabled:true,priority:20,minIntervals:{quote:250}},sina:{enabled:false}}});
globalThis.fetch=async (url)=>{if(String(url).includes("qt.gtimg.cn"))return new Response("Access Denied by WAF",{status:429});if(String(url).includes("eastmoney"))return Response.json({data:{diff:[{f2:1502,f3:.8,f4:12,f5:100,f6:200000,f12:"600519",f14:"贵州茅台",f15:1512,f16:1480,f17:1495,f18:1490}]}});return new Response("",{status:404});};
const wafFallback=await getQuotes(["sh600519"],{force:true});assert.equal(wafFallback.provider,"eastmoney");assert.equal(getDataSourceStatus().providers.find(x=>x.id==="tencent").blocked,true);
resetProviderBreaker();
// Provider-specific endpoints share the same governor and breaker.
configureDataSources({providers:{eastmoney:{enabled:true,globalMinIntervalMs:250,minIntervals:{aux:250}},tencent:{enabled:false},sina:{enabled:false}}});
globalThis.fetch=async()=>new Response("Too Many Requests",{status:429});
let auxFailed=false;try{await providerRequest("eastmoney","https://example.com/f10",{}, {capability:"aux",timeoutMs:1000});}catch(e){auxFailed=true;assert.equal(!!e.waf,true);}assert.equal(auxFailed,true);assert.equal(getDataSourceStatus().providers.find(x=>x.id==="eastmoney").blocked,true);
resetProviderBreaker();
globalThis.fetch=originalFetch;
console.log("StockDesk v1.9.2 data provider checks: PASS");
