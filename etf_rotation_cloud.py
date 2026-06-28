#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ETF 轮动选股器 — 云端版 (纯 Python, 无外部依赖)
"""
import json, math, sys, urllib.request, os
from datetime import datetime, timezone, timedelta

ETF_LIST = [
    {"code": "510300", "name": "沪深300 ETF", "market": "sh"},
    {"code": "159915", "name": "创业板 ETF",  "market": "sz"},
    {"code": "513100", "name": "纳指 ETF",    "market": "sh"},
    {"code": "518880", "name": "黄金 ETF",    "market": "sh"},
]

N = 25; VOL_WINDOW = 21; VOL_THRESHOLD = 35
TRADING_DAYS = 250; FETCH_DAYS = 60; TIMEOUT = 15
VOL_CORE_CODES = ["510300", "159915", "513100", "518880"]
CN_TZ = timezone(timedelta(hours=8))

def fetch_klines(code, market, days=FETCH_DAYS):
    url = f"https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={market}{code}&datalen={days}&scale=240&ma=no"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("gbk")
    except: return None
    if not raw or raw.strip() == "null": return None
    try: data = json.loads(raw)
    except: return None
    if not isinstance(data, list) or len(data) < N: return None
    valid = [d for d in data if float(d.get("volume", 0)) > 0]
    if len(valid) < N: return None
    print(f"  [OK] {code}: {len(valid)} 条")
    return valid

def calc_score(closes):
    c = closes[-N:]; y = [math.log(x) for x in c]; x = list(range(N))
    n = len(x); sx = sum(x); sy = sum(y); sxx = sum(xi*xi for xi in x)
    sxy = sum(x[i]*y[i] for i in range(n))
    denom = n*sxx - sx*sx
    if denom == 0: return 0
    slope = (n*sxy - sx*sy)/denom; intercept = (sy - slope*sx)/n
    annual = math.exp(slope*TRADING_DAYS)-1
    y_pred = [slope*xi+intercept for xi in x]; ym = sum(y)/len(y)
    ssr = sum((y[i]-y_pred[i])**2 for i in range(len(y)))
    sst = sum((yi-ym)**2 for yi in y)
    r2 = 1-ssr/sst if sst>0 else 0
    return annual*r2

def calc_vol20(all_data):
    vols = []
    for code in VOL_CORE_CODES:
        d = all_data.get(code)
        if not d or len(d)<VOL_WINDOW: continue
        p = [float(x["close"]) for x in d[-VOL_WINDOW:]]
        r = [(p[i]-p[i-1])/p[i-1] for i in range(1,len(p))]
        m = sum(r)/len(r)
        v = sum((ri-m)**2 for ri in r)/len(r)
        vols.append(math.sqrt(v)*math.sqrt(TRADING_DAYS)*100)
    return sum(vols)/len(vols) if vols else 0

def run():
    all_data = {}; results = []; newest_date = None
    for etf in ETF_LIST:
        raw = fetch_klines(etf["code"], etf["market"])
        if raw is None:
            results.append({"code":etf["code"],"name":etf["name"],"score":0,"valid":False})
            continue
        all_data[etf["code"]] = raw
        closes = [float(d["close"]) for d in raw]
        last = raw[-1]["day"]
        if newest_date is None or last > newest_date: newest_date = last
        sc = calc_score(closes)
        results.append({"code":etf["code"],"name":etf["name"],"score":sc,"valid":True,"price":closes[-1],"date":last})
    results.sort(key=lambda r: r["score"], reverse=True)
    vol20 = calc_vol20(all_data)
    best = results[0] if results else None
    return {"results":results,"vol20":vol20,"best":best,"triggered":vol20>=VOL_THRESHOLD,"newest_date":newest_date}

def main():
    print("="*45)
    print("  ETF轮动选股器  "+datetime.now(CN_TZ).strftime("%m-%d %H:%M"))
    print("="*45)
    data = run()
    for i, r in enumerate(data["results"]):
        icon = ["1","2","3"][i] if i<3 else "  "
        sc = f"{r['score']:.4f}" if r.get("valid",True) else "N/A"
        print(f"  {icon} {r['name']:<8} {sc}")
    print("-"*45)
    print(f"  vol20: {data['vol20']:.1f}%  {'触发' if data['triggered'] else '正常'}")
    if data["triggered"]:
        print(f"  仓位: 半仓 {data['best']['name']} + 50% 逆回购")
    else:
        print(f"  仓位: 满仓 {data['best']['name']}")
    print("-"*45)
    print("  明日 09:30 开盘执行")
    print("  若降仓: 14:50 前买 GC001 / R-001")
    print("="*45)

if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
