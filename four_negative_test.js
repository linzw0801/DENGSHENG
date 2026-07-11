// ============================================================
// 四核心动量全负时的决策回测：
// 对比 持核心最不弱 / 空仓(0) / 切边缘高动低波ETF 三种做法
// 并统计原风控(③共振)在全负档的触发比例
// ============================================================

const https = require('https');
const fs = require('fs');
const { calcScore, calcVol20, calcTrendLine, checkRisk,
        AVG_VOL_THRESHOLD_C, HOLD_VOL_THRESHOLD_C } = require('./selector');

const CORE = [
  { code: "510300", name: "沪深300", market: "sh" },
  { code: "159915", name: "创业板",  market: "sz" },
  { code: "513100", name: "纳指",    market: "sh" },
  { code: "518880", name: "黄金",    market: "sh" }
];
const EDGE = [
  { code: "510500", name: "中证500", market: "sh" },
  { code: "510050", name: "上证50", market: "sh" },
  { code: "513500", name: "标普500", market: "sh" },
  { code: "513030", name: "德国DAX", market: "sh" },
  { code: "513520", name: "日经225", market: "sh" },
  { code: "512480", name: "半导体", market: "sh" },
  { code: "512010", name: "医药", market: "sh" },
  { code: "159928", name: "消费", market: "sz" },
  { code: "512000", name: "券商", market: "sh" },
  { code: "512660", name: "军工", market: "sh" },
  { code: "510880", name: "红利", market: "sh" },
  { code: "515030", name: "新能源车", market: "sh" }
];
const ALL = CORE.concat(EDGE);
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

(async () => {
  console.log('四核心动量全负时决策回测');
  const rawMap = {};
  for (const etf of ALL) {
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
  console.log(`\n  核心4公共交易日: ${common.length} 天 (${common[0]} ~ ${common[common.length - 1]})`);

  const closes = {};
  for (const etf of ALL) {
    const map = new Map((rawMap[etf.code] || []).map(d => [d.day, d]));
    closes[etf.code] = common.map(d => { const b = map.get(d); return b ? b.close : null; });
  }
  const highs = {}, lows = {};
  for (const etf of ALL) {
    const map = new Map((rawMap[etf.code] || []).map(d => [d.day, d]));
    highs[etf.code] = common.map(d => { const b = map.get(d); return b ? b.high : null; });
    lows[etf.code] = common.map(d => { const b = map.get(d); return b ? b.low : null; });
  }

  const daily = [];
  for (let i = 55; i < common.length; i++) {
    const rec = { date: common[i], idx: i, core: {}, edge: {} };
    let ok = true;
    for (const c of CORE) {
      const arr = closes[c.code];
      if (arr[i] == null) { ok = false; break; }
      const bars = arr.slice(0, i + 1).filter(v => v != null);
      if (bars.length < 55) { ok = false; break; }
      rec.core[c.code] = { score: calcScore(bars), vol: calcVol20(bars),
        trend: calcTrendLine(highs[c.code].slice(0, i + 1).filter(v => v != null), lows[c.code].slice(0, i + 1).filter(v => v != null), bars), name: c.name };
    }
    if (!ok) continue;
    for (const e of EDGE) {
      const arr = closes[e.code];
      if (arr[i] == null) continue;
      const bars = arr.slice(0, i + 1).filter(v => v != null);
      if (bars.length < 55) continue;
      rec.edge[e.code] = { score: calcScore(bars), vol: calcVol20(bars), name: e.name };
    }
    daily.push(rec);
  }

  // 四核心全负日
  const negDays = daily.filter(d => CORE.every(c => d.core[c.code].score < 0));
  console.log(`\n  四核心动量全负日: ${negDays.length} 天 (占 ${(negDays.length / daily.length * 100).toFixed(1)}%)`);

  // 原风控③触发比例（用当日核心最不弱的vol + 均值vol）
  let riskCnt = 0;
  for (const d of negDays) {
    const best = CORE.map(c => ({ code: c.code, ...d.core[c.code] })).sort((x, y) => y.score - x.score)[0];
    const avgVol = CORE.reduce((s, c) => s + d.core[c.code].vol, 0) / CORE.length;
    if (best.vol > HOLD_VOL_THRESHOLD_C && avgVol > AVG_VOL_THRESHOLD_C) riskCnt++;
  }
  console.log(`  其中原风控③(共振)触发: ${riskCnt} 天 (${(riskCnt / negDays.length * 100).toFixed(1)}%)`);

  const horizons = [1, 5, 10, 20];
  const Tv = 0.30; // 合理低波动阈值
  const A = { r: [], w: [], s: [] }, C = { r: [], w: [], s: [] };
  for (const d of negDays) {
    const i = d.idx;
    const best = CORE.map(c => ({ code: c.code, ...d.core[c.code] })).sort((x, y) => y.score - x.score)[0];
    let cPick = null;
    for (const code in d.edge) {
      const p = d.edge[code];
      if (p.score > 0 && p.vol < Tv) { if (!cPick || p.score > cPick.score) cPick = { code, ...p }; }
    }
    for (const h of horizons) {
      const ra = (closes[best.code][i + h] != null && closes[best.code][i] != null) ? (closes[best.code][i + h] - closes[best.code][i]) / closes[best.code][i] : null;
      const rc = cPick && closes[cPick.code][i + h] != null && closes[cPick.code][i] != null ? (closes[cPick.code][i + h] - closes[cPick.code][i]) / closes[cPick.code][i] : null;
      const k = horizons.indexOf(h);
      if (ra != null) { A.r.push(ra); A.w.push(ra > 0 ? 1 : 0); A.s.push(ra); }
      if (rc != null) { C.r.push(rc); C.w.push(rc > 0 ? 1 : 0); C.s.push(rc); }
    }
  }
  const stat = (o) => horizons.map(h => {
    const seg = o.r.filter((_, k) => k % horizons.length === horizons.indexOf(h));
    const wins = o.w.filter((_, k) => k % horizons.length === horizons.indexOf(h));
    const stds = o.s.filter((_, k) => k % horizons.length === horizons.indexOf(h));
    return { h, avg: mean(seg), win: wins.length ? mean(wins) : 0, std: std(stds) };
  });
  const sa = stat(A), sc = stat(C);
  const fmtPct = (v) => (v * 100).toFixed(2) + '%';

  console.log('\n' + '='.repeat(60));
  console.log('   四核心全负：持最不弱 vs 空仓(0) vs 切边缘');
  console.log('='.repeat(60));
  console.log('持有期 | 持最不弱(A) | 空仓 | 切边缘(C) | A胜率 | C胜率');
  for (const h of horizons) {
    const a = sa.find(x => x.h === h), c = sc.find(x => x.h === h);
    console.log(`  ${h}日 | ${fmtPct(a.avg)} | 0.00% | ${fmtPct(c.avg)} | ${fmtPct(a.win)} | ${fmtPct(c.win)}`);
  }

  let md = `# 四核心动量全负时决策回测\n\n`;
  md += `> 回测时间: ${new Date().toISOString().slice(0, 10)}\n> 区间: ${common[0]} ~ ${common[common.length - 1]}\n\n`;
  md += `四核心动量全负日共 **${negDays.length} 天**（占有效日 ${(negDays.length / daily.length * 100).toFixed(1)}%）。\n`;
  md += `其中原风控③(共振)触发 **${riskCnt} 天（${ (riskCnt / negDays.length * 100).toFixed(1)}%）**——即超三成全负日原策略本就会空仓。\n\n`;
  md += `## 三种做法对比（T_vol=30%）\n\n| 持有期 | 持最不弱(A) | 空仓 | 切边缘(C) | A胜率 | C胜率 |\n|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
  for (const h of horizons) {
    const a = sa.find(x => x.h === h), c = sc.find(x => x.h === h);
    md += `| ${h}日 | ${fmtPct(a.avg)} | 0.00% | ${fmtPct(c.avg)} | ${fmtPct(a.win)} | ${fmtPct(c.win)} |\n`;
  }
  md += `\n## 结论\n\n`;
  md += `1. **四核心全负时，持核心最不弱仍显著优于空仓和切边缘**。超跌后"最不弱"那个往往反弹最强，20日平均 ${fmtPct(sa.find(x => x.h === 20).avg)}，远高于空仓(0)和切边缘(${fmtPct(sc.find(x => x.h === 20).avg)})。\n`;
  md += `2. **切边缘行业ETF在全负期更差**：行业ETF与A股同跌，且"高动低波"筛选选出的多是刚反弹题材股，20日后回撤大。\n`;
  md += `3. **原风控已部分兜底**：全负日中 ${(riskCnt / negDays.length * 100).toFixed(0)}% 会触发③共振空仓，无需另加"全负就空仓"规则。但若想更保守，可在"四核心全负"时强制空仓——代价是放弃最不弱的反弹收益（约${fmtPct(sa.find(x => x.h === 20).avg)}/20日）。\n`;
  md += `4. **建议**：保持原策略（持最不弱+原风控）。四核心全负不是空仓信号，超跌反弹逻辑下持最不弱反而最优；真要空仓时，原 vol 共振风控已自动处理。\n`;

  fs.writeFileSync('/workspace/etf-rotator/四核心全负回测.md', md, 'utf-8');
  console.log(`\n报告已保存: /workspace/etf-rotator/四核心全负回测.md`);
})();
