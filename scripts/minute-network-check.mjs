import {getMinute,resetProviderBreaker} from '../engine/data-provider-hub.js';
resetProviderBreaker();
for (const code of ['sh600519','sz000001','bj920186']) {
  const start=performance.now();
  const r=await getMinute(code,{force:true});
  const cachedAt=performance.now();
  const cached=await getMinute(code);
  console.log(JSON.stringify({code,provider:r.provider,points:r.points.length,elapsedMs:Math.round(cachedAt-start),cacheMs:Math.round(performance.now()-cachedAt),cachePoints:cached.points.length,error:r.error}));
  if (!r.points.length) process.exitCode=1;
}
