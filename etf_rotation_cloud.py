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
              <span style="font-size:13px;margin-right:4px;">{icon}</span>{r['title']}{badge}
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
    ax.grid(True, alpha=0.3); ax.legend(fontsize=MOBILE_LEGEND, ncol=4)
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
    ax.grid(True, alpha=0.3); ax.legend(fontsize=MOBILE_LEGEND, ncol=4)
    ax.tick_params(axis='both', labelsize=MOBILE_TICK)
    ax.set_xticks(x_idx[::tick_step])
    ax.set_xticklabels([plot_dates[i][5:] for i in range(0, len(plot_dates), tick_step)], fontsize=MOBILE_TICK, rotation=20)
    plt.tight_layout(pad=1.5)
    buf = io.BytesIO(); plt.savefig(buf, format='png', dpi=150); plt.close()
    chart_trend = base64.b64encode(buf.getvalue()).decode()

    # ----- 图2: 各ETF近30日涨跌幅（手机适配：2行2列，字放大）-----
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    for idx, code in enumerate(codes):
        if code not in raw_data: continue
        ax = axes[idx//2][idx%2]
        nk = 30
        plot_d = all_dates[-nk:]
        dm = {raw_data[code]["dates"][i]: i for i in range(len(raw_data[code]["dates"]))}
        cl_vals = [float(raw_data[code]["close"][dm[d]]) for d in plot_d if dm.get(d) is not None]
        if len(cl_vals) < 2: continue
        base = cl_vals[0]
        pct = [(v/base-1)*100 for v in cl_vals]
        colors_bar = ['#e74c3c' if p < 0 else '#22a67e' for p in pct]
        ax.bar(range(len(pct)), pct, color=colors_bar, width=0.7, alpha=0.85)
        ax.plot(range(len(pct)), pct, color=etf_map[code]["color"], lw=1.5, alpha=0.6)
        ax.axhline(y=0, color='gray', lw=0.5)
        ax.set_title(f'{etf_map[code]["name"]} 近30日涨跌幅', fontsize=MOBILE_TITLE, fontweight='bold')
        ax.set_ylabel('%', fontsize=MOBILE_FONT); ax.grid(True, alpha=0.2, axis='y')
        ax.tick_params(axis='both', labelsize=MOBILE_TICK)
        ax.annotate(f'{pct[-1]:+.2f}%', (len(pct)-1, pct[-1]),
                    textcoords="offset points", xytext=(8, 8), fontsize=MOBILE_LABEL, fontweight='bold',
                    color='#e74c3c' if pct[-1]<0 else '#22a67e')
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
      <tr><td style="padding:16px 20px 10px 20px;">
        <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:8px;padding-bottom:4px;border-bottom:2px solid #e5e7eb;">📈 动量得分 &amp; vol20 趋势 (近60日)</div>
        <img src="data:image/png;base64,{chart_trend_b64}" style="width:100% !important;height:auto !important;max-width:100% !important;border-radius:6px;display:block;">
      </td></tr>'''
    if chart_mini_b64:
        chart_section += f'''
      <tr><td style="padding:0 20px 14px 20px;">
        <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:8px;padding-bottom:4px;border-bottom:2px solid #e5e7eb;">📊 各ETF近30日涨跌幅</div>
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

    # 3 个风控条件
    risk_defs = [
        ("①", "市场整体高波动", f"均 vol20 = {avg_vol*100:.1f}% (阈值 40%)", "①" in triggered),
        ("②", "个股阶段顶部",   f"趋势 {best['trend']:.1f} / vol {best['vol']*100:.1f}% (阈值 95/24%)", "②" in triggered),
        ("③", "多标的共振",     f"vol {best['vol']*100:.1f}% / 均 {avg_vol*100:.1f}% (阈值 40/30%)", "③" in triggered),
    ]
    risk_lines = []
    for cid, title, vals, on in risk_defs:
        if on:
            risk_lines.append(f"<font color='red'>**🔴 {title} (触发)**</font>  \n{vals}")
        else:
            risk_lines.append(f"<font color='grey'>⚪ {title}</font>  \n{vals}")

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
                {"tag": "div", "text": {"tag": "lark_md", "content": f"**🛡️ 风控监测** ({len(triggered)}/3 触发)"}},
                {"tag": "div", "fields": [
                    {"is_short": True,  "text": {"tag": "lark_md", "content": risk_lines[0]}},
                    {"is_short": True,  "text": {"tag": "lark_md", "content": risk_lines[1]}},
                    {"is_short": False, "text": {"tag": "lark_md", "content": risk_lines[2]}},
                ]},
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": "**📋 动量得分排名**"}},
                {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(rank_lines)}},
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": f"**⏰ 执行时间**\n{timeline_md}"}},
                {"tag": "hr"},
                {"tag": "div", "text": {"tag": "lark_md", "content": perf_md}},
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
