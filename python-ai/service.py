#!/usr/bin/env python3
"""StockDesk local AI sidecar (NDJSON over stdio).
The base financial model is Kronos; River provides a tiny online calibration layer.
No network server is opened.
"""
from __future__ import annotations
import json, os, pickle, sys, time, traceback
from pathlib import Path
from statistics import median

HOME=Path(os.environ.get("STOCKDESK_AI_HOME", Path.home()/".stockdesk"/"ai-engine")).resolve()
VENDOR=HOME/"vendor"; MODELS=HOME/"models"; ONLINE=HOME/"online"; ONLINE.mkdir(parents=True,exist_ok=True)
_model_cache={}
_online_cache={}
_drift_cache={}

KRONOS={
 "kronos-mini":("NeoQuasar/Kronos-mini","tokenizer-2k",2048),
 "kronos-small":("NeoQuasar/Kronos-small","tokenizer-base",512),
 "kronos-base":("NeoQuasar/Kronos-base","tokenizer-base",512),
}

def reply(req_id, ok=True, **payload):
    print(json.dumps({"id":req_id,"ok":ok,**payload},ensure_ascii=False),flush=True)

def q(values,p):
    xs=sorted(float(x) for x in values)
    if not xs:return None
    if len(xs)==1:return xs[0]
    pos=(len(xs)-1)*p; lo=int(pos); hi=min(len(xs)-1,lo+1); f=pos-lo
    return xs[lo]*(1-f)+xs[hi]*f

def online_paths(code,horizon):
    safe="".join(c for c in str(code) if c.isalnum() or c in "_-")[:40]
    return ONLINE/f"{safe}_{int(horizon)}m.pkl"

def get_online(code,horizon):
    key=(str(code),int(horizon))
    if key in _online_cache:return _online_cache[key],_drift_cache[key]
    from river import compose, preprocessing, linear_model, drift
    p=online_paths(*key)
    if p.exists():
        try:
            with p.open("rb") as f: obj=pickle.load(f)
            model=obj["model"]; detector=obj.get("drift") or drift.ADWIN(); stats=obj.get("stats",{})
        except Exception:
            model=compose.Pipeline(preprocessing.StandardScaler(),linear_model.LogisticRegression()); detector=drift.ADWIN(); stats={}
    else:
        model=compose.Pipeline(preprocessing.StandardScaler(),linear_model.LogisticRegression()); detector=drift.ADWIN(); stats={}
    stats={"updates":0,"correct":0,"lastDriftAt":None,**stats}
    _online_cache[key]=(model,stats); _drift_cache[key]=detector
    return _online_cache[key],detector

def save_online(code,horizon):
    key=(str(code),int(horizon)); (model,stats)=_online_cache[key]; detector=_drift_cache[key]
    with online_paths(*key).open("wb") as f:pickle.dump({"model":model,"drift":detector,"stats":stats},f)

def load_kronos(model_id,device=None):
    if model_id not in KRONOS: raise ValueError("unsupported Kronos model")
    key=(model_id,device or "auto")
    if key in _model_cache:return _model_cache[key]
    repo=VENDOR/"Kronos"
    if not repo.exists(): raise RuntimeError("Kronos源码未安装")
    sys.path.insert(0,str(repo)) if str(repo) not in sys.path else None
    from model import Kronos,KronosTokenizer,KronosPredictor
    _,tok_name,ctx=KRONOS[model_id]
    mdir=MODELS/model_id; tdir=MODELS/tok_name
    if not mdir.exists() or not tdir.exists():raise RuntimeError("Kronos权重未安装完整")
    tokenizer=KronosTokenizer.from_pretrained(str(tdir))
    model=Kronos.from_pretrained(str(mdir))
    pred=KronosPredictor(model,tokenizer,device=device,max_context=ctx)
    _model_cache[key]=pred
    return pred

def make_features(base_prob,med,q10,q90,extra):
    return {
      "base_prob":float(base_prob),"median_return":float(med),"spread":float(q90-q10),
      "strategy_score":float(extra.get("strategyScore") or 0)/100.0,
      "risk":float(extra.get("risk") or 50)/100.0,
      "change_pct":float(extra.get("changePercent") or 0)/10.0,
      "regime":float(extra.get("regimeScore") or 0)/100.0,
    }

def predict(req):
    import pandas as pd
    model_id=req.get("modelId","kronos-small"); candles=req.get("candles") or []
    if len(candles)<40: raise ValueError("Kronos至少需要40根有效K线用于试验预测")
    ctx=KRONOS.get(model_id,(None,None,512))[2]
    candles=candles[-min(ctx,len(candles)):]
    df=pd.DataFrame([{
       "open":float(x["open"]),"high":float(x["high"]),"low":float(x["low"]),"close":float(x["close"]),
       "volume":float(x.get("volume") or 0),"amount":float(x.get("amount") or 0)
    } for x in candles])
    ts=pd.to_datetime([x.get("time") for x in candles])
    if ts.isna().any(): raise ValueError("K线时间格式无效")
    pred_len=max(1,min(20,int(req.get("predLen") or 5))); sample_runs=max(1,min(7,int(req.get("sampleRuns") or 3)))
    last=ts[-1]
    yts=pd.Series(pd.bdate_range(last+pd.Timedelta(days=1),periods=pred_len))
    predictor=load_kronos(model_id,req.get("device"))
    last_close=float(df.iloc[-1]["close"]); returns=[]; paths=[]
    for _ in range(sample_runs):
        out=predictor.predict(df=df,x_timestamp=pd.Series(ts),y_timestamp=yts,pred_len=pred_len,T=float(req.get("temperature") or 1.0),top_p=float(req.get("topP") or .9),sample_count=1,verbose=False)
        closes=[float(x) for x in out["close"].tolist()]
        returns.append((closes[-1]/last_close-1)*100.0); paths.append(closes)
    pos=sum(1 for x in returns if x>0)/len(returns)
    med=float(median(returns)); q10=float(q(returns,.1)); q90=float(q(returns,.9))
    horizon=int(req.get("onlineHorizonMin") or 30); extra=req.get("extra") or {}
    (online,stats),_=get_online(req.get("code","unknown"),horizon)
    feats=make_features(pos,med,q10,q90,extra)
    try: calibrated=float(online.predict_proba_one(feats).get(True,.5)) if stats["updates"]>=8 else pos
    except Exception: calibrated=pos
    trajectory=[]
    for i in range(pred_len): trajectory.append(float(median([p[i] for p in paths])))
    return {"modelId":model_id,"base":"Kronos","lastClose":last_close,"predLen":pred_len,"sampleRuns":sample_runs,
      "positiveProbability":pos,"calibratedProbability":calibrated,"medianReturnPct":med,"q10ReturnPct":q10,"q90ReturnPct":q90,
      "trajectory":trajectory,"features":feats,"online":{"updates":stats["updates"],"accuracy":(stats["correct"]/stats["updates"] if stats["updates"] else None),"lastDriftAt":stats.get("lastDriftAt")},"generatedAt":int(time.time()*1000)}

def update_online(req):
    code=req.get("code","unknown"); horizon=int(req.get("horizonMin") or 30); feats=req.get("features") or {}; label=bool(req.get("label"))
    (model,stats),detector=get_online(code,horizon)
    try: before=float(model.predict_proba_one(feats).get(True,.5)) if stats["updates"] else .5
    except Exception: before=.5
    predicted=before>=.5
    model.learn_one(feats,label); err=0.0 if predicted==label else 1.0
    detector.update(err); stats["updates"]+=1; stats["correct"]+=int(predicted==label)
    if getattr(detector,"drift_detected",False): stats["lastDriftAt"]=int(time.time()*1000)
    save_online(code,horizon)
    return {"updates":stats["updates"],"accuracy":stats["correct"]/stats["updates"],"driftDetected":bool(getattr(detector,"drift_detected",False)),"lastDriftAt":stats.get("lastDriftAt")}

def status():
    manifest={}
    try: manifest=json.loads((HOME/"install-manifest.json").read_text("utf-8"))
    except Exception: pass
    pkgs={}
    for name in ["torch","pandas","numpy","river","huggingface_hub"]:
        try:
            mod=__import__(name); pkgs[name]=getattr(mod,"__version__","installed")
        except Exception: pkgs[name]=None
    cuda=False; gpu=None
    try:
        import torch; cuda=torch.cuda.is_available(); gpu=torch.cuda.get_device_name(0) if cuda else None
    except Exception: pass
    return {"home":str(HOME),"models":manifest.get("models") or [],"python":sys.version.split()[0],"packages":pkgs,"cuda":cuda,"gpu":gpu,"pid":os.getpid()}

def main():
    for line in sys.stdin:
        try:
            req=json.loads(line); rid=req.get("id"); action=req.get("action")
            if action=="ping": reply(rid,result={"pong":True,"time":int(time.time()*1000)})
            elif action=="status": reply(rid,result=status())
            elif action=="predict": reply(rid,result=predict(req))
            elif action=="update_online": reply(rid,result=update_online(req))
            elif action=="shutdown": reply(rid,result={"stopping":True}); break
            else: reply(rid,False,error="unknown action")
        except Exception as e:
            reply(req.get("id") if isinstance(req,dict) else None,False,error=str(e),trace=traceback.format_exc(limit=2))

if __name__=="__main__": main()
