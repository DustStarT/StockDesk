/** StockDesk v1.9.2 选股页回归：行业计数、搜索、全量结果和分页契约。全离线。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoardListRow, dedupeIndustryBoards } from "../engine/market-fetchers.js";

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const renderer=readFileSync(join(root,"renderer/app.js"),"utf8");
const main=readFileSync(join(root,"main.js"),"utf8");
const screener=readFileSync(join(root,"engine/screener.js"),"utf8");
const sectors=readFileSync(join(root,"engine/sectors.js"),"utf8");

// 1) 东财板块只有涨跌平家数完整时才生成 count；缺字段时必须保持 undefined 而不是字符串。
const complete=parseBoardListRow({f12:"BK0737",f14:"计算机",f3:1.2,f104:31,f105:20,f106:2});
assert.equal(complete.count,53);
const incomplete=parseBoardListRow({f12:"BK0737",f14:"计算机",f3:1.2,f104:31,f105:20});
assert.equal(incomplete.count,undefined);
const unique=dedupeIndustryBoards([
  {code:"BK0737",name:"计算机",count:100},
  {code:"BK0737",name:"计算机",count:100},
  {code:"BK9999",name:" 计算机 ",count:99},
  {code:"BK9998",name:"计\u200B算机",count:98},
  {code:"BK0475",name:"银行",count:42},
]);
assert.deepEqual(unique.map(x=>x.code),["BK0737","BK0475"]);
const hierarchyUnique=dedupeIndustryBoards([
  {code:"BK1254",name:"动物保健Ⅱ"},
  {code:"BK1501",name:"动物保健Ⅲ"},
  {code:"BK0475",name:"银行"},
  {code:"BK1283",name:"银行Ⅱ"},
]);
assert.deepEqual(hierarchyUnique.map(x=>x.code),["BK1501","BK1283"]);

// 2) UI 不允许直接把 b.count 拼进去，否则会再次出现“(undefined)”。
assert.ok(renderer.includes("Number.isFinite(count)"));
assert.ok(!renderer.includes('（${b.count}）'));

// 3) 行业搜索、备选股票搜索、最大结果和分页必须存在。
for(const id of ["screen-industry-search","screen-stock-search","screen-max-results","screen-page-size"]){
  assert.ok(renderer.includes(id),`missing ${id}`);
}
assert.ok(renderer.includes("screen-page-btn"));
assert.ok(renderer.includes("搜索行业名称 / 板块代码"));
assert.ok(renderer.includes("搜索备选股票名称 / 代码"));

// 4) 后端允许 0=全部，并把安全上限限制在500；选股不再固定 rows.slice(0, top)。
assert.ok(main.includes("Math.min(500"));
assert.ok(screener.includes("maxResults <= 0 表示返回全部"));
assert.ok(screener.includes("TECHNICAL_SCAN_BUDGET = 6"));
assert.ok(screener.includes("mapLimit(technicalCandidates, 4"));
assert.ok(!screener.includes("rows.slice(0, top)"));

// 5) 两个行业数据源的换手率必须使用同一“百分数值”口径，避免东财全部被误判为高换手。
assert.ok(sectors.includes("turnover: num(r.turnoverratio),"));
assert.ok(screener.includes("turnover >= 0.8 && turnover <= 8"));
assert.ok(screener.includes("turnover > 15"));

// 6) 行业目录必须稳定翻页并按代码/名称去重；北交所成分代码不得误标为深市。
const fetchers=readFileSync(join(root,"engine/market-fetchers.js"),"utf8");
assert.ok(fetchers.includes("fid=f12&fs=m:90+t:2"));
assert.ok(fetchers.includes("dedupeIndustryBoards"));
assert.ok(screener.includes("dataHub.normalizeStockCode(code)?.symbol"));
assert.ok(renderer.includes("function uniqueScreenBoards") && renderer.includes("state.screenBoards = uniqueScreenBoards"));

console.log("StockDesk v1.9.2 screener checks: PASS");
