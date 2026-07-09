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

【版本历史】
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
    {"code": "510300", "name": "沪深300 ETF", "market": "sh"},
    {"code": "159915", "name": "创业板 ETF",  "market": "sz"},
    {"code": "513100", "name": "纳指 ETF",    "market": "sh"},
    {"code": "518880", "name": "黄金 ETF",    "market": "sh"},
]

N = 25
VOL_WINDOW = 20
TRADING_DAYS = 250
FETCH_DAYS = 300
TIMEOUT = 15
CN_TZ = timezone(timedelta(hours=8))

AVG_VOL_THRESHOLD = 0.40
TREND_THRESHOLD = 95.0
HOLD_VOL_THRESHOLD_B = 0.24
HOLD_VOL_THRESHOLD_C = 0.40
AVG_VOL_THRESHOLD_C = 0.30


# ============================================================
# 数据获取 (东财 + 新浪 双数据源, 重试 3 轮)
# ============================================================
def fetch_klines(code, market, days=FETCH_DAYS):
    urls = [
        f"https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={'1.' if market=='sh' else '0.'}{code}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt={days}",
        f"https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={'sh' if market=='sh' else 'sz'}{code}&datalen={days}&scale=240&ma=no",
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
def check_risk(avg_vol, hold_vol, hold_trend):
    triggered = []
    if avg_vol > AVG_VOL_THRESHOLD:
        triggered.append("①")
    if hold_trend > TREND_THRESHOLD and hold_vol > HOLD_VOL_THRESHOLD_B:
        triggered.append("②")
    if hold_vol > HOLD_VOL_THRESHOLD_C and avg_vol > AVG_VOL_THRESHOLD_C:
        triggered.append("③")
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
            "price": closes[-1], "valid": True, "date": last
        })

    valid_results = [r for r in results if r.get("valid", False)]
    if not valid_results:
        return None

    valid_results.sort(key=lambda r: r["score"], reverse=True)
    best = valid_results[0]
    avg_vol = sum(r["vol"] for r in valid_results) / len(valid_results)
    triggered = check_risk(avg_vol, best["vol"], best["trend"])

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

    lines.append(f"🛡️ 风控监测 ({len(triggered)}/3 触发):")
    all_conditions = [
        ("①", "市场整体高波动", f"均 vol20 = {avg_vol*100:.1f}% (阈值 40%)", "①" in triggered),
        ("②", "个股阶段顶部",   f"趋势 {best['trend']:.1f} (阈值 95), 持有 vol {best['vol']*100:.1f}% (阈值 24%)", "②" in triggered),
        ("③", "多标的共振",     f"持有 vol {best['vol']*100:.1f}% (阈值 40), 均 vol {avg_vol*100:.1f}% (阈值 30%)", "③" in triggered),
    ]
    for cid, title, detail, on in all_conditions:
        icon = "🔴" if on else "⚪"
        lines.append(f"   {icon} {cid} {title}: {detail}  {'【触发】' if on else ''}")
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
    score_norm = max(0, min(100, (score + 0.5) * 100))
    score_color = "#10b981" if score > 0 else "#9ca3af"
    score_bar_color = "#10b981" if score > 0.1 else ("#f59e0b" if score > -0.1 else "#9ca3af")
    return f'''
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:18px;">{medal}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">
            <div style="font-size:14px;font-weight:600;color:#1f2937;">{r["name"]}<span style="font-size:11px;color:#9ca3af;font-weight:400;margin-left:6px;">{r["code"]}</span></div>
          </td>
          <td align="right" style="padding:10px 8px;border-bottom:1px solid #f3f4f6;">
            <div style="font-size:14px;font-weight:700;color:{score_color};font-family:Consolas,monospace;">{score:+.3f}</div>
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;width:120px;">
            <div style="background:#e5e7eb;border-radius:2px;height:6px;overflow:hidden;">
              <div style="background:{score_bar_color};width:{score_norm:.0f}%;height:6px;border-radius:2px;"></div>
            </div>
          </td>
          <td align="right" style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;font-family:Consolas,monospace;">{r["vol"]*100:.1f}%</td>
          <td align="right" style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;font-family:Consolas,monospace;">{r["trend"]:.1f}</td>
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
    risk_defs = [
        {"id": "①", "title": "市场整体高波动", "subtitle": "等权平均 vol20 > 40%",
         "detail": f"4 标的等权平均 vol20 = <strong>{avg_vol*100:.1f}%</strong>, 阈值 40%"},
        {"id": "②", "title": "个股阶段顶部", "subtitle": "持有趋势线 > 95 且 持有 vol20 > 24%",
         "detail": f"持有 <strong>{best['name']}</strong> 趋势线 = <strong>{best['trend']:.1f}</strong> (阈值 95), 持有 vol20 = <strong>{best['vol']*100:.1f}%</strong> (阈值 24%)"},
        {"id": "③", "title": "多标的共振", "subtitle": "持有 vol20 > 40% 且 等权平均 vol20 > 30%",
         "detail": f"持有 <strong>{best['name']}</strong> vol20 = <strong>{best['vol']*100:.1f}%</strong> (阈值 40%), 等权平均 vol20 = <strong>{avg_vol*100:.1f}%</strong> (阈值 30%)"},
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
              <span style="font-size:13px;margin-right:4px;">{icon}</span>{r['id']} {r['title']}{badge}
            </div>
            <div style="font-size:10px;color:{label_color};margin-top:2px;font-family:Consolas,monospace;">{r['subtitle']}</div>
            <div style="font-size:11px;color:{detail_color};margin-top:4px;line-height:1.4;padding-top:4px;border-top:1px dashed {('rgba(220,38,38,0.2)' if is_on else '#e5e7eb')};">{r['detail']}</div>
          </td></tr>
        </table>'''

    risk_html = f'''
    <tr><td style="padding:18px 32px 0 32px;">
      <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:1.5px;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">🛡️ 风控监测 <span style="font-size:12px;color:#dc2626;font-weight:700;background:#fef2f2;padding:2px 8px;border-radius:8px;margin-left:6px;">{len(triggered_ids)}/3 触发</span></div>
      {risk_cards}
    </td></tr>'''

    ranking_rows = ""
    for i, r in enumerate(data["results"]):
        ranking_rows += ranking_row(i, r)

    avg_vol_color = "#dc2626" if avg_vol > AVG_VOL_THRESHOLD else "#10b981"
    hold_vol_color = "#dc2626" if best["vol"] > HOLD_VOL_THRESHOLD_C else ("#f59e0b" if best["vol"] > HOLD_VOL_THRESHOLD_B else "#10b981")
    trend_color = "#dc2626" if best["trend"] > TREND_THRESHOLD else "#10b981"

    if is_risk:
        timeline = [
            ("09:25", "集合竞价卖出全部 ETF 持仓"),
            ("09:30", "开盘确认成交"),
            ("14:30", "下单买 GC001 / R-001 隔夜逆回购"),
            ("14:50", "⚠️ 不要拖到 14:50 后,利率会被打低"),
        ]
    else:
        timeline = [
            ("09:25", "集合竞价: 信号标的开盘买入"),
            ("09:30", "开盘确认成交"),
            ("持仓中", "继续持有,不做主观判断"),
            ("15:00", "收盘后跑次日策略"),
        ]

    timeline_rows = ""
    for tm, action in timeline:
        timeline_rows += f'''
            <tr><td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
              <span style="display:inline-block;min-width:60px;color:#374151;font-weight:700;font-family:Consolas,monospace;font-size:13px;">{tm}</span>
              <span style="color:#4b5563;font-size:13px;">{action}</span>
            </td></tr>'''

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
            <td width="120" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">趋势强度</td>
            <td align="right" width="55" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">vol20</td>
            <td align="right" width="45" style="padding:6px 8px;font-size:10px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">趋势</td>
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

      <tr><td style="padding:18px 32px 0 32px;">
        <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:1.5px;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">⏰ 执行时间表</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          {timeline_rows}
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
          • 12.5 年回测包含 1 个完整年度负收益,需要心理准备
        </div>
      </td></tr>

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
    return html


# ============================================================
# 推送通道
# ============================================================
def send_feishu(webhook_url, text, max_retries=3):
    """发送到飞书 webhook, 支持 11232 限流自动重试"""
    payload = json.dumps({"msg_type": "text", "content": {"text": text}}).encode("utf-8")
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

    data = run()
    if data is None:
        print("[错误] 无可用数据")
        sys.exit(1)

    print()
    output = format_action(data)
    print(output)

    if args.feishu:
        print("\n--- 推送到飞书 ---")
        ok = send_feishu(feishu_url, output)
        if not ok:
            print("[警告] 飞书推送失败, 继续邮件推送")

    if args.email:
        print("\n--- 推送到邮箱 ---")
        html = generate_html(data)
        ok = send_email(html, email_to, email_from, email_pass)
        if not ok:
            print("[错误] 邮件推送失败")
            sys.exit(1)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
