// ETF 轮动选股器 — 快捷指令版 (Scriptable, iOS)
// 用途: 被「快捷指令」调用，计算选股结果，输出 HTML 字符串给快捷指令。
// 策略: B+C+ 并集 + 双数据源(东财/新浪) + 并行 + 自动重试 (与原 v3 一致)
// 2026-07-03 v3: 条件② 持有 vol 阈值 0.30 → 0.24

const ETF_LIST = [
  { code: "510300", name: "沪深", market: "sh" },
  { code: "159915", name: "创业",  market: "sz" },
  { code: "513100", name: "纳指",    market: "sh" },
  { code: "518880", name: "黄金",    market: "sh" }
];

const N = 25;
const VOL_WINDOW = 20;
const TRADING_DAYS = 250;
const FETCH_DAYS = 100;
const TIMEOUT = 8;

const AVG_VOL_THRESHOLD = 0.40;
const TREND_THRESHOLD = 95.0;
const HOLD_VOL_THRESHOLD_B = 0.24;
const HOLD_VOL_THRESHOLD_C = 0.40;
const AVG_VOL_THRESHOLD_C = 0.30;

// ============================================================
const sleep = (() => {
  if (typeof Timer !== 'undefined' && typeof Timer.wait === 'function') {
    return (sec) => Timer.wait(sec);
  }
  if (typeof setTimeout === 'function') {
    return (sec) => new Promise(r => setTimeout(r, sec * 1000));
  }
  return (sec) => new Promise(r => {
    const target = Date.now() + sec * 1000;
    while (Date.now() < target) {}
    r();
  });
})();

// ============================================================
// 数据源
// ============================================================
async function fetchEastmoney(code, market) {
  const secid = (market === "sh" ? "1." : "0.") + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=${FETCH_DAYS}`;
  const req = new Request(url);
  req.timeoutInterval = TIMEOUT;
  req.headers = { "User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/" };
  const d = await req.loadJSON();
  if (!d || !d.data || !d.data.klines) return null;
  const valid = d.data.klines
    .map(k => k.split(","))
    .filter(r => parseFloat(r[5]) > 0)
    .map(r => ({
      day: r[0], open: parseFloat(r[1]), close: parseFloat(r[2]),
      high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5])
    }));
  return valid.length >= 60 ? valid : null;
}

async function fetchSina(code, market) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${market}${code}&datalen=${FETCH_DAYS}&scale=240&ma=no`;
  const req = new Request(url);
  req.timeoutInterval = TIMEOUT;
  req.headers = { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn" };
  const data = await req.loadJSON();
  if (!Array.isArray(data) || data.length < 60) return null;
  const valid = data
    .filter(d => parseFloat(d.volume) > 0)
    .map(d => ({
      day: d.day || d.date,
      open: parseFloat(d.open), close: parseFloat(d.close),
      high: parseFloat(d.high), low: parseFloat(d.low), volume: parseFloat(d.volume)
    }));
  return valid.length >= 60 ? valid : null;
}

async function fetchKlines(code, market) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchEastmoney(code, market);
      if (r) {
        if (attempt > 0) console.log(`[OK] ${code} 东财 第${attempt+1}次`);
        return r;
      }
    } catch (e) {
      console.log(`[ERR] ${code} 东财 第${attempt+1}/2次: ${e.message || e}`);
    }
    if (attempt < 1) try { await sleep(1); } catch(e) {}
  }
  console.log(`[INFO] ${code} 切换到新浪...`);
  try {
    const r = await fetchSina(code, market);
    if (r) { console.log(`[OK] ${code} 新浪: ${r.length}条`); return r; }
  } catch (e) {
    console.log(`[ERR] ${code} 新浪: ${e.message || e}`);
  }
  console.log(`[ERR] ${code} 所有数据源失败`);
  return null;
}

// ============================================================
// 指标计算
// ============================================================
function calcScore(closes) {
  const c = closes.slice(-N);
  if (c.length < N || Math.min(...c) <= 0) return 0;
  const y = c.map(x => Math.log(x));
  const x = Array.from({length: N}, (_, i) => i);
  const n = x.length;
  const sx = x.reduce((a, b) => a + b, 0);
  const sy = y.reduce((a, b) => a + b, 0);
  const sxx = x.reduce((a, b) => a + b*b, 0);
  const sxy = x.reduce((a, b, i) => a + b*y[i], 0);
  const denom = n*sxx - sx*sx;
  if (denom === 0) return 0;
  const slope = (n*sxy - sx*sy) / denom;
  const intercept = (sy - slope*sx) / n;
  const annual = Math.exp(slope*TRADING_DAYS) - 1;
  const yPred = x.map(xi => slope*xi + intercept);
  const ym = sy / n;
  const ssr = y.reduce((a, _, i) => a + (y[i]-yPred[i])**2, 0);
  const sst = y.reduce((a, yi) => a + (yi-ym)**2, 0);
  const r2 = sst > 0 ? 1 - ssr/sst : 0;
  return annual * r2;
}

function calcVol20(closes) {
  if (closes.length < VOL_WINDOW + 1) return 0;
  const recent = closes.slice(-(VOL_WINDOW+1));
  const rets = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i-1] > 0) rets.push((recent[i]-recent[i-1]) / recent[i-1]);
  }
  if (rets.length < VOL_WINDOW) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b-m)**2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

function tdxSma(values, n, m) {
  const out = new Array(values.length).fill(NaN);
  let y = NaN;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (isNaN(x)) { out[i] = y; continue; }
    if (isNaN(y)) y = x;
    else y = (x*m + y*(n-m)) / n;
    out[i] = y;
  }
  return out;
}

function calcTrendLine(highs, lows, closes) {
  const n = closes.length;
  if (n < 55) return 50.0;
  const rsv = [];
  for (let i = 0; i < n; i++) {
    if (i < 54) { rsv.push(50.0); continue; }
    let llv = Infinity, hhv = -Infinity;
    for (let j = i-54; j <= i; j++) {
      if (lows[j]  < llv) llv = lows[j];
      if (highs[j] > hhv) hhv = highs[j];
    }
    rsv.push(hhv === llv ? 50.0 : (closes[i]-llv)/(hhv-llv)*100);
  }
  const sma5 = tdxSma(rsv, 5, 1);
  const sma5_3 = tdxSma(sma5, 3, 1);
  const v11 = [];
  for (let i = 0; i < n; i++) {
    v11.push(!isNaN(sma5[i]) && !isNaN(sma5_3[i]) ? 3*sma5[i] - 2*sma5_3[i] : 50.0);
  }
  const ema = new Array(n).fill(NaN);
  ema[0] = v11[0];
  const alpha = 2 / (3 + 1);
  for (let i = 1; i < n; i++) {
    ema[i] = alpha * v11[i] + (1 - alpha) * ema[i-1];
  }
  return ema[n-1];
}

function checkRisk(avgVol, holdVol, holdTrend) {
  const triggered = [];
  if (avgVol > AVG_VOL_THRESHOLD) {
    triggered.push(`① 等权平均vol20=${(avgVol*100).toFixed(1)}% > ${(AVG_VOL_THRESHOLD*100).toFixed(0)}% (市场风险)`);
  }
  if (holdTrend > TREND_THRESHOLD && holdVol > HOLD_VOL_THRESHOLD_B) {
    triggered.push(`② 趋势线=${holdTrend.toFixed(1)}>${TREND_THRESHOLD} 且 持有vol=${(holdVol*100).toFixed(1)}%>${(HOLD_VOL_THRESHOLD_B*100).toFixed(0)}% (阶段顶部)`);
  }
  if (holdVol > HOLD_VOL_THRESHOLD_C && avgVol > AVG_VOL_THRESHOLD_C) {
    triggered.push(`③ 持有vol=${(holdVol*100).toFixed(1)}%>${(HOLD_VOL_THRESHOLD_C*100).toFixed(0)}% 且 均=${(avgVol*100).toFixed(1)}%>${(AVG_VOL_THRESHOLD_C*100).toFixed(0)}% (共振)`);
  }
  return { triggered: triggered.length > 0, reasons: triggered };
}

// ============================================================
// 主流程
// ============================================================
async function run() {
  const fetchOne = async (etf, idx) => {
    if (idx > 0) try { await sleep(0.1); } catch(e) {}
    const raw = await fetchKlines(etf.code, etf.market);
    return { etf, raw };
  };
  console.log("---- 并行拉取 " + ETF_LIST.length + " 个 ETF ----");
  const t0 = Date.now();
  let results = await Promise.all(ETF_LIST.map(fetchOne));
  console.log(`首轮耗时: ${((Date.now()-t0)/1000).toFixed(1)}s`);

  let failed = results.filter(r => r.raw === null);
  if (failed.length > 0) {
    console.log(`[BATCH] ${failed.length}个失败, 2秒后并行重试...`);
    try { await sleep(2); } catch(e) {}
    const retry = await Promise.all(
      failed.map(async ({etf}) => {
        const raw = await fetchKlines(etf.code, etf.market);
        return { etf, raw };
      })
    );
    for (const rr of retry) {
      if (rr.raw !== null) {
        const idx = results.findIndex(r => r.etf.code === rr.etf.code);
        if (idx >= 0) results[idx].raw = rr.raw;
      }
    }
  }

  const validResults = [];
  let newestDate = null;
  for (const { etf, raw } of results) {
    if (!raw) { console.log(`[FAIL] ${etf.code} ${etf.name} 最终无数据`); continue; }
    const closes = raw.map(d => d.close);
    const highs  = raw.map(d => d.high);
    const lows   = raw.map(d => d.low);
    const lastDay = raw[raw.length-1].day || raw[raw.length-1].date || "";
    if (lastDay && (newestDate === null || lastDay > newestDate)) newestDate = lastDay;
    validResults.push({
      code: etf.code, name: etf.name,
      score: calcScore(closes),
      vol:   calcVol20(closes),
      trend: calcTrendLine(highs, lows, closes),
      price: closes[closes.length-1],
      date:  lastDay
    });
  }
  if (validResults.length === 0) return { error: "无数据可用 (所有数据源失败)" };
  validResults.sort((a, b) => b.score - a.score);
  const best = validResults[0];
  const avgVol = validResults.reduce((a, r) => a + r.vol, 0) / validResults.length;
  const { triggered, reasons } = checkRisk(avgVol, best.vol, best.trend);
  return { results: validResults, best, avgVol, triggered, reasons, newestDate: newestDate || "日期未知", partialFail: validResults.length < ETF_LIST.length };
}

// ============================================================
// 纯文本（供「纯文本邮件」版快捷指令使用）
// ============================================================
function formatText(data) {
  const lines = [];
  lines.push("━".repeat(10));
  lines.push(`📅 数据日期: ${data.newestDate}`);
  lines.push("");
  if (data.triggered) lines.push("🔴 操作: 清仓 ETF, 全仓买逆回购 GC001/R-001");
  else lines.push(`🟢 操作: 满仓持有 ${data.best.name} (${data.best.code})`);
  lines.push("");
  if (data.triggered) { lines.push("⚠️ 风控触发原因:"); data.reasons.forEach(r => lines.push(`   ${r}`)); }
  else lines.push("✅ 风控未触发, 各项指标正常");
  lines.push("");
  lines.push("📋 动量得分排名:");
  const medals = ["🥇", "🥈", "🥉", "     "];
  data.results.forEach((r, i) => {
    const icon = medals[i] || "  ";
    const star = (!data.triggered && i === 0) ? " ⬅ 推荐" : "";
    lines.push(`${icon} ${r.name.padEnd(6)} ${r.score >= 0 ? "+" : ""}${r.score.toFixed(3)}  ${(r.vol*100).toFixed(1)}%  ${r.trend.toFixed(1)}${star}`);
  });
  lines.push("");
  lines.push(`等权平均 vol20: ${(data.avgVol*100).toFixed(1)}% (阈值 ${(AVG_VOL_THRESHOLD*100).toFixed(0)}%)`);
  if (data.partialFail) { lines.push(""); lines.push("⚠️ 注意: 部分标的数据获取失败, 结果仅供参考"); }
  lines.push("━".repeat(10));
  return lines.join("\n");
}

// ============================================================
// HTML（供「附件 HTML」版快捷指令使用，输出给快捷指令）
// ============================================================
function esc(s){ return String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function generateHtml(data) {
  const now = new Date();
  const genTime = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  let banner, bannerColor, bannerText;
  if (data.error) { bannerColor="#9e9e9e"; banner="❌ 数据获取失败"; bannerText="所有数据源均不可用，请稍后手动重跑。"; }
  else if (data.triggered) { bannerColor="#e53935"; banner=`🔴 清仓 ETF，全仓买逆回购 GC001 / R-001`; bannerText="风控信号已触发，建议离场观望。"; }
  else { bannerColor="#2e7d32"; banner=`🟢 满仓持有 ${esc(data.best.name)} (${esc(data.best.code)})`; bannerText="风控未触发，持有动量最强标的。"; }

  let riskHtml = data.error ? `<div class="muted">${esc(data.error)}</div>`
    : data.triggered ? data.reasons.map(r=>`<li>${esc(r)}</li>`).join("")
    : `<li class="ok">✅ 风控未触发，各项指标正常</li>`;

  let rows = "";
  if (!data.error) {
    const medals = ["🥇","🥈","🥉","🏳️"];
    rows = data.results.map((r, i) => {
      const isBest = !data.triggered && i === 0;
      const star = isBest ? `<span class="badge">推荐</span>` : "";
      const scoreCls = r.score >= 0 ? "pos" : "neg";
      return `<tr class="${isBest?"best":""}"><td>${medals[i]||"·"}</td><td><b>${esc(r.name)}</b><br><span class="code">${esc(r.code)}</span></td><td class="${scoreCls}">${r.score>=0?"+":""}${r.score.toFixed(3)}</td><td>${(r.vol*100).toFixed(1)}%</td><td>${r.trend.toFixed(1)}</td><td>¥${Number(r.price).toFixed(3)}</td><td>${star}</td></tr>`;
    }).join("");
  }
  const avgVolLine = data.error ? "" : `<div class="avgvol">等权平均 vol20: <b>${(data.avgVol*100).toFixed(1)}%</b> (阈值 ${AVG_VOL_THRESHOLD*100}%) ｜ 趋势阈值 ${TREND_THRESHOLD} ｜ 持有vol阈值B ${HOLD_VOL_THRESHOLD_B*100}% / C ${HOLD_VOL_THRESHOLD_C*100}%</div>`;
  const partialFail = (!data.error && data.partialFail) ? `<div class="warn">⚠️ 注意：部分标的数据获取失败，结果仅供参考。</div>` : "";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f8;margin:0;padding:24px;color:#222}
  .card{max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .banner{background:${bannerColor};color:#fff;padding:22px 24px}.banner h1{margin:0;font-size:20px}.banner p{margin:6px 0 0;opacity:.92;font-size:14px}
  .body{padding:22px 24px}.meta{color:#888;font-size:13px;margin-bottom:16px}
  h2{font-size:15px;color:#333;border-left:4px solid #1a73e8;padding-left:8px;margin:20px 0 10px}
  ul{margin:6px 0;padding-left:20px;font-size:14px;line-height:1.7}li.ok{color:#2e7d32}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:6px}th,td{padding:9px 8px;text-align:left;border-bottom:1px solid #eee}
  th{color:#999;font-weight:600;font-size:12px}tr.best{background:#e8f5e9}.pos{color:#2e7d32;font-weight:600}.neg{color:#e53935;font-weight:600}
  .code{color:#999;font-size:11px}.badge{background:#2e7d32;color:#fff;font-size:11px;padding:2px 7px;border-radius:10px}
  .avgvol{margin-top:14px;font-size:13px;color:#555;background:#f1f3f4;padding:10px 12px;border-radius:8px}
  .warn{margin-top:12px;color:#b26a00;background:#fff4e0;padding:10px 12px;border-radius:8px;font-size:13px}
  .foot{max-width:680px;margin:14px auto 0;color:#aaa;font-size:12px;text-align:center}</style></head>
  <body><div class="card"><div class="banner"><h1>${banner}</h1><p>${esc(bannerText)}</p></div>
  <div class="body"><div class="meta">📅 数据日期：${esc(data.newestDate||"—")} ｜ 生成时间：${genTime}</div>
  <h2>风控信号</h2><ul>${riskHtml}</ul><h2>动量得分排名</h2>
  <table><thead><tr><th></th><th>标的</th><th>动量得分</th><th>vol20</th><th>趋势线</th><th>最新价</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  ${avgVolLine}${partialFail}</div></div>
  <div class="foot">本邮件由 ETF 轮动选股器自动生成，仅供研究参考，不构成投资建议。股市有风险，投资需谨慎。</div></body></html>`;
}

// ============================================================
// 入口: 区分「快捷指令调用」与「手动运行」
// ============================================================
if (config.runsInShortcuts) {
  // —— 被快捷指令调用：只输出结果，不弹窗 ——
  (async () => {
    const data = await run();
    if (data.error) {
      // 出错时也输出文本，方便快捷指令知道失败
      Script.setShortcutOutput("ETF轮动选股失败：" + data.error);
    } else {
      // 默认输出 HTML（附件版用）；如需纯文本版，把下一行换成 formatText(data)
      Script.setShortcutOutput(generateHtml(data));
    }
    Script.complete();
  })();
} else {
  // —— 手动在 Scriptable 里运行：保留原 widget / 弹窗 / 通知 ——
  async function buildWidget(data) {
    let title, subtitle, color, body;
    if (data.error) { title="❌ 无数据可用"; subtitle="所有数据源失败, 请稍后手动刷新"; color=Color.gray(); body="多次重试仍失败"; }
    else { title=data.triggered?"🔴 清仓切逆回购":`🟢 持有 ${data.best.name}`; subtitle=`${data.newestDate} · 均=${(data.avgVol*100).toFixed(1)}%`; color=data.triggered?Color.red():Color.green();
      const rows=data.results.slice(0,4).map((r,i)=>`${["🥇","🥈","🥉","  "][i]||"  "}${r.name} ${(r.vol*100).toFixed(0)}%|${r.trend.toFixed(0)}`); body=rows.join("\n"); }
    if (config.runsInWidget) {
      const w=new ListWidget(); w.backgroundColor=color;
      const t=w.addText(title); t.font=Font.boldSystemFont(16); t.textColor=Color.white();
      const s=w.addText(subtitle); s.font=Font.systemFont(11); s.textColor=Color.white();
      if(body){w.addSpacer(4);const b=w.addText(body);b.font=Font.systemFont(10);b.textColor=Color.white();}
      return w;
    } else {
      const text=data.error?`❌ ${data.error}`:formatText(data);
      const alert=new Alert(); alert.title=data.error?"ETF轮动 - 失败":"ETF轮动 - 次日操作建议"; alert.message=text; alert.addAction("完成");
      if(data.error) alert.addAction("重试");
      const tap=await alert.present();
      if(data.error&&tap===1) await runAndShow();
    }
  }
  async function runAndShow() {
    console.log("==== ETF 轮动开始 ====");
    const startTs=Date.now();
    const data=await run();
    console.log(`总耗时: ${((Date.now()-startTs)/1000).toFixed(1)}s`);
    await buildWidget(data);
    if(!config.runsInWidget){ try{ const n=new Notification(); n.title=data.error?"ETF轮动 - 失败":(data.triggered?"🔴 清仓切逆回购":`🟢 持有 ${data.best.name}`); n.body=data.error?"数据获取失败":`${data.newestDate} 等权vol=${(data.avgVol*100).toFixed(1)}%`; await n.schedule(); }catch(e){} }
  }
  await runAndShow();
  Script.complete();
}
