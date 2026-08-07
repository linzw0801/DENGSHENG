#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ETF 轮动选股器 — 云端版 (B+C+ 并集方案 v4)
=========================================
数据源: 东方财富 + 新浪 (双备份 + 重试)
推送通道: 飞书 Webhook + QQ 邮箱 (HTML 邮件)

【策略规则】
1. 动量得分 = (exp(slope × 250) - 1) × R²
2. 选取得分最高的 ETF 作为持有候选
3. 风控触发条件 (满足任一即清仓切逆回购 GC001/R-001):
   ① 4 标的等权平均 vol20 > 40%
   ② 持有标的趋势线 > 95 且 持有标的 vol20 > 24%
   ③ 持有标的 vol20 > 40% 且 等权平均 vol20 > 30%
   ④ 信号/持仓为纳指 且 纳指当日开盘较昨收跳空 ≤ -5% (纳指隔夜黑天鹅清仓)

【版本历史】
   2026-08-06 v9: 飞书卡片风控描述优化 - 三行独立展示, 每行完整条件
   2026-08-06 v10: 新增风控条件④ 纳指单日跳空清仓 (开盘较昨收≤-5%→清仓+冷却3日), 仅纳指
                  (原 fields 并排+缩写难读, 改为与邮件一致的全描述)
   2026-08-05 v8: 简化 - 移除纳指溢价优化逻辑, 信号是纳指直接买 513100
                  (对账结论: 含风控后买最低溢价无显著优势, 简化执行)
   2026-08-05 v7: 纳指进场日给出具体买入标的 - 查询全部12只场内纳指ETF溢价
   2026-08-05 v6: 纳指ETF(513100)溢价监控 - 每日推送显示当前溢价率
   2026-07-14 v5: 数据新鲜度检查 - 工作日 15:30 后必须拿到今天数据，否则重试 5 次
                  每次 90s 间隔；非工作日/盘中不严格检查；失败则工作流 exit(1)
   2026-07-09 v4: 增加 QQ 邮箱 HTML 邮件推送 (--email), HTML 模板优化排版
   2026-07-03 v3: 条件② 持有 vol 阈值 0.30 → 0.24
   2026-07-03 v2: 条件① 阈值 0.35 → 0.40
"""
import json, math, sys, urllib.request, os, argparse, time, smtplib, re
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr, formatdate
from datetime import datetime, timezone, timedelta

ETF_LIST = [
    {"code": "510300", "name": "沪深 ETF", "market": "sh"},
    {"code": "159915", "name": "创业 ETF",  "market": "sz"},
    {"code": "513100", "name": "纳指 ETF",    "market": "sh"},
    {"code": "518880", "name": "黄金 ETF",    "market": "sh"},
]

N = 25
VOL_WINDOW = 20
TRADING_DAYS = 250
FETCH_DAYS = 300
TIMEOUT = 15
CN_TZ = timezone(timedelta(hours=8))

# 数据新鲜度检查参数
FRESHNESS_RETRY_MAX = 5      # 最多重试次数（含首次）
FRESHNESS_RETRY_WAIT = 90    # 每次重试间隔秒数
FRESHNESS_MIN_HOUR = 15      # 15:00 之后才要求"今天数据"
FRESHNESS_MIN_MINUTE = 30    # 15:30 之后才要求（券商结算延迟）


AVG_VOL_THRESHOLD = 0.40
TREND_THRESHOLD = 95.0
HOLD_VOL_THRESHOLD_B = 0.24
HOLD_VOL_THRESHOLD_C = 0.40
AVG_VOL_THRESHOLD_C = 0.30

# ④ 纳指单日跳空清仓 (历史回测 2014-2026: 纳指-only 版 年化+49.6%/Sharpe1.91, 远优于全资产版)
# 仅纳指: 纳指跳空后隔夜惯性续跌概率高; 黄金跳空多为一过性新闻(假摔), 故不纳入。
# 触发后清仓转逆回购 + 冷却3交易日 (与 news_advisor 三条件互补, 覆盖纳指隔夜黑天鹅)
GAP_TRIGGER_ASSET = "513100"
GAP_TRIGGER_PCT = 0.05


# ============================================================
# 数据新鲜度检查 (避免取到昨天/节前数据)
# ============================================================
def is_after_market_close():
    """判断当前北京时间是否已过 15:30 (收盘结算后)。"""
    now = datetime.now(CN_TZ)
    # weekday(): 0=周一 ... 6=周日
    if now.weekday() >= 5:  # 周六周日
        return False
    cutoff = now.replace(hour=FRESHNESS_MIN_HOUR, minute=FRESHNESS_MIN_MINUTE, second=0, microsecond=0)
    return now >= cutoff


def should_require_today_data():
    """是否应该要求最新数据是今天。

    工作日 15:30 之后才要求今天数据。
    周末、节假日（无盘中数据更新）、盘中 15:30 之前 都不严格要求。
    """
    return is_after_market_close()


def fetch_realtime_quote(code, market):
    """获取实时报价日期，用于和 K 线最新日期比对。

    返回 quote_date 字符串 'YYYY-MM-DD' 或 None。
    新浪 hq.sinajs.cn 返回的 date 字段是当前报价日期。
    """
    symbol = ('sh' if market == 'sh' else 'sz') + code
    url = f"https://hq.sinajs.cn/list={symbol}"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://finance.sina.com.cn"
        })
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("gbk", errors="ignore")
        if not raw or "=" not in raw:
            return None
        # 格式: var hq_str_sh510300="name,open,prev_close,current,high,low,...,date,time,..."
        parts = raw.split("=", 1)[1].strip(" \t\r\n;\"").split(",")
        if len(parts) < 32:
            return None
        # 字段 30=日期 'YYYY-MM-DD', 31=时间 'HH:MM:SS'
        quote_date = parts[30].strip() if len(parts) > 30 else ""
        return quote_date if re.match(r"^\d{4}-\d{2}-\d{2}$", quote_date) else None
    except Exception:
        return None


def is_today_a_trading_day():
    """通过实时报价判断今天是否是交易日。

    若周末/节假日被触发，新浪报价里的 date 不会是今天。
    """
    qd = fetch_realtime_quote("510300", "sh")
    if not qd:
        return None  # 不确定
    today = datetime.now(CN_TZ).strftime("%Y-%m-%d")
    return qd == today



def fetch_klines(code, market, days=FETCH_DAYS):
    urls = [
        f"https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={'sh' if market=='sh' else 'sz'}{code}&datalen={days}&scale=240&ma=no",
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={'1.' if market=='sh' else '0.'}{code}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt={days}",
    ]
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
                if "eastmoney" in url:
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
                              "open": float(d.get("open",0)),
                              "high": float(d.get("high",0)),
                              "low": float(d.get("low",0)),
                              "volume": float(d.get("volume",0))}
                             for d in data if float(d.get("volume",0)) > 0]
                if len(valid) < max(N, 60): continue
                print(f"  [OK] {code}: {len(valid)} 条 ({valid[0]['day']} ~ {valid[-1]['day']})")
                return valid
            except Exception:
                continue
        if attempt < 2:
            time.sleep(2 + attempt * 3)
    print(f"  [ERR] {code}: 所有数据源均失败")
    return None


# ============================================================
# 指标计算
# ============================================================
def calc_score(closes):
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
    if len(closes) < VOL_WINDOW + 1: return 0
    recent = closes[-(VOL_WINDOW+1):]
    rets = [(recent[i] - recent[i-1]) / recent[i-1] for i in range(1, len(recent)) if recent[i-1] > 0]
    if len(rets) < VOL_WINDOW: return 0
    m = sum(rets) / len(rets)
    var = sum((r-m)**2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(TRADING_DAYS)


def tdx_sma(values, n, m):
    out = [float('nan')] * len(values)
    y = float('nan')
    for i, x in enumerate(values):
        if x != x:
            out[i] = y
            continue
        if y != y:
            y = x
        else:
            y = (x*m + y*(n-m)) / n
        out[i] = y
    return out


def calc_trend_line(highs, lows, closes):
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
    ema = [float('nan')] * n
    ema[0] = v11[0]
    alpha = 2 / (3 + 1)
    for i in range(1, n):
        ema[i] = alpha * v11[i] + (1 - alpha) * ema[i-1]
    return ema[-1]


# ============================================================
# 风控判断 (B+C+ 并集)
# ============================================================
def check_risk(avg_vol, hold_vol, hold_trend, best_code=None, best_open=None, best_prev_close=None):
    triggered = []
    if avg_vol > AVG_VOL_THRESHOLD:
        triggered.append("①")
    if hold_trend > TREND_THRESHOLD and hold_vol > HOLD_VOL_THRESHOLD_B:
        triggered.append("②")
    if hold_vol > HOLD_VOL_THRESHOLD_C and avg_vol > AVG_VOL_THRESHOLD_C:
        triggered.append("③")
    # ④ 纳指单日跳空清仓: 信号/持仓为纳指 且 当日开盘较昨收跳空≤-5% → 清仓
    if best_code == GAP_TRIGGER_ASSET and best_open is not None and best_prev_close:
        if best_open / best_prev_close - 1 <= -GAP_TRIGGER_PCT:
            triggered.append("④")
    return triggered


# ============================================================
# 主流程
# ============================================================
def run():
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
        results.append({
            "code": etf["code"], "name": etf["name"],
            "score": score, "vol": vol, "trend": trend,
            "price": closes[-1], "valid": True, "date": last,
            "open": raw[-1]["open"],
            "prev_close": raw[-2]["close"] if len(raw) >= 2 else None,
        })

    valid_results = [r for r in results if r.get("valid", False)]
    if not valid_results:
        return None

    # 数据一致性校验: 所有有效标的必须是最新交易日
    # (防止 4 标的日期不同步导致动量算错, 如黄金是08-07但纳指还是08-06)
    dates_set = set(r.get("date", "")[:10] for r in valid_results)
    if len(dates_set) > 1:
        newest = max(dates_set)
        lagging = [r["code"] for r in valid_results if r.get("date", "")[:10] != newest]
        print(f"[数据一致性] 4标的数据日期不一致: {dates_set}")
        print(f"[数据一致性] 滞后标的: {lagging} (最新为 {newest}), 返回 None 触发重试")
        return None

    valid_results.sort(key=lambda r: r["score"], reverse=True)
    best = valid_results[0]
    avg_vol = sum(r["vol"] for r in valid_results) / len(valid_results)
    triggered = check_risk(avg_vol, best["vol"], best["trend"],
                           best["code"], best.get("open"), best.get("prev_close"))

    return {
        "results": valid_results,
        "best": best,
        "avg_vol": avg_vol,
        "triggered": triggered,
        "newest_date": newest_date,
    }


# ============================================================
# 文本格式 (给飞书/Summary 用)
# ============================================================
def format_action(data):
    best = data["best"]
    triggered = data["triggered"]
    avg_vol = data["avg_vol"]
    is_risk = len(triggered) > 0

    lines = []
    lines.append("━" * 50)
    lines.append("📊 ETF轮动 次日操作建议")
    lines.append("━" * 50)
    lines.append("")

    if is_risk:
        lines.append("🔴 操作: 清仓 ETF, 全仓买逆回购 GC001/R-001")
    else:
        lines.append(f"🟢 操作: 满仓持有 {best['name']} ({best['code']})")
    lines.append("")

    lines.append(f"🛡️ 风控监测 ({len(triggered)}/4 触发):")
    nq = next((r for r in data["results"] if r["code"] == "513100"), None)
    nq_gap = (nq["open"] / nq["prev_close"] - 1) if (nq and nq.get("open") is not None and nq.get("prev_close")) else None
    nq_txt = f"{nq_gap*100:+.1f}%" if nq_gap is not None else "数据缺失"
    all_conditions = [
        ("①", "市场整体高波动", f"均 vol20 = {avg_vol*100:.1f}% (阈值 40%)", "①" in triggered),
        ("②", "个股阶段顶部",   f"趋势 {best['trend']:.1f} (阈值 95), 持有 vol {best['vol']*100:.1f}% (阈值 24%)", "②" in triggered),
        ("③", "多标的共振",     f"持有 vol {best['vol']*100:.1f}% (阈值 40), 均 vol {avg_vol*100:.1f}% (阈值 30%)", "③" in triggered),
        ("④", "纳指单日跳空",   f"纳指开盘跳空 {nq_txt} (阈值 -5%)", "④" in triggered),
    ]
    for cid, title, detail, on in all_conditions:
        icon = "🔴" if on else "⚪"
        lines.append(f"   {icon} {title}: {detail}  {'【触发】' if on else ''}")
    lines.append("")

    lines.append("📋 动量得分排名:")
    medals = ["🥇", "🥈", "🥉", "🏳️"]
    for i, r in enumerate(data["results"]):
        icon = medals[i]
        lines.append(f"   {icon} {r['name']:<8} "
                     f"得分 {r['score']:+.3f}  "
                     f"vol {r['vol']*100:5.1f}%  "
                     f"趋势 {r['trend']:5.1f}")
    lines.append("")

    lines.append("⏰ 执行时间:")
    lines.append("   明日 09:30 开盘执行")
    if is_risk:
        lines.append("   14:30-14:50 买 GC001 / R-001 隔夜逆回购")
    lines.append("")
    lines.append("━" * 50)
    return "\n".join(lines)


# ============================================================
# HTML 邮件生成
# ============================================================
def gauge_card(label, value_pct, threshold_pct, color):
    bar_width = min(100, value_pct / threshold_pct * 100) if threshold_pct > 0 else 0
    over = value_pct > threshold_pct
    bar_color = "#dc2626" if over else "#10b981"
    return f'''
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
          <tr><td style="padding:14px 16px;">
            <div style="font-size:10px;color:#6b7280;font-weight:700;letter-spacing:1.5px;">{label}</div>
            <div style="font-size:26px;font-weight:700;color:{color};margin:4px 0 2px 0;line-height:1.1;">{value_pct:.1f}%</div>
            <div style="font-size:11px;color:#9ca3af;">阈值 {threshold_pct:.0f}%</div>
            <div style="background:#e5e7eb;border-radius:2px;height:5px;margin-top:10px;overflow:hidden;">
              <div style="background:{bar_color};width:{bar_width:.0f}%;height:5px;border-radius:2px;"></div>
            </div>
          </td></tr>
        </table>'''


def ranking_row(rank, r):
    medals = ["🥇", "🥈", "🥉", "🏳️"]
    medal = medals[rank]
    score = r["score"]
    score_color = "#10b981" if score > 0 else "#9ca3af"
    # 趋势强度归一化: trend 值范围 0-100, 直接作为百分比
    trend_val = r["trend"]
    trend_norm = max(0, min(100, trend_val))
    # 趋势颜色: >80 红(过热), 50-80 橙(强势), 20-50 绿(中性), <20 灰(弱势)
    if trend_val >= 80:
        trend_bar_color = "#dc2626"
    elif trend_val >= 50:
        trend_bar_color = "#f59e0b"
    elif trend_val >= 20:
        trend_bar_color = "#10b981"
    else:
        trend_bar_color = "#9ca3af"
    return f'''
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:18px;">{medal}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">
            <div style="font-size:14px;font-weight:600;color:#1f2937;">{r["name"]}<span style="font-size:11px;color:#9ca3af;font-weight:400;margin-left:6px;">{r["code"]}</span></div>
          </td>
          <td align="right" style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">
            <div style="font-size:14px;font-weight:700;color:{score_color};font-family:Consolas,monospace;">{score:+.3f}</div>
          </td>
          <td align="right" style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;font-family:Consolas,monospace;">{r["vol"]*100:.1f}%</td>
          <td align="right" style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;font-family:Consolas,monospace;">{r["trend"]:.1f}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;width:120px;">
            <div style="background:#e5e7eb;border-radius:2px;height:6px;overflow:hidden;">
              <div style="background:{trend_bar_color};width:{trend_norm:.0f}%;height:6px;border-radius:2px;"></div>
            </div>
          </td>
        </tr>'''


def generate_html(data):
    best = data["best"]
    avg_vol = data["avg_vol"]
    triggered = data["triggered"]
    is_risk = len(triggered) > 0
    now = datetime.now(CN_TZ).strftime("%Y-%m-%d %H:%M")
    data_date = data["newest_date"]

    if is_risk:
        action_bg = "background:linear-gradient(135deg,#fef2f2 0%,#fee2e2 100%);border-left:4px solid #dc2626;"
        action_label_color = "#dc2626"
        action_title_color = "#991b1b"
        action_label = "操作建议"
        action_title = "🔴 清仓 ETF · 全仓逆回购 GC001/R-001"
    else:
        action_bg = "background:linear-gradient(135deg,#f0fdf4 0%,#dcfce7 100%);border-left:4px solid #10b981;"
        action_label_color = "#10b981"
        action_title_color = "#065f46"
        action_label = "操作建议"
        action_title = f"🟢 满仓持有 {best['name']} ({best['code']})"

    triggered_ids = set(triggered)
    nasdaq_res = next((r for r in data["results"] if r["code"] == "513100"), None)
    nq_gap = None
    if nasdaq_res and nasdaq_res.get("open") is not None and nasdaq_res.get("prev_close"):
        nq_gap = nasdaq_res["open"] / nasdaq_res["prev_close"] - 1
    nq_detail = (f"纳指开盘跳空 = <strong>{nq_gap*100:+.1f}%</strong>, 阈值 -5%"
                 if nq_gap is not None else "纳指开盘数据缺失")
    risk_defs = [
        {"id": "①", "title": "市场整体高波动", "subtitle": "等权平均 vol20 > 40%",
         "detail": f"4 标的等权平均 vol20 = <strong>{avg_vol*100:.1f}%</strong>, 阈值 40%"},
        {"id": "②", "title": "个股阶段顶部", "subtitle": "持有趋势线 > 95 且 持有 vol20 > 24%",
         "detail": f"持有 <strong>{best['name']}</strong> 趋势线 = <strong>{best['trend']:.1f}</strong> (阈值 95), 持有 vol20 = <strong>{best['vol']*100:.1f}%</strong> (阈值 24%)"},
        {"id": "③", "title": "多标的共振", "subtitle": "持有 vol20 > 40% 且 等权平均 vol20 > 30%",
         "detail": f"持有 <strong>{best['name']}</strong> vol20 = <strong>{best['vol']*100:.1f}%</strong> (阈值 40%), 等权平均 vol20 = <strong>{avg_vol*100:.1f}%</strong> (阈值 30%)"},
        {"id": "④", "title": "纳指单日跳空清仓", "subtitle": "信号/持仓为纳指 且 开盘跳空≤-5%",
         "detail": nq_detail},
    ]

    risk_cards = ""
    for r in risk_defs:
        is_on = r["id"] in triggered_ids
        if is_on:
            bg = "background:#fef2f2;border:1px solid #fecaca;"
            label_color = "#dc2626"
            title_color = "#991b1b"
            detail_color = "#7f1d1d"
            badge = '<span style="background:#dc2626;color:white;font-size:9px;padding:2px 6px;border-radius:8px;margin-left:6px;font-weight:700;">触发</span>'
            icon = "🔴"
        else:
            bg = "background:#f9fafb;border:1px solid #e5e7eb;"
            label_color = "#9ca3af"
            title_color = "#6b7280"
            detail_color = "#9ca3af"
            badge = '<span style="background:#e5e7eb;color:#6b7280;font-size:9px;padding:2px 6px;border-radius:8px;margin-left:6px;font-weight:600;">未触发</span>'
            icon = "⚪"

        risk_cards += f'''
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="{bg}border-radius:6px;margin-bottom:6px;">
          <tr><td style="padding:9px 14px;">
            <div style="font-size:12px;font-weight:700;color:{title_color};line-height:1.3;">
              <span style="font-size:13px;margin-right:4px;">{icon}</span>{r['title']}{badge}
            </div>
            <div style="font-size:10px;color:{label_color};margin-top:2px;font-family:Consolas,monospace;">{r['subtitle']}</div>
            <div style="font-size:11px;color:{detail_color};margin-top:4px;line-height:1.4;padding-top:4px;border-top:1px dashed {('rgba(220,38,38,0.2)' if is_on else '#e5e7eb')};">{r['detail']}</div>
          </td></tr>
        </table>'''

    risk_html = f'''
    <tr><td style="padding:18px 32px 0 32px;">
      <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:1.5px;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">🛡️ 风控监测 <span style="font-size:12px;color:#dc2626;font-weight:700;background:#fef2f2;padding:2px 8px;border-radius:8px;margin-left:6px;">{len(triggered_ids)}/4 触发</span></div>
      {risk_cards}
    </td></tr>'''

    ranking_rows = ""
    for i, r in enumerate(data["results"]):
        ranking_rows += ranking_row(i, r)

    avg_vol_color = "#dc2626" if avg_vol > AVG_VOL_THRESHOLD else "#10b981"
    hold_vol_color = "#dc2626" if best["vol"] > HOLD_VOL_THRESHOLD_C else ("#f59e0b" if best["vol"] > HOLD_VOL_THRESHOLD_B else "#10b981")
    trend_color = "#dc2626" if best["trend"] > TREND_THRESHOLD else "#10b981"

    avg_vol_card = gauge_card("等权平均 VOL20", avg_vol*100, AVG_VOL_THRESHOLD*100, avg_vol_color)
    hold_vol_card = gauge_card(f"持有 VOL20 · {best['name']}", best["vol"]*100, HOLD_VOL_THRESHOLD_C*100, hold_vol_color)
    trend_card = gauge_card(f"持有趋势线 · {best['name']}", best["trend"], TREND_THRESHOLD, trend_color)

    html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:20px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.06);">

      <tr><td style="background:linear-gradient(135deg,#1e3a8a 0%,#3730a3 50%,#4338ca 100%);padding:22px 32px;">
        <div style="font-size:11px;color:#a5b4fc;letter-spacing:2.5px;font-weight:600;">ETF ROTATION · DAILY REPORT</div>
        <div style="font-size:21px;font-weight:700;color:#ffffff;margin-top:5px;letter-spacing:0.5px;">📊 ETF 轮动 次日操作建议</div>
        <div style="font-size:12px;color:#c7d2fe;margin-top:6px;">数据日期 <strong style="color:#fff;">{data_date}</strong> · 生成于 {now}</div>
      </td></tr>

      <tr><td style="padding:16px 32px 0 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="{action_bg}">
          <tr><td style="padding:12px 16px;">
            <div style="font-size:9px;color:{action_label_color};font-weight:700;letter-spacing:2px;margin-bottom:2px;">{action_label}</div>
            <div style="font-size:16px;font-weight:700;color:{action_title_color};line-height:1.3;">{action_title}</div>
          </td></tr>
        </table>
      </td></tr>

      {risk_html}

      <tr><td style="padding:18px 32px 0 32px;">
        <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:1.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">📋 动量得分排名</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="36" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">#</td>
            <td style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">标的</td>
            <td align="right" width="70" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">得分</td>
            <td align="right" width="55" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">vol20</td>
            <td align="right" width="45" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">趋势</td>
            <td width="120" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">趋势强度</td>
          </tr>
          {ranking_rows}
        </table>
      </td></tr>

      <tr><td style="padding:18px 32px 0 32px;">
        <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:1.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">📈 市场状态监控</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="33.33%" valign="top" style="padding-right:4px;">{avg_vol_card}</td>
            <td width="33.33%" valign="top" style="padding:0 4px;">{hold_vol_card}</td>
            <td width="33.33%" valign="top" style="padding-left:4px;">{trend_card}</td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
        <div style="font-size:11px;color:#6b7280;line-height:1.7;">
          <strong style="color:#374151;">📊 历史业绩</strong> (2014-2026, 12.5 年)<br>
          年化 <strong style="color:#1e3a8a;">+43.5%</strong> · 夏普 <strong>1.82</strong> · 最大回撤 <strong style="color:#dc2626;">-20.8%</strong> · Calmar <strong>2.09</strong> · 年均清仓 <strong>22 天</strong><br>
          <br>
          <strong style="color:#b45309;">⚠️ 纪律</strong><br>
          • 信号机械执行,不做主观判断<br>
          • 触发即清仓,风控消失再进场<br>
          • 12.5 年回测全部正收益,但历史不代表未来
        </div>
      </td></tr>

      %THEO_ROW%
      %NEWS_ROW%

    </table>
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
      <tr><td align="center" style="font-size:10px;color:#9ca3af;padding:4px 0;">
        ETF 动量轮动 v4 · B+C+ 并集方案 · 由 GitHub Actions 自动推送
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>'''
    # 理论账户行
    theo_row = ""
    theo = data.get('theoretical')
    if theo:
        theo_row = f'''
      <tr><td style="padding:12px 32px;background:#f0fdf4;border-top:1px solid #e5e7eb;">
        <div style="font-size:12px;font-weight:700;color:#065f46;">💰 理论账户 (2026-07-07 进场 5 万)</div>
        <div style="font-size:18px;font-weight:700;color:#047857;margin:4px 0;">{theo['equity']:,.0f} 元 <span style="font-size:13px;color:#059669;">({theo['total_ret']*100:+.2f}%)</span></div>
        <div style="font-size:11px;color:#6b7280;">当前持仓: {theo['hold']} · 数据至 {theo['last_date']} · 按你的费率(万0.5免5+逆回购1折)</div>
      </td></tr>'''
    html = html.replace('%THEO_ROW%', theo_row)
    news_row = ""
    news = data.get('news')
    if news and not news.get('error'):
        sev = news.get('overall', {}).get('severity', 0)
        t3 = news.get('three_condition', {})
        rel = news.get('relevant_news', [])
        lines = [f"📰 新闻判断 (风险 {sev}/5, {news.get('news_count',0)} 条快讯)"]
        if t3.get('hit'):
            lines.append(f"🔴 三条件命中 → 建议考虑清仓! ({t3.get('reason','')})")
        elif rel:
            lines.append(f"⚪ {t3.get('reason','未命中三条件')}")
        for n in rel[:3]:
            lines.append(f"{'🔴'*n.get('severity',0)} [{n.get('direction_name','?')}/{n.get('impact','')}] {n.get('text','')[:36]}")
        if not rel and not t3.get('hit'):
            lines.append("✅ 今日无重大风险新闻, 按信号操作")
        news_row = f'''
      <tr><td style="padding:12px 32px;background:#fffbeb;border-top:1px solid #e5e7eb;">
        <div style="font-size:12px;font-weight:700;color:#92400e;">📰 新闻判断</div>
        <div style="font-size:11px;color:#78350f;line-height:1.6;margin-top:4px;">{chr(10).join(lines)}</div>
      </td></tr>'''
    html = html.replace('%NEWS_ROW%', news_row)

    return html


# ============================================================
# 图表生成 (matplotlib → base64 → 嵌入邮件HTML)
# ============================================================
def generate_charts(data):
    """生成动量得分趋势图和近30日涨跌幅图，返回(base64_trend, base64_mini)"""
    import io, base64
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import numpy as np
    except ImportError:
        print("[图表] matplotlib 未安装，跳过图表生成")
        return None, None

    etf_map = {
        "510300": {"name": "沪深300", "color": "#2196F3"},
        "159915": {"name": "创业板",   "color": "#e74c3c"},
        "513100": {"name": "纳指ETF", "color": "#FF9800"},
        "518880": {"name": "黄金ETF", "color": "#FFD700"},
    }
    codes = list(etf_map.keys())
    markets = {"510300":"sh","159915":"sz","513100":"sh","518880":"sh"}

    # 用和 run() 相同的 fetch_klines 函数拉取数据（带重试+双数据源）
    print("[图表] 拉取数据生成图表...")
    raw_data = {}
    for code in codes:
        market = markets[code]
        klines = fetch_klines(code, market, days=200)
        if klines and len(klines) >= 60:
            raw_data[code] = {
                "dates": [x["day"] for x in klines],
                "close": np.array([x["close"] for x in klines]),
                "open":  np.array([x["open"] for x in klines]),
                "high":  np.array([x["high"] for x in klines]),
                "low":   np.array([x["low"] for x in klines]),
            }
            print(f"  [图表] {code}: {len(klines)} 条")
        else:
            print(f"  [图表] {code}: 数据不足")
            continue

    if len(raw_data) < 2:
        print("[图表] 数据不足，跳过图表")
        return None, None

    # 取交集日期
    all_dates = sorted(set.intersection(*[set(raw_data[c]["dates"]) for c in raw_data]))
    if len(all_dates) < 30:
        return None, None

    # Ubuntu/GitHub Actions 无 SimHei/YaHei，动态注册可用中文字体
    import matplotlib.font_manager as fm
    # 动态检测或下载中文字体
    # 先检查系统是否存在中文字体
    cjk_candidates = [
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    ]
    font_path = None
    for fp in cjk_candidates:
        if os.path.exists(fp):
            font_path = fp
            break
    
    if not font_path:
        # 下载文泉驿等宽字体（~3MB，GitHub Actions 下载约3秒）
        font_url = "https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/03_NotoSansCJKsc.zip"
        # 改用更小的直接ttf文件
        font_url = "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"
        local_font = '/tmp/NotoSansCJKsc-Regular.otf'
        if not os.path.exists(local_font):
            try:
                print("[字体] 下载中文字体...")
                urllib.request.urlretrieve(font_url, local_font)
                font_path = local_font
                print("[字体] 下载完成")
            except Exception as e:
                print(f"[字体] 下载失败: {e}")
    
    if font_path:
        fm.fontManager.addfont(font_path)
        font_name = os.path.basename(font_path).rsplit('.',1)[0]
        # OTF 文件的字体名规范
        if 'NotoSansCJKsc' in font_path:
            font_name = 'Noto Sans CJK SC'
        font_list = [font_name, 'SimHei', 'Microsoft YaHei', 'DejaVu Sans']
    else:
        font_list = ['SimHei', 'Microsoft YaHei', 'DejaVu Sans']
    plt.rcParams['font.sans-serif'] = font_list
    plt.rcParams['axes.unicode_minus'] = False

    # 手机适配：增大字体，提高dpi
    MOBILE_FONT = 11   # 基础字号（手机友好）
    MOBILE_LABEL = 10  # 标签字号
    MOBILE_TITLE = 14  # 标题字号
    MOBILE_LEGEND = 10 # 图例字号
    MOBILE_TICK = 8    # 坐标轴刻度字号
    
    # ----- 图1: 动量得分 & vol20 趋势（近60日） -----
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), gridspec_kw={'height_ratios': [2, 1]})

    n_days = min(60, len(all_dates))
    plot_dates = all_dates[-n_days:]
    x_idx = np.arange(len(plot_dates))

    ax = axes[0]
    for code in raw_data:
        dm = {raw_data[code]["dates"][i]: i for i in range(len(raw_data[code]["dates"]))}
        vals = []
        for d in plot_dates:
            idx = dm.get(d)
            if idx is not None and idx >= 25:
                c_all = raw_data[code]["close"][:idx+1]
                c = c_all[-25:]
                if min(c) > 0:
                    y = np.log(c); x = np.arange(25.)
                    sx,sy,sxx,sxy = x.sum(),y.sum(),(x*x).sum(),(x*y).sum()
                    denom = 25*sxx-sx*sx
                    if denom != 0:
                        s = (25*sxy-sx*sy)/denom
                        yr = np.exp(s*250)-1
                        yp = s*x+(sy-s*sx)/25; ym = sy/25
                        r2 = 1-((y-yp)**2).sum()/((y-ym)**2).sum() if ((y-ym)**2).sum() > 0 else 0
                        vals.append(yr*r2)
                    else: vals.append(np.nan)
                else: vals.append(np.nan)
            else: vals.append(np.nan)
        ax.plot(x_idx, vals, color=etf_map[code]["color"], lw=1.5, alpha=0.8,
                label=etf_map[code]["name"], marker='o', markersize=3)
        if not np.isnan(vals[-1]) and vals[-1] is not None:
            ax.annotate(f'{vals[-1]:.4f}', (x_idx[-1], vals[-1]),
                        textcoords="offset points", xytext=(6, 4), fontsize=MOBILE_LABEL,
                        color=etf_map[code]["color"])
    ax.set_ylabel('动量得分', fontsize=MOBILE_FONT)
    ax.set_title(f'ETF动量得分趋势 (近{n_days}日)', fontsize=MOBILE_TITLE, pad=10)
    ax.grid(True, alpha=0.3); ax.legend(fontsize=MOBILE_LEGEND, ncol=4, loc='upper center', bbox_to_anchor=(0.5, -0.12), framealpha=0.9)
    ax.axhline(y=0, color='gray', lw=0.5, ls='--')
    ax.tick_params(axis='both', labelsize=MOBILE_TICK)
    tick_step = max(1, len(plot_dates)//5)
    ax.set_xticks(x_idx[::tick_step])
    ax.set_xticklabels([plot_dates[i][5:] for i in range(0, len(plot_dates), tick_step)], fontsize=MOBILE_TICK, rotation=20)

    ax = axes[1]
    for code in raw_data:
        dm = {raw_data[code]["dates"][i]: i for i in range(len(raw_data[code]["dates"]))}
        vals = []
        for d in plot_dates:
            idx = dm.get(d)
            if idx is not None and idx >= 21:
                c_all = raw_data[code]["close"][:idx+1]
                r = np.diff(c_all[-21:])/c_all[-21:-1]
                v = float(np.std(r, ddof=1)*np.sqrt(250))*100
                vals.append(v)
            else: vals.append(np.nan)
        ax.plot(x_idx, vals, color=etf_map[code]["color"], lw=1.2, alpha=0.7, label=etf_map[code]["name"])
        if not np.isnan(vals[-1]) and vals[-1] is not None:
            ax.annotate(f'{vals[-1]:.1f}%', (x_idx[-1], vals[-1]),
                        textcoords="offset points", xytext=(6, 3), fontsize=MOBILE_LABEL,
                        color=etf_map[code]["color"])
    ax.axhline(y=24, color='#e74c3c', lw=0.6, ls='--', alpha=0.4)
    ax.axhline(y=40, color='#e74c3c', lw=1, ls='--', alpha=0.6, label='vol=40%阈值')
    ax.set_ylabel('vol20(%)', fontsize=MOBILE_FONT)
    ax.set_title('vol20波动率趋势', fontsize=MOBILE_TITLE, pad=10)
    ax.grid(True, alpha=0.3); ax.legend(fontsize=MOBILE_LEGEND, ncol=5, loc='upper center', bbox_to_anchor=(0.5, -0.18), framealpha=0.9)
    ax.tick_params(axis='both', labelsize=MOBILE_TICK)
    ax.set_xticks(x_idx[::tick_step])
    ax.set_xticklabels([plot_dates[i][5:] for i in range(0, len(plot_dates), tick_step)], fontsize=MOBILE_TICK, rotation=20)
    plt.tight_layout(pad=2.0)
    buf = io.BytesIO(); plt.savefig(buf, format='png', dpi=150, bbox_inches='tight'); plt.close()
    chart_trend = base64.b64encode(buf.getvalue()).decode()

    # ----- 图2: 各ETF近30日涨跌幅（每日涨跌幅+累计曲线）-----
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    for idx, code in enumerate(codes):
        if code not in raw_data: continue
        ax = axes[idx//2][idx%2]
        nk = 30
        plot_d = all_dates[-nk:]
        dm = {raw_data[code]["dates"][i]: i for i in range(len(raw_data[code]["dates"]))}
        cl_vals = [float(raw_data[code]["close"][dm[d]]) for d in plot_d if dm.get(d) is not None]
        if len(cl_vals) < 3: continue
        # 每日涨跌幅
        daily_pct = [(cl_vals[i]/cl_vals[i-1]-1)*100 for i in range(1, len(cl_vals))]
        # 累计涨跌幅（基准为第一天）
        cum_pct = [(cl_vals[i]/cl_vals[0]-1)*100 for i in range(len(cl_vals))]
        total_ret = cum_pct[-1]
        x_idx = np.arange(len(daily_pct))
        colors_bar = ['#e74c3c' if p < 0 else '#22a67e' for p in daily_pct]
        ax.bar(x_idx, daily_pct, color=colors_bar, width=0.7, alpha=0.85)
        # 累计曲线覆盖在柱子上
        ax2 = ax.twinx()
        ax2.plot(x_idx, cum_pct[1:], color=etf_map[code]["color"], lw=2, alpha=0.8, marker='o', markersize=3)
        ax2.axhline(y=0, color='gray', lw=0.5, ls='--', alpha=0.5)
        ax2.set_ylabel('累计%', fontsize=9, color=etf_map[code]["color"])
        ax2.tick_params(axis='y', labelsize=8)
        # 每日涨跌幅y轴
        ax.axhline(y=0, color='gray', lw=0.5)
        # 标题含累计
        ret_color = '#e74c3c' if total_ret < -0.1 else '#22a67e'
        ax.set_title(f'{etf_map[code]["name"]} 近30日  ({total_ret:+.2f}%)',
                    fontsize=MOBILE_TITLE, fontweight='bold', color=ret_color)
        ax.set_ylabel('日涨跌%', fontsize=MOBILE_FONT)
        ax.grid(True, alpha=0.2, axis='y')
        ax.tick_params(axis='both', labelsize=MOBILE_TICK)
        # 横轴改为日期格式，每隔5个交易日标一个
        plot_labels = [d[5:] for d in plot_d]  # '07-10' 格式
        tick_step = max(1, len(daily_pct)//5)
        ax.set_xticks(x_idx[::tick_step])
        ax.set_xticklabels([plot_labels[i+1] for i in range(0, len(daily_pct), tick_step)],
                          fontsize=MOBILE_TICK, rotation=20)
    plt.tight_layout(pad=1.5)
    buf = io.BytesIO(); plt.savefig(buf, format='png', dpi=150); plt.close()
    chart_mini = base64.b64encode(buf.getvalue()).decode()

    print("[图表] 两张图表生成完成")
    return chart_trend, chart_mini


def inject_charts_into_html(html_content, chart_trend_b64, chart_mini_b64):
    """在邮件HTML的body末尾插入图表"""
    if not chart_trend_b64 and not chart_mini_b64:
        return html_content

    chart_section = ""
    if chart_trend_b64:
        chart_section += f'''
      <tr><td style="padding:18px 32px 12px 32px;">
        <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:1.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">📈 动量得分</div>
        <img src="data:image/png;base64,{chart_trend_b64}" style="width:100% !important;height:auto !important;max-width:100% !important;border-radius:6px;display:block;">
      </td></tr>'''
    if chart_mini_b64:
        chart_section += f'''
      <tr><td style="padding:0 32px 14px 32px;">
        <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:1.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">📊 ETF走势</div>
        <img src="data:image/png;base64,{chart_mini_b64}" style="width:100% !important;height:auto !important;max-width:100% !important;border-radius:6px;display:block;">
      </td></tr>'''

    # 在历史业绩段落前插入图表
    insert_marker = '<tr><td style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">'
    if insert_marker in html_content:
        return html_content.replace(insert_marker, chart_section + insert_marker, 1)
    else:
        return html_content.replace('</body>', chart_section + '</body>', 1)


# ============================================================
# 推送通道
# ============================================================
def send_feishu(webhook_url, data, max_retries=3):
    """发送飞书 interactive 卡片消息 (支持 11232 限流重试)
    data: run() 返回的字典,包含 results / best / avg_vol / triggered / newest_date
    """
    best = data["best"]
    avg_vol = data["avg_vol"]
    triggered = data["triggered"]
    is_risk = len(triggered) > 0

    # Header 颜色 (red=清仓, green=持有)
    header_template = "red" if is_risk else "green"

    # 主操作行
    if is_risk:
        op_line = "**🔴 操作: 清仓 ETF, 全仓买逆回购 GC001/R-001**"
    else:
        op_line = f"**🟢 操作: 满仓持有 {best['name']} ({best['code']})**"

    # 3 个风控条件 (每行完整描述, 与邮件HTML口径一致)
    nasdaq_res = next((r for r in data["results"] if r["code"] == "513100"), None)
    nq_gap = None
    if nasdaq_res and nasdaq_res.get("open") is not None and nasdaq_res.get("prev_close"):
        nq_gap = nasdaq_res["open"] / nasdaq_res["prev_close"] - 1
    nq_txt = f"{nq_gap*100:+.1f}%" if nq_gap is not None else "数据缺失"
    risk_defs = [
        {
            "id": "①", "title": "市场整体高波动",
            "cond": f"4 标的等权平均 vol20 = **{avg_vol*100:.1f}%** (阈值 40%)",
            "on": "①" in triggered,
        },
        {
            "id": "②", "title": "个股阶段顶部",
            "cond": (f"持有 {best['name']} 趋势线 = **{best['trend']:.1f}** (阈值 95) 且 "
                     f"持有 vol20 = **{best['vol']*100:.1f}%** (阈值 24%)"),
            "on": "②" in triggered,
        },
        {
            "id": "③", "title": "多标的共振",
            "cond": (f"持有 {best['name']} vol20 = **{best['vol']*100:.1f}%** (阈值 40%) 且 "
                     f"等权平均 vol20 = **{avg_vol*100:.1f}%** (阈值 30%)"),
            "on": "③" in triggered,
        },
        {
            "id": "④", "title": "纳指单日跳空清仓",
            "cond": f"纳指开盘跳空 = **{nq_txt}** (阈值 -5%), 信号/持仓为纳指时触发",
            "on": "④" in triggered,
        },
    ]
    risk_lines = []
    for rd in risk_defs:
        if rd["on"]:
            risk_lines.append(f"<font color='red'>**🔴 {rd['id']} {rd['title']}（触发）**</font>  \n{rd['cond']}")
        else:
            risk_lines.append(f"<font color='grey'>⚪ {rd['id']} {rd['title']}（未触发）</font>  \n{rd['cond']}")

    # 排名
    medals = ["🥇", "🥈", "🥉", "🏳️"]
    rank_lines = []
    for i, r in enumerate(data["results"]):
        score_str = f"{r['score']:+.3f}"
        if r["score"] > 0:
            score_str = f"<font color='green'>{score_str}</font>"
        elif r["score"] < 0:
            score_str = f"<font color='grey'>{score_str}</font>"
        rank_lines.append(f"{medals[i]} **{r['name']}** {score_str} vol {r['vol']*100:.1f}% 趋势 {r['trend']:.1f}")

    # 执行时间
    if is_risk:
        timeline_md = "**09:30** 集合竞价卖出 ETF  \n**14:30-14:50** 买 GC001/R-001 隔夜逆回购"
    else:
        timeline_md = "**09:30** 集合竞价买入信号标的  \n持仓不动, 收盘后跑次日策略"

    perf_md = "📊 **历史业绩** (2014-2026, 12.5 年)  \n年化 +43.5% · 夏普 1.82 · 回撤 -20.8% · 全部年度正收益"
    # 理论账户
    theo = data.get('theoretical')
    theo_md = ''
    if theo:
        theo_md = (f"**💰 理论账户** (7/7 进场 5 万)  \n"
                   f"当前 **{theo['equity']:,.0f} 元** ({theo['total_ret']*100:+.2f}%) 持仓 {theo['hold']}")

    # 新闻判断
    news = data.get('news')
    news_md = ''
    if news and not news.get('error'):
        sev = news.get('overall', {}).get('severity', 0)
        t3 = news.get('three_condition', {})
        rel = news.get('relevant_news', [])
        lines = [f"📰 **新闻判断** (风险 {sev}/5, 共 {news.get('news_count',0)} 条快讯)"]
        if t3.get('hit'):
            lines.append(f"🔴 **三条件命中 → 建议考虑清仓!**  \n{t3.get('reason','')}")
        elif rel:
            lines.append(f"⚪ {t3.get('reason','未命中三条件')}")
        for n in rel[:3]:
            sev_icon = '🔴' * n.get('severity', 0)
            lines.append(f"{sev_icon} [{n.get('direction_name','?')}/{n.get('impact','')}] {n.get('text','')[:36]}")
        if not rel and not t3.get('hit'):
            lines.append("✅ 今日无重大风险新闻, 按信号操作")
        news_md = '\n'.join(lines)


    card = {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": "📊 ETF轮动 · 次日操作建议"},
                "template": header_template
            },
            "elements": [
                {"tag": "div", "text": {"tag": "lark_md", "content": op_line}},
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": f"**🛡️ 风控监测** ({len(triggered)}/4 触发)"}},
                {"tag": "div", "text": {"tag": "lark_md", "content": risk_lines[0]}},
                {"tag": "div", "text": {"tag": "lark_md", "content": risk_lines[1]}},
                {"tag": "div", "text": {"tag": "lark_md", "content": risk_lines[2]}},
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": "**📋 动量得分排名**"}},
                {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(rank_lines)}},
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": f"**⏰ 执行时间**\n{timeline_md}"}},
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": perf_md}},
            ] + ([
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": theo_md}},
            ] if theo_md else []) + ([
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": news_md}},
            ] if news_md else []) + [
                {"tag": "note", "elements": [{"tag": "plain_text",
                    "content": "信号机械执行 · 触发即清仓 · 不做主观判断"}]}
            ]
        }
    }

    payload = json.dumps(card, ensure_ascii=False).encode("utf-8")
    for attempt in range(max_retries):
        req = urllib.request.Request(webhook_url, data=payload,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                try:
                    result = json.loads(raw)
                except Exception:
                    print(f"[Feishu] 第 {attempt+1}/{max_retries} 次: 返回非 JSON: {raw[:200]}")
                    if attempt < max_retries - 1:
                        time.sleep(5)
                    continue
                code = result.get("code", 0)
                msg = result.get("msg", "")
                print(f"[Feishu] 第 {attempt+1}/{max_retries} 次: code={code} msg={msg}")
                if code == 0:
                    return True
                if code == 11232 and attempt < max_retries - 1:
                    print(f"[Feishu] 触发限流, 等待 62s 后重试...")
                    time.sleep(62)
                    continue
                print(f"[Feishu] 业务失败, 不重试: code={code} msg={msg}")
                return False
        except Exception as e:
            print(f"[Feishu] 第 {attempt+1}/{max_retries} 次异常: {e}")
            if attempt < max_retries - 1:
                time.sleep(5)
                continue
            return False
    return False


def send_email(html_content, to_addr, from_addr, auth_code,
               smtp_host="smtp.qq.com", smtp_port=465, max_retries=3):
    """QQ 邮箱 SMTP SSL 推送 HTML 邮件"""
    m = re.search(r'操作建议</div>\s*<div[^>]*>([^<]+)', html_content)
    if m:
        best_name = m.group(1).strip()
    else:
        best_name = "ETF日报"

    today_str = datetime.now(CN_TZ).strftime("%m-%d")
    subject = f"【ETF日报】{best_name} ({today_str})"

    msg = MIMEMultipart("alternative")
    msg["From"] = formataddr(("ETF轮动", from_addr))
    msg["To"] = formataddr(("策略订阅者", to_addr))
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg.attach(MIMEText(html_content, "html", "utf-8"))

    for attempt in range(max_retries):
        try:
            print(f"[Email] 第 {attempt+1}/{max_retries} 次连接 {smtp_host}:{smtp_port} ...")
            with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=30) as s:
                s.login(from_addr, auth_code)
                s.sendmail(from_addr, [to_addr], msg.as_string())
            print(f"[Email] 发送成功: {to_addr} | 主题: {subject}")
            return True
        except Exception as e:
            print(f"[Email] 第 {attempt+1}/{max_retries} 次失败: {e}")
            if attempt < max_retries - 1:
                time.sleep(8)
                continue
            return False
    return False


# ============================================================
# 理论账户: 2026-07-07 进场 5 万, 无状态全量重算 (云端安全)
# 每次从 THEO_START 拉全量历史重算到最新日, 零持久化依赖
# ============================================================
THEO_START = '2026-07-07'
THEO_CAPITAL = 50000
THEO_FEE_ETF = 0.0001      # 万0.5免5 (5万本金每笔≥5元≈0.01%)
THEO_FEE_REPO = 0.02/250*0.1  # 逆回购1折


def theo_fetch_full(code, market):
    """拉全量历史日K (新浪, datalen=4000 覆盖 ETF 上市至今)
    注: 新浪为未复权价, 2026-07-07 起算近期无分红差异可忽略
    """
    sym = ('sh' if market == 'sh' else 'sz') + code
    url = (f'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/'
           f'CN_MarketData.getKLineData?symbol={sym}&datalen=4000&scale=240&ma=no')
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn'})
            raw = json.loads(urllib.request.urlopen(req, timeout=25).read().decode('gbk'))
            if not isinstance(raw, list) or len(raw) < 60:
                continue
            return [{'day': d['day'][:10], 'open': float(d['open']), 'close': float(d['close']),
                     'high': float(d['high']), 'low': float(d['low'])} for d in raw]
        except Exception:
            if attempt < 2:
                time.sleep(3)
    return None


def theo_calc_from_data(ohlc):
    """从全量 OHLC (dict: code -> [{'day','open','close','high','low'}]) 重算理论账户
    口径: v8 三风控 + T-1信号->T日开盘 + 信号变化才交易 + 用户费率
    返回摘要 dict 或 None
    """
    import math as _m
    codes = list(ohlc.keys())
    # 统一交易日 (取交集)
    dates = None
    for c in codes:
        ds = set(r['day'] for r in ohlc[c])
        dates = ds if dates is None else (dates & ds)
    if not dates:
        return None
    dates = sorted(dates)
    close_m = {c: {r['day']: r['close'] for r in ohlc[c]} for c in codes}
    open_m = {c: {r['day']: r['open'] for r in ohlc[c]} for c in codes}
    high_m = {c: {r['day']: r['high'] for r in ohlc[c]} for c in codes}
    low_m = {c: {r['day']: r['low'] for r in ohlc[c]} for c in codes}
    n = len(dates)
    # 逐日指标 (滚动计算, 纯 Python)
    def _score(dts, closes, idx):
        if idx < 24:
            return 0.0
        w = [_m.log(closes[i]) for i in range(idx-24, idx+1)]
        if any(_m.isnan(x) or x != x for x in w) or min(w) != w:
            pass
        y = w; t = list(range(25))
        n2 = 25; sx = sum(t); sy = sum(y); sxx = sum(x*x for x in t); sxy = sum(t[i]*y[i] for i in range(n2))
        denom = n2*sxx - sx*sx
        if denom == 0: return 0.0
        slope = (n2*sxy - sx*sy)/denom
        intercept = (sy - slope*sx)/n2
        ym = sy/n2
        ssr = sum((y[i] - (slope*t[i]+intercept))**2 for i in range(n2))
        sst = sum((yi-ym)**2 for yi in y)
        r2 = 1 - ssr/sst if sst > 0 else 0
        return (_m.exp(slope*250)-1)*r2
    def _vol20(closes, idx):
        if idx < 20: return 0.0
        rets = [closes[i]/closes[i-1]-1 for i in range(idx-19, idx+1)]
        m = sum(rets)/20
        var = sum((r-m)**2 for r in rets)/19
        return _m.sqrt(var)*_m.sqrt(250)
    def _trend(highs, lows, closes, idx):
        if idx < 54: return 50.0
        seg_h = highs[idx-54:idx+1]; seg_l = lows[idx-54:idx+1]
        hhv = max(seg_h); llv = min(seg_l)
        return 50.0 if hhv == llv else (closes[idx]-llv)/(hhv-llv)*100
    def _tdx_sma(v, nn, mm):
        out = [float('nan')]*len(v); y = float('nan')
        for i, x in enumerate(v):
            if x != x: out[i] = y; continue
            if y != y: y = x
            else: y = (x*mm + y*(nn-mm))/nn
            out[i] = y
        return out
    def _trend_full(highs, lows, closes):
        n3 = len(closes)
        rsv = []
        for i in range(n3):
            if i < 54:
                rsv.append(50.0); continue
            hhv = max(highs[i-54:i+1]); llv = min(lows[i-54:i+1])
            rsv.append(50.0 if hhv == llv else (closes[i]-llv)/(hhv-llv)*100)
        sma5 = _tdx_sma(rsv, 5, 1); sma3 = _tdx_sma(sma5, 3, 1)
        v11 = [3*sma5[i]-2*sma3[i] if (sma5[i]==sma5[i] and sma3[i]==sma3[i]) else 50.0 for i in range(n3)]
        ema = [v11[0]]; alpha = 2/4
        for i in range(1, n3): ema.append(alpha*v11[i] + (1-alpha)*ema[-1])
        return ema

    # 预计算每标的全序列 (趋势线需要整序列)
    series = {}
    for c in codes:
        closes = [close_m[c][d] for d in dates]
        highs = [high_m[c][d] for d in dates]
        lows = [low_m[c][d] for d in dates]
        trend_full = _trend_full(highs, lows, closes)
        series[c] = {'closes': closes, 'highs': highs, 'lows': lows, 'trend': trend_full}

    # 模拟
    start_idx = next((i for i, d in enumerate(dates) if d >= THEO_START), None)
    if start_idx is None:
        return None
    equity = THEO_CAPITAL
    cur = None
    cooldown_until = -1
    for i in range(start_idx, n-1):
        scores = {c: _score(dates, series[c]['closes'], i) for c in codes}
        best = max(scores, key=scores.get)
        avg_v = sum(_vol20(series[c]['closes'], i) for c in codes)/len(codes)
        hold_v = _vol20(series[best]['closes'], i)
        hold_tr = series[best]['trend'][i]
        r1 = avg_v > 0.40
        r2 = hold_tr > 95 and hold_v > 0.24
        r3 = hold_v > 0.40 and avg_v > 0.30
        # ④ 纳指单日跳空清仓: 持仓纳指 且 次日开盘较今日收盘跳空≤-5% → 清仓, 冷却3交易日
        gap_fire = False
        if cur == GAP_TRIGGER_ASSET and i+1 < n:
            op = open_m[GAP_TRIGGER_ASSET].get(dates[i+1])
            pc = close_m[GAP_TRIGGER_ASSET].get(dates[i])
            if op and pc and pc > 0 and op / pc - 1 <= -GAP_TRIGGER_PCT:
                gap_fire = True
        # 冷却期内: 强制逆回购, 不重新进场
        if i < cooldown_until:
            cost = THEO_FEE_ETF if cur is not None and cur != 'REPO' else 0
            equity *= (1 + THEO_FEE_REPO - cost); cur = 'REPO'
            continue
        if r1 or r2 or r3 or gap_fire:
            cost = THEO_FEE_ETF if cur is not None and cur != 'REPO' else 0
            equity *= (1 + THEO_FEE_REPO - cost); cur = 'REPO'
            if gap_fire:
                cooldown_until = i + 3
        else:
            if cur != best:
                cost = THEO_FEE_ETF if (cur is None or cur == 'REPO') else 2*THEO_FEE_ETF
            else:
                cost = 0
            if i+2 < n:
                px_in = open_m[best][dates[i+1]]; px_out = open_m[best][dates[i+2]]
                r = (px_out/px_in - 1 - cost) if px_in > 0 and px_out > 0 else THEO_FEE_REPO
            else:
                r = THEO_FEE_REPO
            equity *= (1 + r); cur = best
    total_ret = equity/THEO_CAPITAL - 1
    n_days = n - start_idx
    years = n_days/250
    ann = (1+total_ret)**(1/years)-1 if years > 0 else 0
    hold_name = {'510300': '沪深300', '159915': '创业板', '513100': '纳指', '518880': '黄金'}.get(cur, '逆回购' if cur == 'REPO' else '空仓')
    return {'start': THEO_START, 'capital': THEO_CAPITAL, 'equity': equity,
            'total_ret': total_ret, 'ann': ann, 'n_days': n_days,
            'last_date': dates[-1], 'hold': hold_name}


def calc_theoretical():
    """拉全量历史 + 重算理论账户, 云端安全无状态"""
    try:
        ohlc = {}
        for e in ETF_LIST:
            data = theo_fetch_full(e['code'], e['market'])
            if data is None:
                print(f'[警告] 理论账户 {e["code"]} 数据失败')
                return None
            ohlc[e['code']] = data
        return theo_calc_from_data(ohlc)
    except Exception as ex:
        print(f'[警告] 理论账户计算失败: {ex}')
        return None



# ============================================================
# 新闻判断模块 (抓快讯 + GLM分析 + 三条件清仓规则)
# 依赖: GLM_API_KEY 环境变量 (智谱免费API)
# ============================================================
NEWS_DIRECTIONS = {
    1: '杠杆/流动性收紧', 2: '利率预期反转', 3: '地缘冲突/战争',
    4: '单一资产泡沫破裂', 5: '政策突变/监管', 6: '疫情/黑天鹅',
}

def news_fetch(n=12):
    """抓东财 + 新浪 7x24 快讯"""
    items = []
    try:
        url = ('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns'
               '?client=web&biz=web_724&column=345&order=1&needInteractData=0'
               f'&page_index=1&page_size={n}&req_trace=etf_news'
               '&fields=code,showTime,title,summary,mediaName,url')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.eastmoney.com/'})
        r = json.loads(urllib.request.urlopen(req, timeout=15).read().decode('utf-8'))
        for it in r.get('data', {}).get('list', []):
            t = (it.get('title', '') or '') + ' ' + (it.get('summary', '') or '')
            if t.strip():
                items.append({'time': it.get('showTime', '')[:16], 'text': t.strip()[:300], 'src': '东财'})
    except Exception:
        pass
    try:
        url = f'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size={n}&zhibo_id=152&tag_id=0&dire=f&dpc=1&type=0'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn'})
        r = json.loads(urllib.request.urlopen(req, timeout=15).read().decode('utf-8'))
        feed = r.get('result', {}).get('data', {}).get('feed', {}).get('list', [])
        for it in feed:
            t = re.sub(r'<[^>]+>', ' ', it.get('rich_text', '') or '').strip()
            if t:
                items.append({'time': it.get('create_time', '')[:16], 'text': t[:300], 'src': '新浪'})
    except Exception:
        pass
    # 去重
    seen, uniq = set(), []
    for it in items:
        k = it['text'][:40]
        if k not in seen:
            seen.add(k); uniq.append(it)
    return uniq

def news_glm_analyze(news_text, hold_name, hold_code, hold_vol, risk_trig):
    """GLM 分析新闻性质 + 三条件清仓规则
    返回 dict: {relevant_news, overall, three_condition}
    """
    key = os.environ.get('GLM_API_KEY', '')
    result = {'relevant_news': [], 'overall': {'severity': 0, 'direction': '无', 'summary': '', 'advice': ''},
              'three_condition': {'hit': False, 'reason': ''}}
    if not key:
        result['three_condition']['reason'] = '未设置 GLM_API_KEY, 跳过新闻判断'
        return result
    if not news_text.strip():
        result['three_condition']['reason'] = '无新闻'
        return result

    system = """你是ETF动量轮动策略的新闻风控助手。从财经快讯中识别【真正可能影响4个持仓标的】的重大新闻，输出JSON。
【标的映射】黄金: 美联储/美元/美债/贵金属/地缘/通胀; 纳指: 美股/科技/AI/美联储/半导体; 创业板: A股/科技成长/新能源; 沪深300: A股大盘/宏观/政策。
【6大方向】1=杠杆/流动性收紧 2=利率预期反转 3=地缘冲突 4=单一资产泡沫破裂 5=政策突变/监管 6=疫情/黑天鹅。
【忽略】单只个股新闻、普通行业动态、与4标的无关琐事。
只输出JSON: {"relevant_news":[{"text":"30字内","direction":1-6或null,"direction_name":"","impact":"利多/利空/中性","target":"受影响标的","severity":1-5}],"overall":{"direction":"主要风险方向","severity":1-5,"summary":"一句话","advice":"建议"}}"""
    user = (f"当前持仓:{hold_name} 风控:{'触发' if risk_trig else '未触发'} 持仓vol20:{hold_vol*100:.0f}%\n"
            f"今日快讯:\n{news_text}\n请分析,只输出JSON。")
    try:
        payload = json.dumps({'model': 'glm-4-flash',
                              'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
                              'temperature': 0.2, 'max_tokens': 1200}).encode()
        req = urllib.request.Request('https://open.bigmodel.cn/api/paas/v4/chat/completions',
                                     data=payload, headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
        r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))
        content = r.get('choices', [{}])[0].get('message', {}).get('content', '')
        m = re.search(r'\{.*\}', content, re.DOTALL)
        if m:
            parsed = json.loads(m.group(0))
            result['relevant_news'] = parsed.get('relevant_news', [])
            result['overall'] = parsed.get('overall', result['overall'])
    except Exception as e:
        result['three_condition']['reason'] = f'GLM调用失败: {str(e)[:60]}'
        return result

    # 三条件清仓规则 (历史验证: 年化+1.05pp)
    main_dir = None
    for n in result['relevant_news']:
        if n.get('direction'):
            main_dir = n['direction']; break
    if main_dir is None and result['overall'].get('direction'):
        for k, v in NEWS_DIRECTIONS.items():
            if v.split('/')[0] in str(result['overall'].get('direction', '')) or k == 1 and '杠杆' in str(result['overall'].get('direction', '')):
                main_dir = k; break
    risk_on = risk_trig
    cond1 = main_dir in (1, 5)
    cond2 = hold_code in ('159915', '510300')
    cond3 = hold_vol is not None and hold_vol > 0.25
    if not risk_on and cond1 and cond2 and cond3:
        result['three_condition'] = {'hit': True, 'reason': '命中三条件(流动性/A股利空+持仓高波动A股+vol>25%), 建议考虑清仓'}
    else:
        reason = []
        if risk_on: reason.append('风控已触发')
        if not cond1: reason.append('非流动性/A股利空')
        if not cond2: reason.append('持仓非创业板/沪深300')
        if not cond3: reason.append('持仓vol≤25%')
        result['three_condition'] = {'hit': False, 'reason': '未命中三条件, 不因新闻清仓' + ('(' + ','.join(reason) + ')' if reason else '')}
    return result

def run_news_analysis(data):
    """在 run() 数据基础上执行新闻判断, 返回注入 data['news'] 的 dict"""
    try:
        best = data.get('best', {})
        hold_name = best.get('name', '')
        hold_code = best.get('code', '')
        hold_vol = best.get('vol')
        risk_trig = len(data.get('triggered', [])) > 0
        news_items = news_fetch(12)
        if not news_items:
            return {'error': '无新闻'}
        news_text = '\n'.join([f"[{n['time']}] {n['text']}" for n in news_items])
        analysis = news_glm_analyze(news_text, hold_name, hold_code, hold_vol, risk_trig)
        analysis['hold'] = hold_name
        analysis['news_count'] = len(news_items)
        return analysis
    except Exception as e:
        return {'error': str(e)[:80]}


# ============================================================
# 主入口
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="ETF轮动选股器 (B+C+ 并集方案 v4)")
    parser.add_argument("--feishu", action="store_true", help="发送结果到飞书 Webhook")
    parser.add_argument("--email",  action="store_true", help="发送 HTML 邮件")
    args = parser.parse_args()

    feishu_url = os.environ.get("FEISHU_WEBHOOK_URL", "")
    email_to   = os.environ.get("EMAIL_TO", "")
    email_from = os.environ.get("EMAIL_FROM", email_to)
    email_pass = os.environ.get("EMAIL_PASSWORD", "")

    if args.feishu and not feishu_url:
        print("[错误] 请设置 FEISHU_WEBHOOK_URL 环境变量"); sys.exit(1)
    if args.email:
        if not email_to:   print("[错误] 请设置 EMAIL_TO 环境变量"); sys.exit(1)
        if not email_pass: print("[错误] 请设置 EMAIL_PASSWORD 环境变量"); sys.exit(1)

    print("=" * 60)
    print("  ETF轮动选股器 (B+C+ 并集方案 v4)")
    print("  " + datetime.now(CN_TZ).strftime("%Y-%m-%d %H:%M"))
    print("=" * 60)

    # 判断是否需要严格的新鲜度检查
    require_today = should_require_today_data()
    today_str = datetime.now(CN_TZ).strftime("%Y-%m-%d")
    print(f"[新鲜度] 当前北京时间 {datetime.now(CN_TZ).strftime('%H:%M')}")
    if require_today:
        print(f"[新鲜度] 工作日 15:30 后，要求最新数据日期 = {today_str}")
    else:
        print(f"[新鲜度] 非工作日或盘中，使用数据源返回的最新数据即可")

    data = None
    last_attempt_date = None
    for attempt in range(1, FRESHNESS_RETRY_MAX + 1):
        print(f"\n========== 第 {attempt}/{FRESHNESS_RETRY_MAX} 次尝试 ==========")
        data = run()
        if data is None:
            print(f"[重试 {attempt}] run() 返回 None (无可用数据)")
        else:
            newest = data.get("newest_date", "")[:10]
            last_attempt_date = newest
            print(f"[重试 {attempt}] 最新数据日期: {newest}")

            if not require_today:
                # 非工作日或盘中：有数据就推送
                print(f"[新鲜度] 非严格模式，直接采用")
                break

            if newest == today_str:
                print(f"[新鲜度] ✅ 数据是今天的，开始推送")
                break
            else:
                # 工作日 15:30 后但数据不是今天 — 可能是新浪/东财延迟
                # 先判断今天是不是交易日（实时报价）
                is_td = is_today_a_trading_day()
                if is_td is False:
                    print(f"[新鲜度] 实时报价显示今天非交易日（节假日），采用最新可用数据 {newest}")
                    break
                # 是交易日但数据不是今天，需要重试
                if attempt < FRESHNESS_RETRY_MAX:
                    print(f"[新鲜度] ⚠️  数据不是今天 ({today_str})，等待 {FRESHNESS_RETRY_WAIT}s 后重试...")
                    time.sleep(FRESHNESS_RETRY_WAIT)
                else:
                    print(f"[新鲜度] ❌ 重试 {FRESHNESS_RETRY_MAX} 次仍未拿到今天数据")
                    print(f"[新鲜度] 最后一次拿到的数据日期: {newest}")
                    data = None  # 标记失败

    if data is None:
        print()
        print("=" * 60)
        print("  ❌ 数据新鲜度校验失败")
        print(f"  期望日期: {today_str}")
        print(f"  实际日期: {last_attempt_date}")
        print("  工作流标记为失败，请检查数据源")
        print("=" * 60)
        sys.exit(1)

    print()
    output = format_action(data)
    print(output)
    # 理论账户 (无状态全量重算, 云端安全)
    theo = calc_theoretical()
    if theo:
        theo_line = (f"💰 理论账户 (7/7进场5万): {theo['equity']:,.0f}元 "
                     f"({theo['total_ret']*100:+.2f}%) 持仓{theo['hold']}")
        print(theo_line)
        data['theoretical'] = theo

    # 新闻判断 (GLM 分析 + 三条件)
    print("\n--- 新闻判断 ---")
    news = run_news_analysis(data)
    if news and not news.get('error'):
        sev = news.get('overall', {}).get('severity', 0)
        hit = news.get('three_condition', {}).get('hit', False)
        print(f"  新闻{news.get('news_count',0)}条, 风险{sev}/5, 三条件{'命中' if hit else '未命中'}")
        data['news'] = news
    else:
        print(f"  新闻判断跳过: {news.get('error','') if news else '无数据'}")


    if args.feishu:
        print("\n--- 推送到飞书 ---")
        ok = send_feishu(feishu_url, data)
        if not ok:
            print("[警告] 飞书推送失败, 继续邮件推送")

    if args.email:
        print("\n--- 推送到邮箱 ---")
        html = generate_html(data)
        # 生成图表并嵌入邮件
        print("[图表] 开始生成图表...")
        chart_t, chart_m = generate_charts(data)
        if chart_t or chart_m:
            html = inject_charts_into_html(html, chart_t, chart_m)
            print("[Email] 已嵌入图表")
        else:
            print("[Email] 图表未生成，发送纯HTML邮件")
        ok = send_email(html, email_to, email_from, email_pass)
        if not ok:
            print("[错误] 邮件推送失败")
            sys.exit(1)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
