// ============================================================
// ETF 轮动选股器 — Node.js 服务端版 (核心算法)
// 移植自 Scriptable v3 脚本，算法与回测/云端完全一致。
// 仅将 Scriptable 的 Request API 替换为 Node 原生 fetch。
// ============================================================

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
const HOLD_VOL_THRESHOLD_B = 0.24;       // ★v3: 0.30 → 0.24
const HOLD_VOL_THRESHOLD_C = 0.40;
const AVG_VOL_THRESHOLD_C = 0.30;

// ============================================================
// sleep（Node 原生）
// ============================================================
const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

// ============================================================
// Node fetch 封装（带超时 + 自动 JSON 解析）
// ============================================================
async function fetchWithTimeout(url, headers, timeoutSec) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("JSON 解析失败: " + text.slice(0, 80));
    }
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 数据源
// ============================================================
async function fetchEastmoney(code, market) {
  const secid = (market === "sh" ? "1." : "0.") + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=${FETCH_DAYS}`;
  const headers = { "User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/" };
  const d = await fetchWithTimeout(url, headers, TIMEOUT);
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
  const headers = { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn" };
  const data = await fetchWithTimeout(url, headers, TIMEOUT);
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
        if (attempt > 0) console.log(`[OK] ${code} 东财 第${attempt + 1}次`);
        return r;
      }
    } catch (e) {
      console.log(`[ERR] ${code} 东财 第${attempt + 1}/2次: ${e.message || e}`);
    }
    if (attempt < 1) try { await sleep(1); } catch (e) {}
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
// 指标计算 (核心算法, 与回测/云端完全一致)
// ============================================================
function calcScore(closes) {
  const c = closes.slice(-N);
  if (c.length < N || Math.min(...c) <= 0) return 0;
  const y = c.map(x => Math.log(x));
  const x = Array.from({ length: N }, (_, i) => i);
  const n = x.length;
  const sx = x.reduce((a, b) => a + b, 0);
  const sy = y.reduce((a, b) => a + b, 0);
  const sxx = x.reduce((a, b) => a + b * b, 0);
  const sxy = x.reduce((a, b, i) => a + b * y[i], 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const annual = Math.exp(slope * TRADING_DAYS) - 1;
  const yPred = x.map(xi => slope * xi + intercept);
  const ym = sy / n;
  const ssr = y.reduce((a, _, i) => a + (y[i] - yPred[i]) ** 2, 0);
  const sst = y.reduce((a, yi) => a + (yi - ym) ** 2, 0);
  const r2 = sst > 0 ? 1 - ssr / sst : 0;
  return annual * r2;
}

function calcVol20(closes) {
  if (closes.length < VOL_WINDOW + 1) return 0;
  const recent = closes.slice(-(VOL_WINDOW + 1));
  const rets = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1] > 0) rets.push((recent[i] - recent[i - 1]) / recent[i - 1]);
  }
  if (rets.length < VOL_WINDOW) return 0;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

function tdxSma(values, n, m) {
  const out = new Array(values.length).fill(NaN);
  let y = NaN;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (isNaN(x)) { out[i] = y; continue; }
    if (isNaN(y)) y = x;
    else y = (x * m + y * (n - m)) / n;
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
    for (let j = i - 54; j <= i; j++) {
      if (lows[j] < llv) llv = lows[j];
      if (highs[j] > hhv) hhv = highs[j];
    }
    rsv.push(hhv === llv ? 50.0 : (closes[i] - llv) / (hhv - llv) * 100);
  }
  const sma5 = tdxSma(rsv, 5, 1);
  const sma5_3 = tdxSma(sma5, 3, 1);
  const v11 = [];
  for (let i = 0; i < n; i++) {
    v11.push(!isNaN(sma5[i]) && !isNaN(sma5_3[i]) ? 3 * sma5[i] - 2 * sma5_3[i] : 50.0);
  }
  const ema = new Array(n).fill(NaN);
  ema[0] = v11[0];
  const alpha = 2 / (3 + 1);
  for (let i = 1; i < n; i++) {
    ema[i] = alpha * v11[i] + (1 - alpha) * ema[i - 1];
  }
  return ema[n - 1];
}

function checkRisk(avgVol, holdVol, holdTrend) {
  const triggered = [];
  if (avgVol > AVG_VOL_THRESHOLD) {
    triggered.push(`① 等权平均vol20=${(avgVol * 100).toFixed(1)}% > ${(AVG_VOL_THRESHOLD * 100).toFixed(0)}% (市场风险)`);
  }
  if (holdTrend > TREND_THRESHOLD && holdVol > HOLD_VOL_THRESHOLD_B) {
    triggered.push(`② 趋势线=${holdTrend.toFixed(1)}>${TREND_THRESHOLD} 且 持有vol=${(holdVol * 100).toFixed(1)}%>${(HOLD_VOL_THRESHOLD_B * 100).toFixed(0)}% (阶段顶部)`);
  }
  if (holdVol > HOLD_VOL_THRESHOLD_C && avgVol > AVG_VOL_THRESHOLD_C) {
    triggered.push(`③ 持有vol=${(holdVol * 100).toFixed(1)}%>${(HOLD_VOL_THRESHOLD_C * 100).toFixed(0)}% 且 均=${(avgVol * 100).toFixed(1)}%>${(AVG_VOL_THRESHOLD_C * 100).toFixed(0)}% (共振)`);
  }
  return { triggered: triggered.length > 0, reasons: triggered };
}

// ============================================================
// 主流程
// ============================================================
async function run() {
  const fetchOne = async (etf, idx) => {
    if (idx > 0) try { await sleep(0.1); } catch (e) {}
    const raw = await fetchKlines(etf.code, etf.market);
    return { etf, raw };
  };

  console.log("---- 并行拉取 " + ETF_LIST.length + " 个 ETF ----");
  const t0 = Date.now();
  let results = await Promise.all(ETF_LIST.map(fetchOne));
  console.log(`首轮耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let failed = results.filter(r => r.raw === null);
  if (failed.length > 0) {
    console.log(`[BATCH] ${failed.length}个失败, 2秒后并行重试...`);
    try { await sleep(2); } catch (e) {}
    const retry = await Promise.all(
      failed.map(async ({ etf }) => {
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
    if (!raw) {
      console.log(`[FAIL] ${etf.code} ${etf.name} 最终无数据`);
      continue;
    }
    const closes = raw.map(d => d.close);
    const highs = raw.map(d => d.high);
    const lows = raw.map(d => d.low);
    const lastBar = raw[raw.length - 1];
    const lastDay = lastBar.day || lastBar.date || "";
    if (lastDay && (newestDate === null || lastDay > newestDate)) {
      newestDate = lastDay;
    }
    validResults.push({
      code: etf.code, name: etf.name,
      score: calcScore(closes),
      vol: calcVol20(closes),
      trend: calcTrendLine(highs, lows, closes),
      price: closes[closes.length - 1],
      date: lastDay
    });
  }

  if (validResults.length === 0) return { error: "无数据可用 (所有数据源失败)" };

  validResults.sort((a, b) => b.score - a.score);
  const best = validResults[0];
  const avgVol = validResults.reduce((a, r) => a + r.vol, 0) / validResults.length;
  const { triggered, reasons } = checkRisk(avgVol, best.vol, best.trend);

  return {
    results: validResults,
    best, avgVol, triggered, reasons,
    newestDate: newestDate || "日期未知",
    partialFail: validResults.length < ETF_LIST.length
  };
}

module.exports = {
  ETF_LIST, run, calcScore, calcVol20, calcTrendLine, checkRisk,
  AVG_VOL_THRESHOLD, TREND_THRESHOLD, HOLD_VOL_THRESHOLD_B,
  HOLD_VOL_THRESHOLD_C, AVG_VOL_THRESHOLD_C
};
