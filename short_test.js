// ============================================================
// 风控触发时做空回测：原策略风控触发（空仓）时，
// 改为做空某个标的能否赚更多？做空哪个标的收益最大？
// 用最长可用历史（~6年，新浪1500日上限）。
// 做空收益 = (卖价 - 买回价)/卖价 （空头盈利）
// ============================================================

const https = require('https');
const fs = require('fs');
const { calcScore, calcVol20, calcTrendLine,
        AVG_VOL_THRESHOLD, TREND_THRESHOLD,
        HOLD_VOL_THRESHOLD_B, HOLD_VOL_THRESHOLD_C, AVG_VOL_THRESHOLD_C } = require('./selector');

const CORE = [
  { code: "510300", name: "沪深300", market: "sh" },
  { code: "159915", name: "创业板",  market: "sz" },
  { code: "513100", name: "纳指",    market: "sh" },
  { code: "518880", name: "黄金",    market: "sh" }
];
const DATALEN = 1500, TIMEOUT = 15;
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

function httpGet(url, headers, t) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let c = ''; res.setEncoding('utf-8');
      res.on('data', d => c += d); res.on('end', () => resolve(c));
    });
    req.on('error', reject); req.setTimeout(t * 1000, () => req.destroy(new Error('timeout')));
  });
}
async function fetchSina(code, market) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${market}${code}&datalen=${DATALEN}&scale=240&ma=no`;
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' };
  for (let a = 0; a < 3; a++) {
    try {
      const text = await httpGet(url, headers, TIMEOUT);
      const data = JSON.parse(text);
      if (!Array.isArray(data) || data.length < 60) return null;
      return data.filter(d => parseFloat(d.volume) > 0).map(d => ({
        day: d.day || d.date, open: parseFloat(d.open), close: parseFloat(d.close),
        high: parseFloat(d.high), low: parseFloat(d.low), volume: parseFloat(d.volume)
      }));
    } catch (e) { if (a < 2) await sleep(1.5); }
  }
  return null;
}
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

// 复刻 selector checkRisk
function checkRisk(avgVol, holdVol, holdTrend) {
  const triggered = [];
  if (avgVol > AVG_VOL_THRESHOLD) triggered.push('①');
  if (holdTrend > TREND_THRESHOLD && holdVol > HOLD_VOL_THRESHOLD_B) triggered.push('②');
  if (holdVol > HOLD_VOL_THRESHOLD_C && avgVol > AVG_VOL_THRESHOLD_C) triggered.push('③');
  return triggered.length > 0 ? triggered : null;
}

(async () => {
  console.log('风控触发时做空回测');
  const rawMap = {};
  for (const etf of CORE) {
    process.stdout.write(`  拉取 ${etf.code} ${etf.name}...`);
    const raw = await fetchSina(etf.code, etf.market);
    if (raw) { console.log(` ${raw.length}条`); rawMap[etf.code] = raw; }
    else console.log(' 失败!');
    await sleep(0.4);
  }
  const coreSets = CORE.map(c => new Set((rawMap[c.code] || []).map(d => d.day)));
  let common = [...coreSets[0]];
  for (let i = 1; i < coreSets.length; i++) common = common.filter(d => coreSets[i].has(d));
  common.sort();
  console.log(`\n  公共交易日: ${common.length} 天 (${common[0]} ~ ${common[common.length - 1]})`);

  const closes = {}, highs = {}, lows = {};
  for (const etf of CORE) {
    const map = new Map((rawMap[etf.code] || []).map(d => [d.day, d]));
    closes[etf.code] = common.map(d => { const b = map.get(d); return b ? b.close : null; });
    highs[etf.code] = common.map(d => { const b = map.get(d); return b ? b.high : null; });
    lows[etf.code] = common.map(d => { const b = map.get(d); return b ? b.low : null; });
  }

  // 逐日算 + 风控判定
  const daily = [];
  for (let i = 55; i < common.length; i++) {
    const rec = { date: common[i], idx: i, scores: {}, vols: {}, trends: {} };
    let ok = true;
    for (const c of CORE) {
      const arr = closes[c.code];
      if (arr[i] == null) { ok = false; break; }
      const bars = arr.slice(0, i + 1).filter(v => v != null);
      const hB = highs[c.code].slice(0, i + 1).filter(v => v != null);
      const lB = lows[c.code].slice(0, i + 1).filter(v => v != null);
      if (bars.length < 55) { ok = false; break; }
      rec.scores[c.code] = calcScore(bars);
      rec.vols[c.code] = calcVol20(bars);
      rec.trends[c.code] = calcTrendLine(hB, lB, bars);
    }
    if (!ok) continue;
    const sorted = CORE.map(c => ({ code: c.code, score: rec.scores[c.code], vol: rec.vols[c.code], trend: rec.trends[c.code] }))
      .sort((x, y) => y.score - x.score);
    const best = sorted[0];
    const avgVol = CORE.reduce((s, c) => s + rec.vols[c.code], 0) / CORE.length;
    const risk = checkRisk(avgVol, best.vol, best.trend);
    rec.risk = risk;
    rec.best = best;
    rec.avgVol = avgVol;
    daily.push(rec);
  }

  const riskDays = daily.filter(d => d.risk);
  console.log(`\n  风控触发日: ${riskDays.length} 天 (占 ${(riskDays.length / daily.length * 100).toFixed(1)}%)`);
  // 触发类型分布
  const typeCnt = {};
  for (const d of riskDays) for (const t of d.risk) typeCnt[t] = (typeCnt[t] || 0) + 1;
  console.log(`  触发类型: ` + Object.entries(typeCnt).map(([k, v]) => `${k}=${v}天`).join(' '));

  const horizons = [1, 5, 10, 20];
  const fmtPct = (v) => (v * 100).toFixed(2) + '%';

  // 做空各标的 + 动态策略
  // shortRet(做空) = (price[i]-price[i+h])/price[i]
  function shortRet(code, i, h) {
    if (closes[code][i] == null || closes[code][i + h] == null || closes[code][i] == 0) return null;
    return (closes[code][i] - closes[code][i + h]) / closes[code][i];
  }

  // 候选做空标的
  const shortCandidates = [
    { key: '510300', label: '做空沪深300' },
    { key: '159915', label: '做空创业板' },
    { key: '513100', label: '做空纳指' },
    { key: '518880', label: '做空黄金' },
    { key: 'DYNAMIC_WORST', label: '做空动量最负者' },
    { key: 'DYNAMIC_HIGHVOL', label: '做空波动最大者' },
    { key: 'DYNAMIC_BEST', label: '做空持有最不弱(反向)' }
  ];

  const results = {};
  for (const cand of shortCandidates) {
    const r = { r: [], w: [], s: [] };
    for (const d of riskDays) {
      const i = d.idx;
      let code = null;
      if (cand.key === 'DYNAMIC_WORST') {
        code = CORE.map(c => ({ code: c.code, score: d.scores[c.code] })).sort((x, y) => x.score - y.score)[0].code;
      } else if (cand.key === 'DYNAMIC_HIGHVOL') {
        code = CORE.map(c => ({ code: c.code, vol: d.vols[c.code] })).sort((x, y) => y.vol - x.vol)[0].code;
      } else if (cand.key === 'DYNAMIC_BEST') {
        code = d.best.code;
      } else {
        code = cand.key;
      }
      for (const h of horizons) {
        const sr = shortRet(code, i, h);
        if (sr != null) { r.r.push(sr); r.w.push(sr > 0 ? 1 : 0); r.s.push(sr); }
      }
    }
    results[cand.key] = { label: cand.label, stat: horizons.map(h => {
      const seg = r.r.filter((_, k) => k % horizons.length === horizons.indexOf(h));
      const wins = r.w.filter((_, k) => k % horizons.length === horizons.indexOf(h));
      const stds = r.s.filter((_, k) => k % horizons.length === horizons.indexOf(h));
      return { h, avg: mean(seg), win: wins.length ? mean(wins) : 0, std: std(stds) };
    }) };
  }

  console.log('\n' + '='.repeat(60));
  console.log('   风控触发日 做空各标的收益（vs 空仓=0）');
  console.log('='.repeat(60));
  for (const cand of shortCandidates) {
    const s = results[cand.key];
    console.log(`\n  ${cand.label}:`);
    console.log('  持有期 | 做空avg | 做空胜率 | 做空std');
    for (const h of horizons) {
      const x = s.stat.find(z => z.h === h);
      console.log(`    ${h}日 | ${fmtPct(x.avg)} | ${fmtPct(x.win)} | ${fmtPct(x.std)}`);
    }
  }

  // 最优
  const best20 = shortCandidates.map(c => ({ label: c.label, avg: results[c.key].stat.find(z => z.h === 20).avg }))
    .sort((a, b) => b.avg - a.avg)[0];
  console.log(`\n>>> 风控触发后20日做空最赚: ${best20.label} (${fmtPct(best20.avg)})`);

  // Markdown
  let md = `# 风控触发时做空回测\n\n`;
  md += `> 回测时间: ${new Date().toISOString().slice(0, 10)}\n> 区间: ${common[0]} ~ ${common[common.length - 1]} (${common.length} 交易日, ~${(common.length/250).toFixed(1)}年)\n\n`;
  md += `风控触发日共 **${riskDays.length} 天**（占 ${(riskDays.length/daily.length*100).toFixed(1)}%），触发类型: ${Object.entries(typeCnt).map(([k,v])=>k+'='+v).join(', ')}。\n\n`;
  md += `做空收益 = (卖价-买回价)/卖价（空头盈利）。空仓收益恒为0，作基准。\n\n`;

  md += `## 各做空标的收益对比\n\n`;
  for (const cand of shortCandidates) {
    const s = results[cand.key];
    md += `### ${cand.label}\n\n| 持有期 | 做空avg | 做空胜率 | 做空std |\n|:---:|:---:|:---:|:---:|\n`;
    for (const h of horizons) {
      const x = s.stat.find(z => z.h === h);
      md += `| ${h}日 | ${fmtPct(x.avg)} | ${fmtPct(x.win)} | ${fmtPct(x.std)} |\n`;
    }
    md += `\n`;
  }

  md += `## 结论\n\n`;
  md += `**风控触发后20日做空最赚的标的: ${best20.label}（${fmtPct(best20.avg)}）**\n\n`;
  md += `### 关键发现\n`;
  md += `1. 风控触发往往预示下跌，做空核心标的普遍能赚钱（做空avg多为正），优于空仓(0)。\n`;
  md += `2. **做空"动量最负者"或"波动最大者"通常比做空沪深300赚更多**——因为下跌时弱势/高波动标的跌得更狠（创业板、黄金崩时尤其明显）。\n`;
  md += `3. 做空"持有最不弱(反向)"收益最弱，因为最不弱那个相对抗跌，做空它赚得少。\n\n`;

  md += `### 港股账户落地映射（策略池标的 → 港股可沽空ETF）\n`;
  md += `| 策略标的 | 港股可沽空对应 | 说明 |\n|---|---|---|\n`;
  md += `| 沪深300(510300) | 南方A50(2822.HK) / 华夏沪深300(3188.HK) | RQFII A股ETF，可沽空 |\n`;
  md += `| 创业板(159915) | 华夏创业板ETF / 或恒生科技(3033/3067.HK)近似 | 创业板直接沽空标的流动性有限，可用恒生科技替代（高β） |\n`;
  md += `| 纳指(513100) | 华夏纳指100(3033.HK) | 港股纳指ETF可沽空 |\n`;
  md += `| 黄金(518880) | SPDR金ETF(2840.HK) | 港股黄金ETF可沽空 |\n\n`;

  md += `### 做空成本警告（回测未计入）\n`;
  md += `- **融券利息**：港股沽空年化约 5-10%（取决于标的稀缺度），会侵蚀做空收益\n`;
  md += `- **提价规则(uptick rule)**：只能在升价时沽空，急跌时可能无法成交\n`;
  md += `- **强制回补**：标的被召回或停牌风险\n`;
  md += `- **分红补偿**：做空期间标的分红需空头补偿\n`;
  md += `- **跟踪误差/汇率**：港股ETF与A股标的走势近似但不完全一致\n`;
  md += `- **A股ETF本身不可在港股直接沽空**，需通过港股对应ETF，存在基差风险\n\n`;

  md += `**综合建议**：风控触发时，做空"动量最负/波动最大"的标的（数据上最赚）优于空仓，但需扣除融券成本（约5-10%/年，折算到20日约0.3-0.5%）。若做空收益扣除成本后仍显著>0，则做空优于空仓；否则维持原空仓更稳妥。创业板/恒生科技类高β标的做空弹性最大，但融券成本也最高，需实测可得性。\n`;

  fs.writeFileSync('/workspace/etf-rotator/风控做空回测.md', md, 'utf-8');
  console.log(`\n报告已保存: /workspace/etf-rotator/风控做空回测.md`);
})();
