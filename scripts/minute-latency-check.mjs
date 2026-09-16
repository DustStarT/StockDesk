import assert from 'node:assert/strict';
import {configureDataSources,resetProviderBreaker,getMinute,providerRequest} from '../engine/data-provider-hub.js';
configureDataSources({providers:{tencent:{enabled:true,globalMinIntervalMs:250,minIntervals:{minute:250,aux:250}},eastmoney:{enabled:true,globalMinIntervalMs:250,minIntervals:{minute:250}},sina:{enabled:false}}});
resetProviderBreaker();
const original=globalThis.fetch;
let count=0;
globalThis.fetch=async url=>{
  count++;
  if(String(url).includes('eastmoney'))return Response.json({data:{prePrice:10,trends:['2026-09-09 09:30,10,10.1,10.2,10,100,1010,10.05']}});
  if(String(url).includes('minute/query'))await new Promise(r=>setTimeout(r,900));
  return Response.json({});
};
try {
  const start=performance.now();
  const [a,b]=await Promise.all([getMinute('sz000002',{force:true}),getMinute('sz000002',{force:true})]);
  assert.equal(a.provider,'eastmoney'); assert.deepEqual(a.points,b.points);
  assert.ok(performance.now()-start<800,'healthy minute provider must not await stalled source');
  assert.equal(count,2,'same-stock requests must coalesce');
  const cached=await getMinute('sz000002');assert.equal(cached.points.length,1);assert.equal(count,2);
  console.log('Minute latency/coalescing/cache PASS');
} finally {await new Promise(r=>setTimeout(r,1000));globalThis.fetch=original;}
