/** 可选公网验收：东财单源下的新北交所代码、同号指数和动态证券搜索。 */
import assert from "node:assert/strict";
import {
  DEFAULT_DATA_SOURCE_CONFIG, configureDataSources, resetProviderBreaker,
  searchMarketSymbols, getQuotes, getKline,
} from "../engine/data-provider-hub.js";

configureDataSources({
  ...DEFAULT_DATA_SOURCE_CONFIG,
  routingMode: "priority",
  providers: {
    ...DEFAULT_DATA_SOURCE_CONFIG.providers,
    eastmoney: { ...DEFAULT_DATA_SOURCE_CONFIG.providers.eastmoney, enabled: true, priority: 1 },
    tencent: { ...DEFAULT_DATA_SOURCE_CONFIG.providers.tencent, enabled: false },
    sina: { ...DEFAULT_DATA_SOURCE_CONFIG.providers.sina, enabled: false },
  },
});
resetProviderBreaker();

const suggestions = await searchMarketSymbols("中科仪", 20);
assert.ok(suggestions.some((x) => x.symbol === "bj920186" && x.name.includes("中科仪")), `东财联想未找到中科仪：${JSON.stringify(suggestions)}`);

const quotes = await getQuotes(["bj920186", "sh000001"], { force: true });
assert.equal(quotes.provider, "eastmoney");
assert.equal(quotes.partial, false, `东财批量行情不完整：${JSON.stringify(quotes.missing)}`);
assert.deepEqual(quotes.rows.map((x) => x.symbol), ["bj920186", "sh000001"]);
assert.ok(quotes.rows.every((x) => x.price > 0 && x.name));

const [bjKline, indexKline] = await Promise.all([
  getKline("bj920186", "day", 120, { force: true }),
  getKline("sh000001", "day", 120, { force: true }),
]);
assert.ok(bjKline.candles.length > 0, "中科仪东财日K为空");
assert.ok(indexKline.candles.length >= 20, "上证指数东财日K不足");
console.log(`StockDesk v1.9.2 market coverage: PASS | search=bj920186 quotes=${quotes.rows.map((x)=>x.name).join(",")} kline=${bjKline.candles.length}/${indexKline.candles.length}`);
