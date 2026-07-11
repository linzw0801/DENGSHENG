// ============================================================
// ETF 轮动策略回测对比
// 方案A: 沪深300 / 创业板 / 纳指 / 黄金
// 方案B: 沪深300 / 科创50 / 纳指 / 黄金
// 策略: 每日选 momentum score 最高的 ETF 持有，触发风控则空仓
// 回测周期: 拉取尽量长的日K数据，逐日滚动计算
// ============================================================

const https = require('https');
const http = require('http');

const { calcScore, calcVol20, calcTrendLine, checkRisk,
        AVG_VOL_THRESHOLD, TREND_THRESHOLD,
        HOLD_VOL_THRESHOLD_B, HOLD_VOL_THRESHOLD_C,
        AVG_VOL_THRESHOLD_C } = require('./selector');

// ---- 回测参数 ----
const BACKTEST_DAYS = 800;   // 拉取约3年多日K数据
const N = 25;
const VOL_WINDOW = 20;
const TRADING_DAYS = 250;
const TIMEOUT = 12;

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

// ---- 两个 ETF 池 ----
const POOL_A = [
  { code: "510300", name: "沪深300", market: "sh" },
  { code: "159915", name: "创业板",  market: "sz" },
  { code: "513100", name: "纳指",    market: "sh" },
  { code: "518880", name: "黄金",    market: "sh" }
];

const POOL_B = [
  { code: "510300", name: "沪深300", market: "sh" },
  { code: "588080", name: "科创50",  market: "sh" },
  { code: "513100", name: "纳指",    market: "sh" },
  { code: "518880", name: "黄金",    market: "sh" }
];

// ---- 通用 HTTPS GET (不依赖全局 fetch) ----
function httpGet(url, headers, timeoutSec) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let chunks = '';
      res.setEncoding('utf-8');
      res.on('data', d => { chunks += d; });
      res.on('end', () => resolve(chunks));
    });
    req.on('error', reject);
    req.setTimeout(timeoutSec * 1000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

// ---- 数据拉取 ----
async function fetchEastmoney(code, market) {
  const secid = (market === "sh" ? "1." : "0.") + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=${BACKTEST_DAYS}`;
  const headers = { "User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/" };
  const text = await httpGet(url, headers, TIMEOUT);
  const d = JSON.parse(text);
  if (!d || !d.data || !d.data.klines) return null;
  const valid = d.data.klines.map(k => k.split(","))
    .filter(r => parseFloat(r[5]) > 0)
    .map(r => ({
      day: r[0], open: parseFloat(r[1]), close: parseFloat(r[2]),
      high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5])
    }));
  return valid.length >= 60 ? valid : null;
}

async function fetchSina(code, market) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${market}${code}&datalen=${BACKTEST_DAYS}&scale=240&ma=no`;
  const headers = { "User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn" };
  const text = await httpGet(url, headers, TIMEOUT);
  const data = JSON.parse(text);
  if (!Array.isArray(data) || data.length < 60) return null;
  return data.filter(d => parseFloat(d.volume) > 0).map(d => ({
    day: d.day || d.date, open: parseFloat(d.open), close: parseFloat(d.close),
    high: parseFloat(d.high), low: parseFloat(d.low), volume: parseFloat(d.volume)
  }));
}

async function fetchKlines(code, market) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchEastmoney(code, market);
      if (r) return r;
    } catch (e) {
      console.log(`  [ERR] ${code} 东财 #${attempt + 1}: ${e.message || e}`);
    }
    if (attempt < 2) await sleep(1.5);
  }
  console.log(`  [INFO] ${code} 切换新浪...`);
  try {
    const r = await fetchSina(code, market);
    if (r) return r;
  } catch (e) {
    console.log(`  [ERR] ${code} 新浪: ${e.message || e}`);
  }
  return null;
}

// ---- 对齐日期: 所有ETF取公共交易日 ----
function alignDates(poolData) {
  // poolData: [{ etf, raw }, ...]
  // 找到所有ETF共有的日期集合
  const dateSets = poolData.map(p => new Set(p.raw.map(d => d.day)));
  let common = [...dateSets[0]];
  for (let i = 1; i < dateSets.length; i++) {
    common = common.filter(d => dateSets[i].has(d));
  }
  common.sort();
  console.log(`  公共交易日: ${common.length} 天 (${common[0]} ~ ${common[common.length - 1]})`);

  // 按公共日期重建每只ETF的K线序列
  const aligned = poolData.map(p => {
    const map = new Map(p.raw.map(d => [d.day, d]));
    return {
      etf: p.etf,
      bars: common.map(d => map.get(d)).filter(Boolean)
    };
  });
  return { dates: common, aligned };
}

// ---- 单日选股 (与 selector.js run() 逻辑一致) ----
function selectForDay(aligned, dayIdx) {
  // 从每只ETF的K线中截取到 dayIdx（含）的数据
  const results = [];
  for (const item of aligned) {
    const bars = item.bars.slice(0, dayIdx + 1);
    if (bars.length < 55) continue; // 趋势线需要至少55根
    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    results.push({
      code: item.etf.code,
      name: item.etf.name,
      score: calcScore(closes),
      vol: calcVol20(closes),
      trend: calcTrendLine(highs, lows, closes),
      price: closes[closes.length - 1]
    });
  }
  if (results.length === 0) return null;
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  const avgVol = results.reduce((a, r) => a + r.vol, 0) / results.length;
  const { triggered } = checkRisk(avgVol, best.vol, best.trend);
  return { best, triggered, avgVol };
}

// ---- 回测主流程 ----
async function backtest(pool, label) {
  console.log(`\n========== 回测: ${label} ==========`);
  console.log(`ETF池: ${pool.map(p => p.code + p.name).join(', ')}`);

  // 拉取数据
  const poolData = [];
  for (const etf of pool) {
    process.stdout.write(`  拉取 ${etf.code} ${etf.name}...`);
    const raw = await fetchKlines(etf.code, etf.market);
    if (raw) {
      console.log(` ${raw.length}条 (${raw[0].day} ~ ${raw[raw.length - 1].day})`);
      poolData.push({ etf, raw });
    } else {
      console.log(` 失败!`);
    }
    await sleep(0.3);
  }

  if (poolData.length < pool.length) {
    console.log(`  [WARN] 部分ETF数据缺失，回测结果可能不准确`);
  }
  if (poolData.length === 0) return null;

  // 对齐日期
  const { dates, aligned } = alignDates(poolData);
  const totalDays = dates.length;

  // 从第55个交易日开始（趋势线需要55根K线），实际从 max(55, N+1) = 55 开始
  const startIdx = 55;

  // 回测
  let position = null;   // { code, entryPrice, entryDay }
  let cashReturn = 0;    // 累计收益率
  let trades = 0;
  let wins = 0;
  let maxDrawdown = 0;
  let peak = 1.0;

  const dailyReturns = [];
  const tradeLog = [];
  let holdDays = 0;
  const holdCount = {};  // 每只ETF持有天数

  for (let i = startIdx; i < totalDays; i++) {
    const sel = selectForDay(aligned, i - 1); // 用昨天的数据做决策
    if (!sel) continue;

    const todayBar = aligned.map(a => ({ etf: a.etf, bar: a.bars[i] }));
    const todayPrice = (code) => {
      const t = todayBar.find(t => t.etf.code === code);
      return t ? t.bar.close : null;
    };

    let action = 'HOLD';
    let targetCode = null;

    if (sel.triggered) {
      // 风控触发，空仓
      targetCode = null;
    } else {
      targetCode = sel.best.code;
    }

    // 换仓逻辑
    if (targetCode === null) {
      // 应该空仓
      if (position !== null) {
        // 卖出
        const price = todayPrice(position.code);
        if (price) {
          const ret = (price - position.entryPrice) / position.entryPrice;
          cashReturn = (1 + cashReturn) * (1 + ret) - 1;
          dailyReturns.push(ret);
          trades++;
          if (ret > 0) wins++;
          if (ret < -0.001) {
            tradeLog.push(`  ${dates[i]} 卖出 ${position.code} ${position.name} 收益=${(ret * 100).toFixed(1)}% [风控空仓]`);
          } else {
            tradeLog.push(`  ${dates[i]} 卖出 ${position.code} ${position.name} 收益=${(ret * 100).toFixed(1)}% [风控空仓]`);
          }
          position = null;
        }
        action = 'SELL_RISK';
      }
    } else {
      // 应该持有 targetCode
      if (position === null || position.code !== targetCode) {
        // 换仓
        if (position !== null) {
          const price = todayPrice(position.code);
          if (price) {
            const ret = (price - position.entryPrice) / position.entryPrice;
            cashReturn = (1 + cashReturn) * (1 + ret) - 1;
            dailyReturns.push(ret);
            trades++;
            if (ret > 0) wins++;
            tradeLog.push(`  ${dates[i]} 卖出 ${position.code} ${position.name} 收益=${(ret * 100).toFixed(1)}% → 买入 ${targetCode}`);
            position = null;
          }
        }
        // 买入
        const buyPrice = todayPrice(targetCode);
        const etfInfo = pool.find(p => p.code === targetCode);
        if (buyPrice) {
          position = { code: targetCode, name: etfInfo ? etfInfo.name : targetCode, entryPrice: buyPrice, entryDay: dates[i] };
          action = 'BUY';
          holdDays = 0;
        }
      } else {
        action = 'HOLD';
        holdDays++;
        holdCount[targetCode] = (holdCount[targetCode] || 0) + 1;
      }
    }

    // 计算当前净值和回撤
    const currentValue = position !== null
      ? (1 + cashReturn) * (1 + (todayPrice(position.code) - position.entryPrice) / position.entryPrice)
      : (1 + cashReturn);
    if (currentValue > peak) peak = currentValue;
    const dd = (currentValue - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // 最后一天平仓
  if (position !== null) {
    const lastIdx = totalDays - 1;
    const price = aligned.find(a => a.etf.code === position.code).bars[lastIdx].close;
    const ret = (price - position.entryPrice) / position.entryPrice;
    cashReturn = (1 + cashReturn) * (1 + ret) - 1;
    dailyReturns.push(ret);
    trades++;
    if (ret > 0) wins++;
    tradeLog.push(`  ${dates[lastIdx]} 期末平仓 ${position.code} ${position.name} 收益=${(ret * 100).toFixed(1)}%`);
    position = null;
  }

  // 计算年化
  const years = (totalDays - startIdx) / TRADING_DAYS;
  const annualReturn = Math.pow(1 + cashReturn, 1 / years) - 1;

  // 夏普比率 (近似: 日收益均值/标准差 * sqrt(250))
  const meanRet = dailyReturns.reduce((a, b) => a + b, 0) / Math.max(dailyReturns.length, 1);
  const stdRet = Math.sqrt(dailyReturns.reduce((a, b) => a + (b - meanRet) ** 2, 0) / Math.max(dailyReturns.length - 1, 1));
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(TRADING_DAYS) : 0;

  // 基准: 等权持有不动
  const benchReturns = {};
  for (const item of aligned) {
    const first = item.bars[startIdx].close;
    const last = item.bars[totalDays - 1].close;
    benchReturns[item.etf.name] = (last - first) / first;
  }
  const benchAvg = Object.values(benchReturns).reduce((a, b) => a + b, 0) / Object.keys(benchReturns).length;
  const benchAnnual = Math.pow(1 + benchAvg, 1 / years) - 1;

  console.log(`\n  --- 交易记录 (最近10条) ---`);
  tradeLog.slice(-10).forEach(l => console.log(l));

  console.log(`\n  --- 持仓统计 ---`);
  for (const [code, days] of Object.entries(holdCount).sort((a, b) => b[1] - a[1])) {
    const etfInfo = pool.find(p => p.code === code);
    console.log(`  ${code} ${etfInfo ? etfInfo.name : ''}: ${days} 天 (${(days / (totalDays - startIdx) * 100).toFixed(0)}%)`);
  }

  return {
    label,
    totalReturn: cashReturn,
    annualReturn,
    maxDrawdown,
    sharpe,
    trades,
    winRate: trades > 0 ? wins / trades : 0,
    benchAvg,
    benchAnnual,
    benchReturns,
    years,
    startDate: dates[startIdx],
    endDate: dates[totalDays - 1],
    tradingDays: totalDays - startIdx
  };
}

// ---- 主入口 ----
(async () => {
  console.log('ETF 轮动策略回测对比');
  console.log(`时间: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  const resA = await backtest(POOL_A, '方案A (创业板版)');
  const resB = await backtest(POOL_B, '方案B (科创50版)');

  if (resA && resB) {
    console.log('\n\n' + '='.repeat(60));
    console.log('                    回测对比汇总');
    console.log('='.repeat(60));
    console.log(`回测区间: ${resA.startDate} ~ ${resA.endDate} (${resA.tradingDays} 交易日, ${resA.years.toFixed(2)} 年)`);
    console.log('-'.repeat(60));

    const fmt = (v, suffix = '%') => (v * 100).toFixed(2) + suffix;
    const rows = [
      ['指标', '方案A (创业板)', '方案B (科创50)', '差值(B-A)'],
      ['累计收益', fmt(resA.totalReturn), fmt(resB.totalReturn), fmt(resB.totalReturn - resA.totalReturn)],
      ['年化收益', fmt(resA.annualReturn), fmt(resB.annualReturn), fmt(resB.annualReturn - resA.annualReturn)],
      ['最大回撤', fmt(resA.maxDrawdown), fmt(resB.maxDrawdown), fmt(resB.maxDrawdown - resA.maxDrawdown)],
      ['夏普比率', resA.sharpe.toFixed(3), resB.sharpe.toFixed(3), (resB.sharpe - resA.sharpe).toFixed(3)],
      ['交易次数', String(resA.trades), String(resB.trades), String(resB.trades - resA.trades)],
      ['胜率', fmt(resA.winRate), fmt(resB.winRate), fmt(resB.winRate - resA.winRate)],
      ['基准(等权)收益', fmt(resA.benchAvg), fmt(resB.benchAvg), fmt(resB.benchAvg - resA.benchAvg)],
      ['基准(等权)年化', fmt(resA.benchAnnual), fmt(resB.benchAnnual), fmt(resB.benchAnnual - resA.benchAnnual)]
    ];

    // 打印表格
    const colWidths = [16, 18, 18, 14];
    for (const row of rows) {
      const line = row.map((cell, i) => String(cell).padEnd(colWidths[i])).join(' | ');
      console.log(line);
      if (row === rows[0]) console.log('-'.repeat(colWidths.reduce((a, b) => a + b, 0) + 9));
    }

    console.log('\n--- 基准明细 (等权买入持有) ---');
    console.log('  方案A:');
    for (const [name, ret] of Object.entries(resA.benchReturns)) {
      console.log(`    ${name}: ${fmt(ret)}`);
    }
    console.log('  方案B:');
    for (const [name, ret] of Object.entries(resB.benchReturns)) {
      console.log(`    ${name}: ${fmt(ret)}`);
    }

    // 生成 Markdown 报告
    let md = `# ETF 轮动策略回测对比\n\n`;
    md += `> 回测时间: ${new Date().toISOString().slice(0, 10)}\n\n`;
    md += `## 回测区间\n\n`;
    md += `| 项目 | 值 |\n|------|----|\n`;
    md += `| 起始日 | ${resA.startDate} |\n`;
    md += `| 结束日 | ${resA.endDate} |\n`;
    md += `| 交易日数 | ${resA.tradingDays} 天 |\n`;
    md += `| 年数 | ${resA.years.toFixed(2)} 年 |\n\n`;

    md += `## ETF 池\n\n`;
    md += `| 方案 | ETF池 |\n|------|-------|\n`;
    md += `| **A (创业板版)** | 沪深300 / **创业板ETF(159915)** / 纳指 / 黄金 |\n`;
    md += `| **B (科创50版)** | 沪深300 / **科创50ETF(588080)** / 纳指 / 黄金 |\n\n`;

    md += `## 核心指标对比\n\n`;
    md += `| 指标 | 方案A (创业板) | 方案B (科创50) | 差值(B-A) |\n`;
    md += `|------|:-:|:-:|:-:|\n`;
    md += `| 累计收益 | ${fmt(resA.totalReturn)} | ${fmt(resB.totalReturn)} | ${fmt(resB.totalReturn - resA.totalReturn)} |\n`;
    md += `| 年化收益 | ${fmt(resA.annualReturn)} | ${fmt(resB.annualReturn)} | ${fmt(resB.annualReturn - resA.annualReturn)} |\n`;
    md += `| 最大回撤 | ${fmt(resA.maxDrawdown)} | ${fmt(resB.maxDrawdown)} | ${fmt(resB.maxDrawdown - resA.maxDrawdown)} |\n`;
    md += `| 夏普比率 | ${resA.sharpe.toFixed(3)} | ${resB.sharpe.toFixed(3)} | ${(resB.sharpe - resA.sharpe).toFixed(3)} |\n`;
    md += `| 交易次数 | ${resA.trades} | ${resB.trades} | ${resB.trades - resA.trades} |\n`;
    md += `| 胜率 | ${fmt(resA.winRate)} | ${fmt(resB.winRate)} | ${fmt(resB.winRate - resA.winRate)} |\n`;
    md += `| 基准(等权)收益 | ${fmt(resA.benchAvg)} | ${fmt(resB.benchAvg)} | ${fmt(resB.benchAvg - resA.benchAvg)} |\n`;
    md += `| 基准(等权)年化 | ${fmt(resA.benchAnnual)} | ${fmt(resB.benchAnnual)} | ${fmt(resB.benchAnnual - resA.benchAnnual)} |\n\n`;

    md += `## 基准明细 (等权买入持有)\n\n`;
    md += `### 方案A\n\n| ETF | 收益 |\n|-----|------|\n`;
    for (const [name, ret] of Object.entries(resA.benchReturns)) {
      md += `| ${name} | ${fmt(ret)} |\n`;
    }
    md += `\n### 方案B\n\n| ETF | 收益 |\n|-----|------|\n`;
    for (const [name, ret] of Object.entries(resB.benchReturns)) {
      md += `| ${name} | ${fmt(ret)} |\n`;
    }

    md += `\n## 结论\n\n`;
    if (resB.annualReturn > resA.annualReturn) {
      md += `将创业板替换为科创50ETF后，**年化收益从 ${fmt(resA.annualReturn)} 提升至 ${fmt(resB.annualReturn)}**（+${fmt(resB.annualReturn - resA.annualReturn)}）。\n\n`;
    } else {
      md += `将创业板替换为科创50ETF后，**年化收益从 ${fmt(resA.annualReturn)} 下降至 ${fmt(resB.annualReturn)}**（${fmt(resB.annualReturn - resA.annualReturn)}）。\n\n`;
    }
    if (resB.maxDrawdown < resA.maxDrawdown) {
      md += `最大回撤从 ${fmt(resA.maxDrawdown)} 收窄至 ${fmt(resB.maxDrawdown)}，风险有所改善。\n\n`;
    } else {
      md += `最大回撤从 ${fmt(resA.maxDrawdown)} 扩大至 ${fmt(resB.maxDrawdown)}，波动风险增加。\n\n`;
    }
    if (resB.sharpe > resA.sharpe) {
      md += `夏普比率从 ${resA.sharpe.toFixed(3)} 提升至 ${resB.sharpe.toFixed(3)}，风险调整后收益更优。\n`;
    } else {
      md += `夏普比率从 ${resA.sharpe.toFixed(3)} 下降至 ${resB.sharpe.toFixed(3)}，风险调整后收益变差。\n`;
    }

    const fs = require('fs');
    const reportPath = '/workspace/etf-rotator/回测对比_创业板vs科创50.md';
    fs.writeFileSync(reportPath, md, 'utf-8');
    console.log(`\n报告已保存: ${reportPath}`);
  }

  console.log('\n回测完成。');
})();
