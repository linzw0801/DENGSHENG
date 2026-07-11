// ============================================================
// HTML 报告生成（邮件正文）
// ============================================================
const {
  AVG_VOL_THRESHOLD, TREND_THRESHOLD, HOLD_VOL_THRESHOLD_B,
  HOLD_VOL_THRESHOLD_C, AVG_VOL_THRESHOLD_C
} = require("./selector");

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  }[c]));
}

function generateHtml(data) {
  const now = new Date();
  const genTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  let banner, bannerColor, bannerText;
  if (data.error) {
    bannerColor = "#9e9e9e";
    banner = "❌ 数据获取失败";
    bannerText = "所有数据源均不可用，请稍后手动重跑。";
  } else if (data.triggered) {
    bannerColor = "#e53935";
    banner = "🔴 清仓 ETF，全仓买逆回购 GC001 / R-001";
    bannerText = "风控信号已触发，建议离场观望。";
  } else {
    bannerColor = "#e53935";
    banner = `🔴 满仓持有 ${esc(data.best.name)} (${esc(data.best.code)})`;
    bannerText = "风控未触发，持有动量最强标的。";
  }

  let riskHtml;
  if (data.error) {
    riskHtml = `<div class="muted">${esc(data.error)}</div>`;
  } else if (data.triggered) {
    riskHtml = data.reasons.map(r => `<li>${esc(r)}</li>`).join("");
  } else {
    riskHtml = `<li class="ok">✅ 风控未触发，各项指标正常</li>`;
  }

  let rows = "";
  if (!data.error) {
    const medals = ["🥇", "🥈", "🥉", "🏳️"];
    rows = data.results.map((r, i) => {
      const isBest = !data.triggered && i === 0;
      const medal = medals[i] || "·";
      const star = isBest ? `<span class="badge">推荐</span>` : "";
      const scoreCls = r.score >= 0 ? "pos" : "neg";
      return `<tr class="${isBest ? "best" : ""}">
        <td>${medal}</td>
        <td><b>${esc(r.name)}</b><br><span class="code">${esc(r.code)}</span></td>
        <td class="${scoreCls}">${r.score >= 0 ? "+" : ""}${r.score.toFixed(3)}</td>
        <td>${(r.vol * 100).toFixed(1)}%</td>
        <td>${r.trend.toFixed(1)}</td>
        <td>¥${Number(r.price).toFixed(3)}</td>
        <td>${star}</td>
      </tr>`;
    }).join("");
  }

  const avgVolLine = data.error ? "" :
    `<div class="avgvol">等权平均 vol20: <b>${(data.avgVol * 100).toFixed(1)}%</b>
     (阈值 ${AVG_VOL_THRESHOLD * 100}%) ｜
     趋势阈值 ${TREND_THRESHOLD} ｜
     持有vol阈值B ${HOLD_VOL_THRESHOLD_B * 100}% / C ${HOLD_VOL_THRESHOLD_C * 100}%</div>`;

  const partialFail = (!data.error && data.partialFail)
    ? `<div class="warn">⚠️ 注意：部分标的数据获取失败，结果仅供参考。</div>` : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:#f4f6f8; margin:0; padding:24px; color:#222; }
  .card { max-width:680px; margin:0 auto; background:#fff; border-radius:14px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .banner { background:${bannerColor}; color:#fff; padding:22px 24px; }
  .banner h1 { margin:0; font-size:20px; }
  .banner p { margin:6px 0 0; opacity:.92; font-size:14px; }
  .body { padding:22px 24px; }
  .meta { color:#888; font-size:13px; margin-bottom:16px; }
  h2 { font-size:15px; color:#333; border-left:4px solid #1a73e8; padding-left:8px; margin:20px 0 10px; }
  ul { margin:6px 0; padding-left:20px; font-size:14px; line-height:1.7; }
  li.ok { color:#2e7d32; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; margin-top:6px; }
  th, td { padding:9px 8px; text-align:left; border-bottom:1px solid #eee; }
  th { color:#999; font-weight:600; font-size:12px; }
  tr.best { background:#fdecea; }
  .pos { color:#e53935; font-weight:600; }
  .neg { color:#2e7d32; font-weight:600; }
  .code { color:#999; font-size:11px; }
  .badge { background:#e53935; color:#fff; font-size:11px; padding:2px 7px; border-radius:10px; }
  .avgvol { margin-top:14px; font-size:13px; color:#555; background:#f1f3f4; padding:10px 12px; border-radius:8px; }
  .warn { margin-top:12px; color:#b26a00; background:#fff4e0; padding:10px 12px; border-radius:8px; font-size:13px; }
  .foot { max-width:680px; margin:14px auto 0; color:#aaa; font-size:12px; text-align:center; }
</style></head>
<body>
  <div class="card">
    <div class="banner">
      <h1>${banner}</h1>
      <p>${esc(bannerText)}</p>
    </div>
    <div class="body">
      <div class="meta">📅 数据日期：${esc(data.newestDate || "—")} ｜ 生成时间：${genTime}</div>
      <h2>风控信号</h2>
      <ul>${riskHtml}</ul>
      <h2>动量得分排名</h2>
      <table>
        <thead><tr><th></th><th>标的</th><th>动量得分</th><th>vol20</th><th>趋势线</th><th>最新价</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${avgVolLine}
      ${partialFail}
    </div>
  </div>
  <div class="foot">本邮件由 ETF 轮动选股器自动生成，仅供研究参考，不构成投资建议。股市有风险，投资需谨慎。</div>
</body></html>`;
}

module.exports = { generateHtml };
