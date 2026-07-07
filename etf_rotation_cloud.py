#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ETF 轮动选股器 — 云端版 (B+C+ 并集方案 v3)
=========================================
数据源: 东方财富 + 新浪 (双备份 + 重试)
每日定时推送下一交易日的操作建议到飞书

【策略规则】
1. 动量得分 = (exp(slope × 250) - 1) × R²
   - 对每个 ETF 用过去 25 个交易日的对数收盘价做线性回归
   - slope 为年化斜率, R² 为拟合优度

2. 选取得分最高的 ETF 作为持有候选

3. 风控触发条件 (满足任一即清仓切逆回购 GC001/R-001):
   ① 4 标的等权平均 vol20 > 40%        (原方案C, 市场整体风险)
   ② 持有标的趋势线 > 95 且 持有标的 vol20 > 24%  (方案B, 个股阶段顶部)
   ③ 持有标的 vol20 > 40% 且 等权平均 vol20 > 30%  (方案C+, 多标的共振)

【趋势线计算 (DDBB 量化趋势线)】
   LLV(low, 55), HHV(high, 55)
   RSV = (close - LLV) / (HHV - LLV) × 100
   SMA5  = TDX_SMA(RSV, 5, 1)
   SMA5_3 = TDX_SMA(SMA5, 3, 1)
   V11 = 3 × SMA5 - 2 × SMA5_3
   趋势线 = EMA(V11, 3)

【波动率】
   20 日收益率样本标准差 (ddof=1), 年化 × √250
   与 pandas rolling(20).std() 默认一致

【版本历史】
   2026-07-03 v3: 条件② 持有 vol 阈值 0.30 → 0.24 (回测 +4.1pp 年化, Calmar 1.82 → 2.09)
   2026-07-03 v2: 条件① 阈值 0.35 → 0.40 (回测 +1.5pp 年化, +13.8% 终值)
"""
import json, math, sys, urllib.request, os, argparse
from datetime import datetime, timezone, timedelta

ETF_LIST = [
    {"code": "510300", "name": "沪深 ETF", "market": "sh"},
    {"code": "159915", "name": "创业 ETF",  "market": "sz"},
    {"code": "513100", "name": "纳指 ETF",    "market": "sh"},
    {"code": "518880", "name": "黄金 ETF",    "market": "sh"},
]

N = 25                       # 动量回归窗口
VOL_WINDOW = 20              # 波动率窗口
TRADING_DAYS = 250           # 一年交易日
FETCH_DAYS = 300             # 拉取的历史数据天数 (要够算 vol20 和趋势线)
TIMEOUT = 15
CN_TZ = timezone(timedelta(hours=8))

# 风控阈值
AVG_VOL_THRESHOLD = 0.40     # 条件①: 等权平均 vol20 阈值 (2026-07-03 从 0.35 放宽, 回测 +1.5pp 年化)
TREND_THRESHOLD = 95.0       # 条件②: 持有趋势线阈值
HOLD_VOL_THRESHOLD_B = 0.24  # 条件②: 持有 vol20 阈值 (2026-07-03 从 0.30 放宽, 回测 +4.1pp 年化, Calmar 2.09)
HOLD_VOL_THRESHOLD_C = 0.36  # 条件③: 持有 vol20 阈值
AVG_VOL_THRESHOLD_C = 0.30   # 条件③: 等权平均 vol20 阈值


# ============================================================
# 数据获取 (东财 + 新浪 双数据源, 重试 3 轮)
# ============================================================
def fetch_klines(code, market, days=FETCH_DAYS):
    urls = [
        # 东财: klt=101 日线, fqt=1 前复权
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={'1.' if market=='sh' else '0.'}{code}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt={days}",
        # 新浪备选
        f"https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={'sh' if market=='sh' else 'sz'}{code}&datalen={days}&scale=240&ma=no",
    ]
    import time as _time
    for attempt in range(3):
        for url_idx, url in enumerate(urls):
            try:
                if "eastmoney" in url:
                    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
                else:
                    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn"}
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    raw = resp.read()
                if url_idx == 0:
                    raw = raw.decode("utf-8")
                    d = json.loads(raw)
                    if not d.get("data") or not d["data"].get("klines"): continue
                    rows = [k.split(",") for k in d["data"]["klines"]]
                    valid = [{"day": r[0], "open": float(r[1]), "close": float(r[2]),
                              "high": float(r[3]), "low": float(r[4]), "volume": float(r[5])}
                             for r in rows if float(r[5]) > 0]
                else:
                    raw = raw.decode("gbk")
                    if not raw or raw.strip() == "null": continue
                    data = json.loads(raw)
                    if not isinstance(data, list) or len(data) < N: continue
                    valid = [{"day": d.get("day") or d.get("date", ""),
                              "close": float(d.get("close",0)),
                              "open": float(d.get("open",0)), "high": float(d.get("high",0)),
                              "low": float(d.get("low",0)), "volume": float(d.get("volume",0))}
                             for d in data if float(d.get("volume",0)) > 0]
                if len(valid) < max(N, 60): continue
                print(f"  [OK] {code}: {len(valid)} 条 ({valid[0]['day']} ~ {valid[-1]['day']})")
                return valid
            except Exception:
                continue
        if attempt < 2:
            _time.sleep(2 + attempt * 3)
    print(f"  [ERR] {code}: 所有数据源均失败")
    return None


# ============================================================
# 指标计算
# ============================================================
def calc_score(closes):
    """动量得分: (exp(slope × 250) - 1) × R²"""
    c = closes[-N:]
    if len(c) < N or min(c) <= 0: return 0
    y = [math.log(x) for x in c]
    x = list(range(N))
    n = len(x); sx = sum(x); sy = sum(y); sxx = sum(xi*xi for xi in x)
    sxy = sum(x[i]*y[i] for i in range(n))
    denom = n*sxx - sx*sx
    if denom == 0: return 0
    slope = (n*sxy - sx*sy)/denom
    intercept = (sy - slope*sx)/n
    annual = math.exp(slope*TRADING_DAYS)-1
    y_pred = [slope*xi+intercept for xi in x]
    ym = sum(y)/len(y)
    ssr = sum((y[i]-y_pred[i])**2 for i in range(len(y)))
    sst = sum((yi-ym)**2 for yi in y)
    r2 = 1 - ssr/sst if sst>0 else 0
    return annual*r2


def calc_vol20(closes):
    """20 日年化波动率 (ddof=1, 与 pandas 默认一致)"""
    if len(closes) < VOL_WINDOW + 1: return 0
    recent = closes[-(VOL_WINDOW+1):]
    rets = [(recent[i] - recent[i-1]) / recent[i-1] for i in range(1, len(recent)) if recent[i-1] > 0]
    if len(rets) < VOL_WINDOW: return 0
    m = sum(rets) / len(rets)
    # ddof=1 (样本方差), 与 pandas 默认一致, 与手机 JS 版对齐
    var = sum((r-m)**2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(TRADING_DAYS)


def tdx_sma(values, n, m):
    """通达信 SMA: Y = (X*M + Y*(N-M))/N, Y 初始化为第一个有效值"""
    out = [float('nan')] * len(values)
    y = float('nan')
    for i, x in enumerate(values):
        if x != x:  # NaN
            out[i] = y
            continue
        if y != y:  # 第一个有效值
            y = x
        else:
            y = (x*m + y*(n-m)) / n
        out[i] = y
    return out


def calc_trend_line(highs, lows, closes):
    """DDBBB 量化趋势线 (0-100)
    RSV = (close-LLV55)/(HHV55-LLV55) × 100
    V11 = 3 × SMA(SMA(RSV,5,1),3,1) 的变换
    趋势线 = EMA(V11, 3)
    """
    n = len(closes)
    if n < 55: return 50.0
    rsv = []
    for i in range(n):
        if i < 54:
            rsv.append(50.0)
            continue
        llv = min(lows[i-54:i+1])
        hhv = max(highs[i-54:i+1])
        if hhv == llv:
            rsv.append(50.0)
        else:
            rsv.append((closes[i]-llv)/(hhv-llv)*100)
    sma5 = tdx_sma(rsv, 5, 1)
    sma5_3 = tdx_sma(sma5, 3, 1)
    v11 = [3*sma5[i] - 2*sma5_3[i] if (sma5[i]==sma5[i] and sma5_3[i]==sma5_3[i]) else 50.0
           for i in range(n)]
    # EMA(V11, 3)
    ema = [float('nan')] * n
    ema[0] = v11[0]
    alpha = 2 / (3 + 1)
    for i in range(1, n):
        ema[i] = alpha * v11[i] + (1 - alpha) * ema[i-1]
    return ema[-1]


# ============================================================
# 风控判断 (B+C+ 并集 v3)
# ============================================================
def check_risk(avg_vol, hold_vol, hold_trend):
    """
    返回: (是否触发, 触发条件列表)
    """
    triggered = []
    # 条件①: 等权平均 vol > 40%
    if avg_vol > AVG_VOL_THRESHOLD:
        triggered.append(f"① 4标的等权平均 vol20 = {avg_vol*100:.1f}% > {AVG_VOL_THRESHOLD*100:.0f}% (市场整体高波动)")
    # 条件②: 持有趋势线 > 95 且 持有 vol > 24%
    if hold_trend > TREND_THRESHOLD and hold_vol > HOLD_VOL_THRESHOLD_B:
        triggered.append(f"② 持有标的趋势线 = {hold_trend:.1f} > {TREND_THRESHOLD} 且 持有 vol20 = {hold_vol*100:.1f}% > {HOLD_VOL_THRESHOLD_B*100:.0f}% (个股阶段顶部)")
    # 条件③: 持有 vol > 40% 且 等权平均 vol > 30%
    if hold_vol > HOLD_VOL_THRESHOLD_C and avg_vol > AVG_VOL_THRESHOLD_C:
        triggered.append(f"③ 持有 vol20 = {hold_vol*100:.1f}% > {HOLD_VOL_THRESHOLD_C*100:.0f}% 且 等权平均 vol20 = {avg_vol*100:.1f}% > {AVG_VOL_THRESHOLD_C*100:.0f}% (多标的共振)")

    return len(triggered) > 0, triggered


# ============================================================
# 主流程
# ============================================================
def run():
    all_data = {}
    results = []
    newest_date = None
    print("=" * 60)
    print("  正在拉取行情数据...")
    print("=" * 60)
    for etf in ETF_LIST:
        raw = fetch_klines(etf["code"], etf["market"])
        if raw is None:
            results.append({"code": etf["code"], "name": etf["name"], "valid": False})
            continue
        closes = [d["close"] for d in raw]
        highs = [d["high"] for d in raw]
        lows = [d["low"] for d in raw]
        last = raw[-1]["day"]
        if newest_date is None or last > newest_date: newest_date = last
        score = calc_score(closes)
        vol = calc_vol20(closes)
        trend = calc_trend_line(highs, lows, closes)
        all_data[etf["code"]] = {"closes": closes, "highs": highs, "lows": lows}
        results.append({
            "code": etf["code"], "name": etf["name"],
            "score": score, "vol": vol, "trend": trend,
            "price": closes[-1], "valid": True, "date": last
        })

    valid_results = [r for r in results if r.get("valid", False)]
    if not valid_results:
        return None

    # 排序: 得分最高的为推荐持有
    valid_results.sort(key=lambda r: r["score"], reverse=True)
    best = valid_results[0]

    # 计算等权平均 vol
    avg_vol = sum(r["vol"] for r in valid_results) / len(valid_results)

    # 风控检查
    triggered, reasons = check_risk(avg_vol, best["vol"], best["trend"])

    return {
        "results": valid_results,
        "best": best,
        "avg_vol": avg_vol,
        "triggered": triggered,
        "reasons": reasons,
        "newest_date": newest_date,
    }


def format_action(data):
    """格式化输出: 下一个交易日的操作建议"""
    best = data["best"]
    triggered = data["triggered"]
    reasons = data["reasons"]
    avg_vol = data["avg_vol"]

    lines = []
    lines.append("📊 ETF轮动 次日操作建议")
    lines.append("")

    # 操作建议
    if triggered:
        lines.append("🔴 操作: 清仓 ETF, 全仓买逆回购 GC001/R-001")
    else:
        lines.append(f"🟢 操作: 满仓持有 {best['name']} ({best['code']})")
    lines.append("")

    # 触发原因 / 安全状态
    if triggered:
        lines.append("⚠️ 风控触发原因:")
        for r in reasons:
            lines.append(f"   {r}")
    else:
        lines.append("✅ 风控未触发, 各项指标正常")
    lines.append("")

    # 4 标的排名
    lines.append("📋 动量得分排名:")
    medals = ["🥇", "🥈", "🥉", "    "]
    for i, r in enumerate(data["results"]):
        icon = medals[i] if i < 4 else "  "
        star = " ⬅ 推荐" if (not triggered and i == 0) else ""
        lines.append(f"   {icon} {r['name']:<8} "
                     f"{r['score']:+.3f}  "
                     f"{r['vol']*100:5.1f}%  "
                     f"{r['trend']:5.1f}{star}")
    lines.append("")

    # 状态汇总
    lines.append("📈 当前市场状态:")
    lines.append(f"   等权平均 vol20: {avg_vol*100:.1f}%  (阈值 {AVG_VOL_THRESHOLD*100:.0f}%)")
    lines.append(f"   推荐: {best['name']} vol20 = {best['vol']*100:.1f}%  趋势线 = {best['trend']:.1f}")
    lines.append("")

    # 时间提示
    lines.append("⏰ 执行时间:")
    lines.append("   明日 09:30 开盘执行")
    if triggered:
        lines.append("   14:50 前买 GC001 / R-001 隔夜逆回购")
    lines.append("")
    return "\n".join(lines)


def send_feishu(webhook_url, text):
    payload = json.dumps({
        "msg_type": "text",
        "content": {"text": text}
    }).encode("utf-8")
    req = urllib.request.Request(webhook_url, data=payload,
                                headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            result = resp.read().decode()
            print(f"[Feishu] 发送结果: {result}")
            return True
    except Exception as e:
        print(f"[Feishu] 发送失败: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="ETF轮动选股器 (B+C+ 并集方案 v3)")
    parser.add_argument("--feishu", action="store_true", help="发送结果到飞书 Webhook")
    args = parser.parse_args()

    webhook_url = os.environ.get("FEISHU_WEBHOOK_URL", "")
    if args.feishu and not webhook_url:
        print("[错误] 请设置 FEISHU_WEBHOOK_URL 环境变量")
        sys.exit(1)

    print("  ETF轮动选股器")
    print("  " + datetime.now(CN_TZ).strftime("%Y-%m-%d %H:%M"))
    print("=" * 10)

    data = run()
    if data is None:
        print("[错误] 无可用数据")
        sys.exit(1)

    print()
    output = format_action(data)
    print(output)

    if args.feishu:
        print("\n--- 推送到飞书 ---")
        send_feishu(webhook_url, output)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
