/** Real-network smoke test for the v1.9.2 encoding/association regression. */
import assert from "node:assert/strict";
import {
  DEFAULT_DATA_SOURCE_CONFIG,
  configureDataSources,
  getQuotes,
  resetProviderBreaker,
} from "../engine/data-provider-hub.js";
import { collectResearchSupplement } from "../engine/research-report.js";

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

configureDataSources({
  routingMode: "priority",
  providers: {
    tencent: { enabled: true, priority: 1, minIntervals: { quote: 250 } },
    eastmoney: { enabled: false },
    sina: { enabled: false },
  },
});
resetProviderBreaker();
const quoteResult = await withTimeout(getQuotes(["sh000001"], { force: true }), 15000, "Tencent quote");
assert.equal(quoteResult.provider, "tencent");
assert.equal(quoteResult.rows[0]?.name, "上证指数");
assert.ok(Number(quoteResult.rows[0]?.price) > 0);

configureDataSources(DEFAULT_DATA_SOURCE_CONFIG);
resetProviderBreaker();
const startedAt = Date.now();
const report = await withTimeout(collectResearchSupplement("sz300221"), 60000, "research association");
const elapsedMs = Date.now() - startedAt;
assert.equal(report.name, "银禧科技");
assert.ok(report.quote?.industry, "missing industry");
assert.ok(report.relatedQuotes?.board?.code, "missing associated board");
assert.ok(report.relatedQuotes?.board?.name, "missing associated board name");
assert.ok((report.relatedQuotes?.peers || []).length >= 1, "missing associated peers");

console.log(JSON.stringify({
  quote: {
    provider: quoteResult.provider,
    name: quoteResult.rows[0].name,
    price: quoteResult.rows[0].price,
  },
  association: {
    elapsedMs,
    name: report.name,
    industry: report.quote.industry,
    board: report.relatedQuotes.board.name,
    boardCode: report.relatedQuotes.board.code,
    peers: report.relatedQuotes.peers.length,
  },
}));
