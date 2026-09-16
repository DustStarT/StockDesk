/** StockDesk v1.9.2 发布门禁：自动测试 + JS语法 + 发布结构。真实公网网络测试单独执行。 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
assert.equal(pkg.version,"1.9.3");
assert.ok(pkg.build?.files?.includes("python-ai/**/*"),"python-ai scripts must be packaged");
assert.ok(pkg.build?.asarUnpack?.includes("python-ai/**/*"),"python-ai scripts must be unpacked from ASAR for external Python");
for(const f of ["main.js","preload.js","renderer/index.html","engine/data-provider-hub.js","engine/llm-service.js","engine/web-research.js","engine/global-context.js","engine/research-agent.js","engine/strategy-monitor.js","engine/local-ai.js","python-ai/install.py","python-ai/service.py","README.md","RELEASE_NOTES_v1.9.3.md"]) assert.ok(existsSync(join(root,f)),`missing ${f}`);
function files(dir){const out=[];for(const n of readdirSync(dir)){if(n==="node_modules"||n==="build")continue;const p=join(dir,n),st=statSync(p);if(st.isDirectory())out.push(...files(p));else if(/\.(?:js|mjs)$/.test(n))out.push(p);}return out;}
for(const f of files(root)){const r=spawnSync(process.execPath,["--check",f],{encoding:"utf8"});assert.equal(r.status,0,`syntax fail ${relative(root,f)}\n${r.stderr}`);}
for(const script of ["unit-check.mjs","capital-flow-check.mjs","signal-trends-check.mjs","regression-check.mjs","security-check.mjs","llm-adapter-check.mjs","ui-contract-check.mjs","monitor-check.mjs","screener-check.mjs","global-context-check.mjs","research-agent-check.mjs","local-ai-check.mjs","new-stock-check.mjs","data-provider-check.mjs","minute-latency-check.mjs","performance-smoke.mjs"]){
  const r=spawnSync(process.execPath,[join(root,"scripts",script)],{encoding:"utf8",timeout:120000});
  process.stdout.write(r.stdout||""); process.stderr.write(r.stderr||""); assert.equal(r.status,0,`${script} failed`);
}
console.log("StockDesk v1.9.3 release gate: PASS");
