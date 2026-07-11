// ============================================================
// 主入口：运行选股 → 生成 HTML → 发送邮件
// 用法:
//   node index.js            # 选股 + 发送邮件
//   node index.js --no-mail  # 仅选股 + 生成 HTML（不发送，用于测试）
// ============================================================
const fs = require("fs");
const path = require("path");
const { run } = require("./selector");
const { generateHtml } = require("./report");
const { sendHtml } = require("./mailer");

// 简易 .env 加载（避免引入额外依赖）
function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const NO_MAIL = process.argv.includes("--no-mail");

(async () => {
  console.log("==== ETF 轮动开始 ====");
  const startTs = Date.now();
  const data = await run();
  console.log(`总耗时: ${((Date.now() - startTs) / 1000).toFixed(1)}s`);

  const html = generateHtml(data);

  // 始终保存最新一份 HTML 报告
  const outPath = path.join(__dirname, "latest-report.html");
  fs.writeFileSync(outPath, html);
  console.log("HTML 报告已保存: " + outPath);

  if (data.error) {
    console.log("⚠️ 数据获取失败，跳过发送。");
    process.exit(1);
  }

  if (NO_MAIL) {
    console.log("（--no-mail 模式，未发送邮件）");
    return;
  }

  if (!process.env.QQ_EMAIL || !process.env.QQ_AUTH_CODE) {
    console.log("⚠️ 未配置 QQ_EMAIL / QQ_AUTH_CODE，跳过发送。");
    return;
  }

  try {
    const info = await sendHtml({
      to: process.env.MAIL_TO || process.env.QQ_EMAIL,
      subject: `【ETF轮动日报】${data.triggered ? "🔴清仓切逆回购" : "🟢持有" + data.best.name} · ${data.newestDate}`,
      html
    });
    console.log("✅ 邮件已发送 -> " + (process.env.MAIL_TO || process.env.QQ_EMAIL) + " (msgId: " + info.messageId + ")");
  } catch (e) {
    console.error("❌ 邮件发送失败: " + (e.message || e));
    process.exit(1);
  }
})();
