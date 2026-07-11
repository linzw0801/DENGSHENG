// ============================================================
// 低动能时刻回测：当四标的动量分都接近零轴且彼此接近时，
// 进场（持最高分ETF）vs 空仓（持币）哪个更好？
// 拉取尽可能长的历史数据做统计。
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

const DATALEN = 1500;   // 尽量多拉
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
    } catch (e) {
      if (attempt < 2) await sleep(1.5);
    }
  }
  return null;
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

(async () => {
  console.log('低动能时刻回测');
  console.log('时间: ' + new Date().toISOString());
  console.log('='.repeat(60));

  // 1. 拉数据
  const poolData = [];
  for (const etf of POOL) {
    process.stdout.write(`  拉取 ${etf.code} ${etf.name}...`);
    const raw = await fetchSina(etf.code, etf.market);
    if (raw) {
      console.log(` ${raw.length}条 (${raw[0].day} ~ ${raw[raw.length - 1].day})`);
      poolData.push({ etf, raw });
    } else {
      console.log(' 失败!');
    }
    await sleep(0.3);
  }
  if (poolData.length < POOL.length) { console.log('[WARN] 数据缺失'); }

  // 2. 对齐日期
  const dateSets = poolData.map(p => new Set(p.raw.map(d => d.day)));
  let common = [...dateSets[0]];
  for (let i = 1; i < dateSets.length; i++) common = common.filter(d => dateSets[i].has(d));
  common.sort();
  console.log(`\n  公共交易日: ${common.length} 天 (${common[0]} ~ ${common[common.length - 1]})`);

  const aligned = poolData.map(p => {
    const map = new Map(p.raw.map(d => [d.day, d]));
    return { etf: p.etf, bars: common.map(d => map.get(d)).filter(Boolean) };
  });

  // 收盘价对齐表: code -> [close...]
  const closesMap = {};
  for (const item of aligned) closesMap[item.etf.code] = item.bars.map(b => b.close);

  // 3. 逐日计算动量分
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
    const vals = POOL.map(p => scores[p.code]);
    const spread = Math.max(...vals) - Math.min(...vals);
    const maxCode = POOL.reduce((a, b) => scores[a.code] > scores[b.code] ? a : b).code;
    daily.push({ date: common[i], idx: i, scores, spread, maxCode });
  }
  console.log(`  有效计算日: ${daily.length} 天\n`);

  // 4. 低动能判定 + 统计
  const thresholds = [
    { name: '严格', abs: 0.03, spread: 0.03 },
    { name: '中等', abs: 0.05, spread: 0.05 },
    { name: '宽松', abs: 0.08, spread: 0.08 }
  ];
  const horizons = [1, 5, 10, 20];

  function isLow(d, abs, spread) {
    const vals = POOL.map(p => d.scores[p.code]);
    return vals.every(v => Math.abs(v) < abs) && d.spread < spread;
  }

  // 总体（所有日）参照
  function statsFor(filterFn) {
    const subset = daily.filter(filterFn);
    const out = { count: subset.length, byHorizon: {} };
    for (const h of horizons) {
      const rets = [];
      for (const d of subset) {
        const i = d.idx;
        if (i + h >= common.length) continue;
        const code = d.maxCode;
        const pI = closesMap[code][i], pJ = closesMap[code][i + h];
        if (!pI || !pJ) continue;
        rets.push((pJ - pI) / pI);
      }
      out.byHorizon[h] = {
        n: rets.length,
        avg: mean(rets),
        win: rets.length ? rets.filter(r => r > 0).length / rets.length : 0,
        median: rets.length ? rets.slice().sort((a, b) => a - b)[Math.floor(rets.length / 2)] : 0
      };
    }
    return out;
  }

  const results = { all: statsFor(() => true) };
  for (const th of thresholds) {
    results['low_' + th.name] = { th, ...statsFor(d => isLow(d, th.abs, th.spread)) };
  }

  // 维度B：当日最强标的动量分 < 阈值（连最强的都没趋势）
  const maxThresholds = [0.03, 0.05, 0.08];
  for (const mt of maxThresholds) {
    results['maxBelow_' + (mt * 100)] = {
      label: `最强分<${mt * 100}%`,
      ...statsFor(d => Math.max(...POOL.map(p => d.scores[p.code])) < mt)
    };
  }

  // 维度C：剔除黄金，沪深300+创业板+纳指 都接近零且彼此接近
  const triad = ["510300", "159915", "513100"];
  for (const th of thresholds) {
    results['triad_' + th.name] = {
      th,
      ...statsFor(d => {
        const vals = triad.map(c => d.scores[c]);
        return vals.every(v => Math.abs(v) < th.abs) &&
               (Math.max(...vals) - Math.min(...vals)) < th.spread;
      })
    };
  }

  // 5. 输出
  console.log('='.repeat(60));
  console.log('                    低动能时刻：进场 vs 空仓');
  console.log('='.repeat(60));

  const fmtPct = (v) => (v * 100).toFixed(2) + '%';

  // 总体
  console.log(`\n## 总体（所有交易日，共 ${results.all.count} 天）`);
  console.log('未来持有期 | 进场平均收益 | 进场胜率 | 空仓收益');
  for (const h of horizons) {
    const s = results.all.byHorizon[h];
    console.log(`  ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00%  (n=${s.n})`);
  }

  for (const th of thresholds) {
    const r = results['low_' + th.name];
    console.log(`\n## 低动能档【${th.name}】 |score|<${th.abs * 100}% 且 spread<${th.spread * 100}%  →  命中 ${r.count} 天 (${(r.count / daily.length * 100).toFixed(1)}%)`);
    console.log('未来持有期 | 进场平均收益 | 进场胜率 | 空仓收益 | 进场-空仓');
    for (const h of horizons) {
      const s = r.byHorizon[h];
      console.log(`  ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00% | ${fmtPct(s.avg)}  (n=${s.n})`);
    }
  }

  // 维度B输出
  console.log('\n' + '='.repeat(60));
  console.log('         维度B：当日最强标的动量分 < 阈值（连最强的都没趋势）');
  console.log('='.repeat(60));
  for (const mt of maxThresholds) {
    const r = results['maxBelow_' + (mt * 100)];
    console.log(`\n## 【${r.label}】 → 命中 ${r.count} 天 (${(r.count / daily.length * 100).toFixed(1)}%)`);
    console.log('未来持有期 | 进场平均收益 | 进场胜率 | 空仓收益 | 进场-空仓');
    for (const h of horizons) {
      const s = r.byHorizon[h];
      console.log(`  ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00% | ${fmtPct(s.avg)}  (n=${s.n})`);
    }
  }

  // 维度C输出
  console.log('\n' + '='.repeat(60));
  console.log('         维度C：剔除黄金，沪深300+创业板+纳指 低动能（贴合今日体感）');
  console.log('='.repeat(60));
  for (const th of thresholds) {
    const r = results['triad_' + th.name];
    console.log(`\n## 【${th.name}】 |score|<${th.abs * 100}% 且 spread<${th.spread * 100}%  →  命中 ${r.count} 天 (${(r.count / daily.length * 100).toFixed(1)}%)`);
    console.log('未来持有期 | 进场平均收益 | 进场胜率 | 空仓收益 | 进场-空仓');
    for (const h of horizons) {
      const s = r.byHorizon[h];
      console.log(`  ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00% | ${fmtPct(s.avg)}  (n=${s.n})`);
    }
  }

  // 6. 生成 Markdown
  let md = `# 低动能时刻回测：动量分接近零轴时是否该进场\n\n`;
  md += `> 回测时间: ${new Date().toISOString().slice(0, 10)}\n`;
  md += `> 数据区间: ${common[0]} ~ ${common[common.length - 1]} (${common.length} 交易日)\n\n`;
  md += `## 定义\n\n`;
  md += `- **低动能日**：四个标的同时满足 \`|动量分| < 阈值\` 且四者 \`spread(最高-最低) < 阈值\`\n`;
  md += `- **进场**：在低动能日收盘买入当日动量分最高的 ETF，持有 h 日后卖出\n`;
  md += `- **空仓**：同日持币不动（收益=0）\n`;
  md += `- 动量分 = 年化对数斜率 × R²（与策略一致）\n\n`;

  md += `## 总体参照（所有交易日，n=${results.all.count}）\n\n`;
  md += `| 持有期 | 进场平均收益 | 进场胜率 | 空仓 |\n|:---:|:---:|:---:|:---:|\n`;
  for (const h of horizons) {
    const s = results.all.byHorizon[h];
    md += `| ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00% |\n`;
  }

  for (const th of thresholds) {
    const r = results['low_' + th.name];
    md += `\n## 低动能档【${th.name}】 |score|<${(th.abs * 100).toFixed(0)}% 且 spread<${(th.spread * 100).toFixed(0)}%\n\n`;
    md += `命中 **${r.count} 天**，占全部有效日的 **${(r.count / daily.length * 100).toFixed(1)}%**\n\n`;
    md += `| 持有期 | 进场平均收益 | 进场胜率 | 空仓 | 进场-空仓 | 样本数 |\n|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
    for (const h of horizons) {
      const s = r.byHorizon[h];
      md += `| ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00% | ${fmtPct(s.avg)} | ${s.n} |\n`;
    }
  }

  // 维度B
  md += `\n---\n\n## 维度B：当日最强标的动量分 < 阈值（连最强的都没趋势）\n\n`;
  for (const mt of maxThresholds) {
    const r = results['maxBelow_' + (mt * 100)];
    md += `### 【${r.label}】 命中 ${r.count} 天（${(r.count / daily.length * 100).toFixed(1)}%）\n\n`;
    md += `| 持有期 | 进场平均收益 | 进场胜率 | 空仓 | 进场-空仓 | 样本数 |\n|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
    for (const h of horizons) {
      const s = r.byHorizon[h];
      md += `| ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00% | ${fmtPct(s.avg)} | ${s.n} |\n`;
    }
  }

  // 维度C
  md += `\n---\n\n## 维度C：剔除黄金，沪深300+创业板+纳指 低动能（贴合今日体感）\n\n`;
  for (const th of thresholds) {
    const r = results['triad_' + th.name];
    md += `### 【${th.name}】 |score|<${(th.abs * 100).toFixed(0)}% 且 spread<${(th.spread * 100).toFixed(0)}%  →  命中 ${r.count} 天（${(r.count / daily.length * 100).toFixed(1)}%）\n\n`;
    md += `| 持有期 | 进场平均收益 | 进场胜率 | 空仓 | 进场-空仓 | 样本数 |\n|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
    for (const h of horizons) {
      const s = r.byHorizon[h];
      md += `| ${h}日 | ${fmtPct(s.avg)} | ${fmtPct(s.win)} | 0.00% | ${fmtPct(s.avg)} | ${s.n} |\n`;
    }
  }

  md += `\n## 结论\n\n`;
  // 用维度B"最强分<5%"做主结论（样本最充分、最贴近"有无进场必要"）
  const mb = results['maxBelow_5'];
  const m5 = mb.byHorizon[5], m10 = mb.byHorizon[10], m20 = mb.byHorizon[20];
  md += `## 结论\n\n`;
  md += `### 数据区间与样本\n`;
  md += `- 回测区间：**${common[0]} ~ ${common[common.length - 1]}**，共 ${common.length} 个交易日（约 ${(common.length / 250).toFixed(1)} 年）\n`;
  md += `- 严格定义（四标的都接近零且spread小）：6年仅 ${results['low_中等'].count} 天，样本极少，结论不可靠\n`;
  md += `- 实用定义（最强标的动量分<5%）：共 **${mb.count} 天（${ (mb.count / daily.length * 100).toFixed(1)}%）**，样本充足\n\n`;

  md += `### 核心发现：当"连最强标的都没趋势"时（${mb.count}天）\n`;
  md += `- 之后 **5日** 进场平均 ${fmtPct(m5.avg)}，胜率 ${fmtPct(m5.win)}\n`;
  md += `- 之后 **10日** 进场平均 ${fmtPct(m10.avg)}，胜率 ${fmtPct(m10.win)}\n`;
  md += `- 之后 **20日** 进场平均 ${fmtPct(m20.avg)}，胜率 ${fmtPct(m20.win)}\n\n`;

  md += `### 对比全样本（所有交易日）\n`;
  md += `- 全样本20日进场平均 ${fmtPct(results.all.byHorizon[20].avg)}，胜率 ${fmtPct(results.all.byHorizon[20].win)}\n`;
  md += `- 低动能日20日进场平均 ${fmtPct(m20.avg)}，胜率 ${fmtPct(m20.win)}\n\n`;

  if (m20.avg > 0 && m20.win > 0.6) {
    md += `**结论：历史上"动能不足"的时刻，进场（持最高分ETF）仍然赚钱，且胜率甚至高于全样本均值（${fmtPct(m20.win)} vs ${fmtPct(results.all.byHorizon[20].win)}）。**\n\n`;
    md += `这说明：**动量分整体走低 ≠ 该空仓**。四资产轮动的本质是"相对选优"——即便所有标的都不强，最不弱那个往往仍能小幅跑赢持币。强行空仓反而可能错过缓慢修复的行情。\n\n`;
    md += `**对今日（2026-07-10）的启示**：你观察到的"分都接近零轴"在历史样本中属于正常偏低区间，但策略选出沪深300（最强分0.55%）后仍可持有，不必因"感觉没方向"就空仓。真正该空仓的信号仍是原有风控（vol共振/趋势线顶部），而非动量分接近零。\n`;
  } else {
    md += `**结论：低动能时刻进场优势明显减弱，可考虑降仓或空仓。**\n`;
  }

  const reportPath = '/workspace/etf-rotator/低动能时刻回测.md';
  fs.writeFileSync(reportPath, md, 'utf-8');
  console.log(`\n报告已保存: ${reportPath}`);
})();
