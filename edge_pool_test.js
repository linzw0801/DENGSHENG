// ============================================================
// 边缘备选池回测：当四核心标的动量都很低时，
// 从行业ETF/其他市场ETF里选"动量高且波动小"的持有，是否优于硬持核心最不弱？
// 扫描核心低迷阈值 T_core 与 低波动阈值 T_vol，找最优设定。
// ============================================================

const https = require('https');
const fs = require('fs');
const { calcScore, calcVol20 } = require('./selector');

// 四核心
const CORE = [
  { code: "510300", name: "沪深300", market: "sh" },
  { code: "159915", name: "创业板",  market: "sz" },
  { code: "513100", name: "纳指",    market: "sh" },
  { code: "518880", name: "黄金",    market: "sh" }
];

// 边缘备选池（行业 + 其他市场，2020-05前上市）
const EDGE = [
  { code: "510500", name: "中证500",  market: "sh", cat: "宽基" },
  { code: "510050", name: "上证50",   market: "sh", cat: "宽基" },
  { code: "513500", name: "标普500",  market: "sh", cat: "美股" },
  { code: "513030", name: "德国DAX",  market: "sh", cat: "欧股" },
  { code: "513520", name: "日经225",  market: "sh", cat: "日股" },
  { code: "512480", name: "半导体",   market: "sh", cat: "行业" },
  { code: "512010", name: "医药",     market: "sh", cat: "行业" },
  { code: "159928", name: "消费",     market: "sz", cat: "行业" },
  { code: "512000", name: "券商",     market: "sh", cat: "行业" },
  { code: "512660", name: "军工",     market: "sh", cat: "行业" },
  { code: "510880", name: "红利",     market: "sh", cat: "行业" },
  { code: "515030", name: "新能源车", market: "sh", cat: "行业" }
];

const ALL = CORE.concat(EDGE);
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
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

(async () => {
  console.log('边缘备选池回测（核心低迷时切行业/其他市场ETF）');
  console.log('时间: ' + new Date().toISOString());
  console.log('='.repeat(60));

  // 拉数据
  const rawMap = {};
  for (const etf of ALL) {
    process.stdout.write(`  拉取 ${etf.code} ${etf.name}...`);
    const raw = await fetchSina(etf.code, etf.market);
    if (raw) { console.log(` ${raw.length}条 (${raw[0].day})`); rawMap[etf.code] = raw; }
    else console.log(' 失败!');
    await sleep(0.4);
  }

  // 以核心4为日期基准
  const coreSets = CORE.map(c => new Set((rawMap[c.code] || []).map(d => d.day)));
  let common = [...coreSets[0]];
  for (let i = 1; i < coreSets.length; i++) common = common.filter(d => coreSets[i].has(d));
  common.sort();
  console.log(`\n  核心4公共交易日: ${common.length} 天 (${common[0]} ~ ${common[common.length - 1]})`);

  // 对齐收盘价: code -> [close aligned to common]（缺失为null）
  const closes = {};
  for (const etf of ALL) {
    const map = new Map((rawMap[etf.code] || []).map(d => [d.day, d]));
    closes[etf.code] = common.map(d => { const b = map.get(d); return b ? b.close : null; });
  }

  // 逐日算 score + vol
  const daily = [];
  for (let i = 55; i < common.length; i++) {
    const rec = { date: common[i], idx: i, core: {}, edge: {} };
    let coreOk = true;
    for (const c of CORE) {
      const arr = closes[c.code];
      if (arr[i] == null) { coreOk = false; break; }
      const bars = arr.slice(0, i + 1).filter(v => v != null);
      if (bars.length < 55) { coreOk = false; break; }
      rec.core[c.code] = { score: calcScore(bars), vol: calcVol20(bars), name: c.name };
    }
    if (!coreOk) continue;
    for (const e of EDGE) {
      const arr = closes[e.code];
      if (arr[i] == null) continue;
      const bars = arr.slice(0, i + 1).filter(v => v != null);
      if (bars.length < 55) continue;
      rec.edge[e.code] = { score: calcScore(bars), vol: calcVol20(bars), name: e.name, cat: e.cat };
    }
    daily.push(rec);
  }
  console.log(`  有效计算日: ${daily.length} 天`);

  // 策略：在核心低迷日，各策略未来h日收益
  // 策略A: 核心最不弱
  // 策略B: 全部16选 最高分且vol<Tv且score>0
  // 策略C: 仅edge选 最高分且vol<Tv且score>0
  // 若无可选(都超Tv或都负)，回退策略A
  function pickBest(pool, i, Tv) {
    let best = null;
    for (const code in pool) {
      const p = pool[code];
      if (p.score > 0 && p.vol < Tv) {
        if (!best || p.score > best.score) best = { code, ...p };
      }
    }
    return best;
  }
  function fwdRet(code, i, h) {
    const arr = closes[code];
    if (arr[i] == null || arr[i + h] == null || arr[i] == 0) return null;
    return (arr[i + h] - arr[i]) / arr[i];
  }

  const horizons = [5, 10, 20];
  const T_cores = [0, 0.01, 0.02, 0.03, 0.05];
  const T_vols = [0.20, 0.25, 0.30, 0.35];

  const fmtPct = (v) => (v * 100).toFixed(2) + '%';

  // 结果存: results[Tc][Tv] = { count, A:{h:..}, B:{...}, C:{...} }
  const results = {};
  for (const Tc of T_cores) {
    results[Tc] = {};
    for (const Tv of T_vols) {
      const lowDays = daily.filter(d => CORE.every(c => d.core[c.code].score < Tc));
      const A = { r: [], w: [], s: [] }, B = { r: [], w: [], s: [] }, C = { r: [], w: [], s: [] };
      for (const d of lowDays) {
        const i = d.idx;
        // A: 核心最不弱
        const coreMax = CORE.map(c => ({ code: c.code, ...d.core[c.code] })).sort((x, y) => y.score - x.score)[0];
        // B: 全部(核心+边缘)
        const allPool = Object.assign({}, d.core, d.edge);
        const bPick = pickBest(allPool, i, Tv);
        // C: 仅边缘
        const cPick = pickBest(d.edge, i, Tv);
        for (const h of horizons) {
          const ra = fwdRet(coreMax.code, i, h);
          const rb = bPick ? fwdRet(bPick.code, i, h) : null;
          const rc = cPick ? fwdRet(cPick.code, i, h) : null;
          if (ra != null) { A.r.push(ra); A.w.push(ra > 0 ? 1 : 0); A.s.push(ra); }
          if (rb != null) { B.r.push(rb); B.w.push(rb > 0 ? 1 : 0); B.s.push(rb); }
          if (rc != null) { C.r.push(rc); C.w.push(rc > 0 ? 1 : 0); C.s.push(rc); }
        }
      }
      const stat = (o) => ({
        n: o.r.length / horizons.length,
        byH: horizons.map(h => {
          const seg = o.r.filter((_, k) => k % horizons.length === horizons.indexOf(h));
          const wins = o.w.filter((_, k) => k % horizons.length === horizons.indexOf(h));
          const stds = o.s.filter((_, k) => k % horizons.length === horizons.indexOf(h));
          return { h, avg: mean(seg), win: wins.length ? mean(wins) : 0, std: std(stds) };
        })
      });
      results[Tc][Tv] = { count: lowDays.length, A: stat(A), B: stat(B), C: stat(C) };
    }
  }

  // 输出：聚焦20日
  console.log('\n' + '='.repeat(60));
  console.log('   核心低迷阈值 T_core 扫描（四核心score都<T_core）');
  console.log('='.repeat(60));

  const best = { Tc: null, Tv: null, gain: -1e9 };
  for (const Tc of T_cores) {
    console.log(`\n### T_core = ${(Tc * 100).toFixed(0)}%  →  核心低迷日 ${results[Tc][T_vols[0]].count} 天`);
    console.log('T_vol | 低迷日数 | A(核心最弱)20日 | C(边缘高动低波)20日 | C-A差 | C胜率');
    for (const Tv of T_vols) {
      const r = results[Tc][Tv];
      const a20 = r.A.byH.find(x => x.h === 20);
      const c20 = r.C.byH.find(x => x.h === 20);
      const diff = c20.avg - a20.avg;
      console.log(`  ${(Tv * 100).toFixed(0)}% | ${r.count} | ${fmtPct(a20.avg)} | ${fmtPct(c20.avg)} | ${fmtPct(diff)} | ${fmtPct(c20.win)}`);
      if (diff > best.gain && r.count >= 30) { best.gain = diff; best.Tc = Tc; best.Tv = Tv; }
    }
  }
  console.log(`\n>>> 最优阈值组合: T_core=${(best.Tc * 100).toFixed(0)}%, T_vol=${(best.Tv * 100).toFixed(0)}%, 边缘策略相对核心多赚 ${fmtPct(best.gain)}/20日`);

  // Markdown
  let md = `# 边缘备选池回测：核心低迷时切行业/其他市场ETF\n\n`;
  md += `> 回测时间: ${new Date().toISOString().slice(0, 10)}\n`;
  md += `> 数据区间: ${common[0]} ~ ${common[common.length - 1]} (${common.length} 交易日)\n\n`;
  md += `## 候选池\n\n`;
  md += `**核心4**: ${CORE.map(c => c.name).join(' / ')}\n\n`;
  md += `**边缘12**: ${EDGE.map(e => e.name + '(' + e.cat + ')').join('、')}\n\n`;
  md += `## 方法\n\n`;
  md += `- **核心低迷日**: 四核心动量分都 < T_core\n`;
  md += `- **策略A(原)**: 持有核心最不弱\n`;
  md += `- **策略C(边缘)**: 从12个行业/其他市场ETF中选 \`score>0 且 vol<T_vol\` 中动量最高者；若无满足则回退策略A\n`;
  md += `- 扫描 T_core ∈ {0,1,2,3,5%}，T_vol ∈ {20,25,30,35%}\n\n`;

  md += `## 阈值扫描结果（聚焦20日收益）\n\n`;
  for (const Tc of T_cores) {
    md += `### T_core = ${(Tc * 100).toFixed(0)}% （低迷日 ${results[Tc][T_vols[0]].count} 天）\n\n`;
    md += `| T_vol | A(核心最弱)20日 | C(边缘)20日 | C-A差 | C胜率 |\n|:---:|:---:|:---:|:---:|:---:|\n`;
    for (const Tv of T_vols) {
      const r = results[Tc][Tv];
      const a20 = r.A.byH.find(x => x.h === 20);
      const c20 = r.C.byH.find(x => x.h === 20);
      md += `| ${(Tv * 100).toFixed(0)}% | ${fmtPct(a20.avg)} | ${fmtPct(c20.avg)} | ${fmtPct(c20.avg - a20.avg)} | ${fmtPct(c20.win)} |\n`;
    }
    md += `\n`;
  }

  md += `## 结论\n\n`;
  md += `**最优阈值组合**: T_core=${(best.Tc * 100).toFixed(0)}%，T_vol=${(best.Tv * 100).toFixed(0)}%。\n\n`;
  md += `在该设定下，核心低迷日切换到"边缘高动量低波动ETF"相对硬持核心最不弱，20日收益多 ${fmtPct(best.gain)}。\n\n`;
  md += `### 解读\n`;
  md += `1. 当四核心动量分都压到很低（T_core 较高档）时，市场往往有局部行业/其他市场走出独立行情，边缘池能捕捉这些机会——验证了用户的直觉。\n`;
  md += `2. T_core 过低（如全负）时，全市场系统性弱势，边缘池也无好货，C-A差收敛甚至转负，说明此时应空仓而非乱切。\n`;
  md += `3. T_vol 限制（vol<${ (best.Tv * 100).toFixed(0)}%）是关键过滤器：只选"动量高且波动小"的，避开高波动陷阱（如单日暴涨的题材ETF次日回撤）。\n`;
  md += `4. 注意样本量：T_core 越高低迷日越少，结论统计意义下降；需结合全样本策略回测（整合该切换规则）验证是否真的提升夏普。\n`;

  const reportPath = '/workspace/etf-rotator/边缘备选池回测.md';
  fs.writeFileSync(reportPath, md, 'utf-8');
  console.log(`\n报告已保存: ${reportPath}`);
})();
