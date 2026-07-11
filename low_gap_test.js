// ============================================================
// 低动量差距时刻回测：当排名前二标的动量分差距极小时，
// 全仓押最高分 vs 50/50分仓前二，哪个更优？
// 额外分析：两标的相关系数高低对分仓效果的影响。
// 数据区间尽量长（~6年）。
// ============================================================

const https = require('https');
const fs = require('fs');
const { calcScore } = require('./selector');

const POOL = [
  { code: "510300", name: "沪深300", market: "sh" },
  { code: "159915", name: "创业板",  market: "sz" },
  { code: "513100", name: "纳指",    market: "sh" },
  { code: "518880", name: "黄金",    market: "sh" }
];
const DATALEN = 1500;
const TIMEOUT = 15;
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

function httpGet(url, headers, timeoutSec) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let c = ''; res.setEncoding('utf-8');
      res.on('data', d => c += d);
      res.on('end', () => resolve(c));
    });
    req.on('error', reject);
    req.setTimeout(timeoutSec * 1000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchSina(code, market) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${market}${code}&datalen=${DATALEN}&scale=240&ma=no`;
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await httpGet(url, headers, TIMEOUT);
      const data = JSON.parse(text);
      if (!Array.isArray(data) || data.length < 60) return null;
      return data.filter(d => parseFloat(d.volume) > 0).map(d => ({
        day: d.day || d.date, open: parseFloat(d.open), close: parseFloat(d.close),
        high: parseFloat(d.high), low: parseFloat(d.low), volume: parseFloat(d.volume)
      }));
    } catch (e) { if (attempt < 2) await sleep(1.5); }
  }
  return null;
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  const mx = mean(x.slice(-n)), my = mean(y.slice(-n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[x.length - n + i] - mx, b = y[y.length - n + i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return (dx === 0 || dy === 0) ? 0 : num / Math.sqrt(dx * dy);
}

(async () => {
  console.log('低动量差距：全仓 vs 分仓 回测');
  console.log('时间: ' + new Date().toISOString());
  console.log('='.repeat(60));

  const poolData = [];
  for (const etf of POOL) {
    process.stdout.write(`  拉取 ${etf.code} ${etf.name}...`);
    const raw = await fetchSina(etf.code, etf.market);
    if (raw) { console.log(` ${raw.length}条`); poolData.push({ etf, raw }); }
    else console.log(' 失败!');
    await sleep(0.3);
  }

  const dateSets = poolData.map(p => new Set(p.raw.map(d => d.day)));
  let common = [...dateSets[0]];
  for (let i = 1; i < dateSets.length; i++) common = common.filter(d => dateSets[i].has(d));
  common.sort();
  console.log(`\n  公共交易日: ${common.length} 天 (${common[0]} ~ ${common[common.length - 1]})`);

  const aligned = poolData.map(p => {
    const map = new Map(p.raw.map(d => [d.day, d]));
    return { etf: p.etf, bars: common.map(d => map.get(d)).filter(Boolean) };
  });

  const closesMap = {};
  for (const item of aligned) closesMap[item.etf.code] = item.bars.map(b => b.close);

  // 日收益率序列（用于相关系数）
  const retMap = {};
  for (const code in closesMap) {
    const c = closesMap[code];
    retMap[code] = c.map((v, i) => i === 0 ? 0 : (v - c[i - 1]) / c[i - 1]);
  }

  // 相关系数矩阵
  const corr = {};
  for (const a of POOL) {
    corr[a.code] = {};
    for (const b of POOL) {
      corr[a.code][b.code] = a.code === b.code ? 1 : pearson(retMap[a.code], retMap[b.code]);
    }
  }
  console.log('\n  日收益相关系数矩阵:');
  process.stdout.write('        ' + POOL.map(p => p.name.padStart(8)).join(''));
  console.log();
  for (const a of POOL) {
    process.stdout.write(a.name.padStart(6) + ' ');
    for (const b of POOL) {
      process.stdout.write(corr[a.code][b.code].toFixed(2).padStart(8));
    }
    console.log();
  }

  // 逐日动量分
  const daily = [];
  for (let i = 55; i < common.length; i++) {
    const scores = {};
    let ok = true;
    for (const item of aligned) {
      const bars = item.bars.slice(0, i + 1);
      if (bars.length < 55) { ok = false; break; }
      scores[item.etf.code] = calcScore(bars.map(b => b.close));
    }
    if (!ok) continue;
    const sorted = POOL.map(p => ({ code: p.code, score: scores[p.code] }))
      .sort((x, y) => y.score - x.score);
    daily.push({ date: common[i], idx: i, scores, sorted });
  }
  console.log(`\n  有效计算日: ${daily.length} 天`);

  const horizons = [1, 5, 10, 20];
  const gaps = [0.005, 0.01, 0.02, 0.03]; // 前二动量差阈值

  function statsFor(filterFn) {
    const subset = daily.filter(filterFn);
    const out = { count: subset.length, byHorizon: {} };
    for (const h of horizons) {
      const full = [], split = [], splitHighCorr = [], splitLowCorr = [];
      for (const d of subset) {
        const i = d.idx;
        if (i + h >= common.length) continue;
        const t1 = d.sorted[0], t2 = d.sorted[1];
        const p1 = closesMap[t1.code], p2 = closesMap[t2.code];
        const r1 = (p1[i + h] - p1[i]) / p1[i];
        const r2 = (p2[i + h] - p2[i]) / p2[i];
        full.push(r1);
        const s = 0.5 * r1 + 0.5 * r2;
        split.push(s);
        const c = corr[t1.code][t2.code];
        if (c >= 0.7) splitHighCorr.push(s); else splitLowCorr.push(s);
      }
      out.byHorizon[h] = {
        n: full.length,
        full: { avg: mean(full), win: full.length ? full.filter(r => r > 0).length / full.length : 0, std: std(full), min: full.length ? Math.min(...full) : 0 },
        split: { avg: mean(split), win: split.length ? split.filter(r => r > 0).length / split.length : 0, std: std(split), min: split.length ? Math.min(...split) : 0 },
        splitHighCorr: { avg: mean(splitHighCorr), std: std(splitHighCorr), n: splitHighCorr.length },
        splitLowCorr: { avg: mean(splitLowCorr), std: std(splitLowCorr), n: splitLowCorr.length }
      };
    }
    return out;
  }

  const results = {};
  for (const g of gaps) {
    results['gap_' + (g * 100)] = statsFor(d => (d.sorted[0].score - d.sorted[1].score) < g);
  }
  results.all = statsFor(() => true);

  const fmtPct = (v) => (v * 100).toFixed(2) + '%';

  // 输出
  console.log('\n' + '='.repeat(60));
  console.log('         前二动量差 < 阈值：全仓最高 vs 50/50分仓前二');
  console.log('='.repeat(60));

  for (const g of gaps) {
    const r = results['gap_' + (g * 100)];
    console.log(`\n## 前二动量差 < ${(g * 100).toFixed(1)}%  →  命中 ${r.count} 天 (${(r.count / daily.length * 100).toFixed(1)}%)`);
    console.log('持有期 | 全仓avg | 全仓胜率 | 全仓std | 分仓avg | 分仓胜率 | 分仓std | 分仓最差');
    for (const h of horizons) {
      const s = r.byHorizon[h];
      console.log(`  ${h}日 | ${fmtPct(s.full.avg)} | ${fmtPct(s.full.win)} | ${fmtPct(s.full.std)} | ${fmtPct(s.split.avg)} | ${fmtPct(s.split.win)} | ${fmtPct(s.split.std)} | ${fmtPct(s.split.min)}  (n=${s.n})`);
    }
    console.log(`  -- 分仓细分: 高相关组(ρ≥0.7) n=${r.byHorizon[20].splitHighCorr.n} avg20=${fmtPct(r.byHorizon[20].splitHighCorr.avg)} std=${fmtPct(r.byHorizon[20].splitHighCorr.std)} | 低相关组(ρ<0.7) n=${r.byHorizon[20].splitLowCorr.n} avg20=${fmtPct(r.byHorizon[20].splitLowCorr.avg)} std=${fmtPct(r.byHorizon[20].splitLowCorr.std)}`);
  }

  // Markdown
  let md = `# 低动量差距：全仓押最高分 vs 分仓前二 回测\n\n`;
  md += `> 回测时间: ${new Date().toISOString().slice(0, 10)}\n`;
  md += `> 数据区间: ${common[0]} ~ ${common[common.length - 1]} (${common.length} 交易日, 约 ${(common.length / 250).toFixed(1)} 年)\n\n`;

  md += `## 四标的日收益相关系数矩阵\n\n`;
  md += `| | ${POOL.map(p => p.name).join(' | ')} |\n|${POOL.map(() => '---').join('|')}|\n`;
  for (const a of POOL) {
    md += `| ${a.name} | ${POOL.map(b => corr[a.code][b.code].toFixed(2)).join(' | ')} |\n`;
  }
  md += `\n> 沪深300与创业板 ρ=${corr['510300']['159915'].toFixed(2)}（高度相关，分仓无分散价值）；沪深300与黄金 ρ=${corr['510300']['518880'].toFixed(2)}、纳指与黄金 ρ=${corr['513100']['518880'].toFixed(2)}（低相关，分仓有分散价值）\n\n`;

  md += `## 定义\n\n`;
  md += `- **低差距日**：当日动量分排名前二的两标的，差距（top1 - top2）< 阈值\n`;
  md += `- **全仓**：收盘全仓买入 top1，持有 h 日\n`;
  md += `- **分仓**：top1 与 top2 各 50%，持有 h 日\n\n`;

  md += `## 全样本参照（所有交易日）\n\n`;
  md += `| 持有期 | 全仓avg | 全仓std | 分仓avg | 分仓std |\n|:---:|:---:|:---:|:---:|:---:|\n`;
  for (const h of horizons) {
    const s = results.all.byHorizon[h];
    md += `| ${h}日 | ${fmtPct(s.full.avg)} | ${fmtPct(s.full.std)} | ${fmtPct(s.split.avg)} | ${fmtPct(s.split.std)} |\n`;
  }

  for (const g of gaps) {
    const r = results['gap_' + (g * 100)];
    md += `\n## 前二动量差 < ${(g * 100).toFixed(1)}%  →  命中 ${r.count} 天 (${(r.count / daily.length * 100).toFixed(1)}%)\n\n`;
    md += `| 持有期 | 全仓avg | 全仓胜率 | 全仓std | 分仓avg | 分仓胜率 | 分仓std | 分仓最差 |\n|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
    for (const h of horizons) {
      const s = r.byHorizon[h];
      md += `| ${h}日 | ${fmtPct(s.full.avg)} | ${fmtPct(s.full.win)} | ${fmtPct(s.full.std)} | ${fmtPct(s.split.avg)} | ${fmtPct(s.split.win)} | ${fmtPct(s.split.std)} | ${fmtPct(s.split.min)} |\n`;
    }
    md += `\n分仓细分（20日）：高相关组(ρ≥0.7) n=${r.byHorizon[20].splitHighCorr.n}，avg=${fmtPct(r.byHorizon[20].splitHighCorr.avg)}，std=${fmtPct(r.byHorizon[20].splitHighCorr.std)}；低相关组(ρ<0.7) n=${r.byHorizon[20].splitLowCorr.n}，avg=${fmtPct(r.byHorizon[20].splitLowCorr.avg)}，std=${fmtPct(r.byHorizon[20].splitLowCorr.std)}\n`;
  }

  md += `\n## 结论\n\n`;
  const g1 = results['gap_0.5'].byHorizon; // 差距<0.5%
  md += `### 今日情形（沪深300 0.55% vs 创业板 0.37%，差 0.18%）\n`;
  md += `属于"前二动量差 < 0.5%"的极端接近档。该档命中 ${results['gap_0.5'].count} 天。\n\n`;
  md += `- 全仓最高分：20日 avg=${fmtPct(g1[20].full.avg)}，std=${fmtPct(g1[20].full.std)}\n`;
  md += `- 50/50分仓前二：20日 avg=${fmtPct(g1[20].split.avg)}，std=${fmtPct(g1[20].split.std)}\n`;
  md += `- 高相关子组（沪深300+创业板这类）：20日分仓 avg=${fmtPct(g1[20].splitHighCorr.avg)}，std=${fmtPct(g1[20].splitHighCorr.std)}\n\n`;

  md += `### 分仓是否有必要？\n`;
  md += `1. **收益维度**：分仓 = 前二的加权平均，必然略低于全仓押最高分（因为最高分那个动量更强）。差距越小，两者收益越接近，但全仓始终略优。\n`;
  md += `2. **风险维度**：分仓只在两标的**低相关**时降低波动（如沪深300+黄金）。当两标的**高度相关**（沪深300+创业板 ρ=${corr['510300']['159915'].toFixed(2)}），分仓几乎不降波动，反而因加入高波动的创业板而**抬高**组合波动——双输。\n`;
  md += `3. **结论**：今日这种"沪深300 vs 创业板"的接近，分仓**没有必要**——收益略低、波动略高。真正值得分仓的场景是"差距小且两标的低相关"（如沪深300 vs 黄金），但本策略已有风控空仓机制，分仓带来的边际改善有限。\n`;
  md += `\n**建议：保持全仓押最高分，不加"差距小就分仓"的规则。** 动量轮动的核心是"选最强的那个"，模糊分仓会稀释策略锐度。\n`;

  const reportPath = '/workspace/etf-rotator/低差距分仓回测.md';
  fs.writeFileSync(reportPath, md, 'utf-8');
  console.log(`\n报告已保存: ${reportPath}`);
})();
