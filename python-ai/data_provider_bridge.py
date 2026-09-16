import json, sys, importlib.util


def out(data=None, error=None):
    print(json.dumps({'data': data, 'error': error}, ensure_ascii=False), flush=True)


def norm_code(code):
    s=str(code or '').lower().strip()
    if s[:2] in ('sh','sz','bj'):
        market, value=s[:2],s[2:]
        return ('bj' if value.startswith('92') else market), value
    if s.startswith(('92','8','4')): return 'bj', s
    if s.startswith(('60','68','51','50','90')): return 'sh', s
    return 'sz', s


def pytdx(req):
    from pytdx.hq import TdxHq_API
    api=TdxHq_API()
    servers=[('119.147.212.81',7709),('124.71.187.122',7709),('218.108.98.244',7709)]
    connected=False
    for host,port in servers:
        try:
            if api.connect(host,port,raise_exception=True): connected=True; break
        except Exception: pass
    if not connected: raise RuntimeError('pytdx 无可用行情服务器')
    cap=req['capability']; code=req.get('code'); market,c=norm_code(code)
    if cap!='quote' and market=='bj':
        raise RuntimeError('pytdx 当前不支持北交所，交由其他数据源处理')
    m=1 if market=='sh' else 0
    if cap=='quote':
        pairs=[]
        for raw in req.get('codes') or [code]:
            mm,cc=norm_code(raw); pairs.append((1 if mm=='sh' else 0,cc,mm))
        if any(market=='bj' for _,_,market in pairs):
            raise RuntimeError('pytdx 当前不支持北交所批量行情，交由其他数据源处理')
        rows=api.get_security_quotes([(m,cc) for m,cc,_ in pairs])
        out=[]
        for x,(mm,cc,market) in zip(rows,pairs):
            last=float(x.get('last_close') or 0); price=float(x.get('price') or 0)
            out.append({'code':cc,'symbol':market+cc,'name':x.get('name',''),'price':price,'prevClose':last,'open':float(x.get('open') or 0),'high':float(x.get('high') or 0),'low':float(x.get('low') or 0),'volume':float(x.get('vol') or 0),'amount':float(x.get('amount') or 0),'changePercent':price/last*100-100 if last else 0})
        return out
    if cap=='kline':
        freq={'day':9,'week':5,'month':6}.get(req.get('period'),9)
        bars=api.get_security_bars(freq,m,c,0,int(req.get('count') or 160))
        return [{'time':str(x.get('datetime',''))[:10],'open':float(x.get('open') or 0),'close':float(x.get('close') or 0),'high':float(x.get('high') or 0),'low':float(x.get('low') or 0),'volume':float(x.get('vol') or 0),'amount':float(x.get('amount') or 0)} for x in bars]
    if cap=='minute':
        bars=api.get_security_bars(8,m,c,0,240)
        pts=[]
        for x in bars:
            tm=str(x.get('datetime',''))[-5:]
            try: mins=int(tm[:2])*60+int(tm[3:]); pts.append({'t':mins,'p':float(x.get('close') or 0),'v':float(x.get('vol') or 0),'amount':float(x.get('amount') or 0)})
            except Exception: pass
        return {'prevClose':None,'points':pts,'name':None,'price':pts[-1]['p'] if pts else None,'changePercent':None}
    raise RuntimeError('pytdx 不支持此能力')


def baostock(req):
    import baostock as bs
    lg=bs.login()
    if lg.error_code!='0': raise RuntimeError(lg.error_msg)
    try:
        market,code=norm_code(req.get('code'))
        if market=='bj':
            raise RuntimeError('Baostock 当前不支持北交所，交由其他数据源处理')
        symbol=f'{market}.{code}'
        rs=bs.query_history_k_data_plus(symbol,'date,open,high,low,close,volume,amount','', '', frequency='d', adjustflag='2')
        rows=[]
        while rs.next(): rows.append(rs.get_row_data())
        return [{'time':r[0],'open':float(r[1] or 0),'high':float(r[2] or 0),'low':float(r[3] or 0),'close':float(r[4] or 0),'volume':float(r[5] or 0),'amount':float(r[6] or 0)} for r in rows[-int(req.get('count') or 160):] if r[0] and float(r[4] or 0)>0]
    finally:
        bs.logout()


def akshare(req):
    import akshare as ak
    cap=req['capability']; market,code=norm_code(req.get('code'))
    if cap=='kline':
        df=ak.stock_zh_a_hist(symbol=code, period='daily', adjust='qfq')
        rows=[]
        for _,r in df.tail(int(req.get('count') or 160)).iterrows():
            rows.append({'time':str(r['日期']),'open':float(r['开盘']),'high':float(r['最高']),'low':float(r['最低']),'close':float(r['收盘']),'volume':float(r['成交量']),'amount':float(r['成交额'])})
        return rows
    if cap=='quote':
        df=ak.stock_zh_a_spot_em()
        hit=df[df['代码'].astype(str).str.zfill(6)==code]
        if hit.empty:return []
        r=hit.iloc[0]
        return [{'code':code,'symbol':market+code,'name':str(r['名称']),'price':float(r['最新价']),'prevClose':None,'open':float(r['今开']),'high':float(r['最高']),'low':float(r['最低']),'volume':float(r['成交量']),'amount':float(r['成交额']),'changePercent':float(r['涨跌幅'])}]
    raise RuntimeError('AKShare桥接当前仅实现 quote/kline')


def main():
    req=json.loads(sys.stdin.read() or '{}'); p=req.get('provider');
    try:
        if p=='tdx': data=pytdx(req)
        elif p=='baostock': data=baostock(req)
        elif p=='akshare': data=akshare(req)
        else: raise RuntimeError('未知桥接数据源')
        out(data=data)
    except ModuleNotFoundError as e:
        out(error=f'{p} 依赖未安装：{e.name}')
        sys.exit(2)
    except Exception as e:
        out(error=str(e)[:500]); sys.exit(3)

if __name__=='__main__': main()
