const fs = require("fs");
const nodemailer = require("nodemailer");

function loadEnv() {
  const p = "/workspace/etf-rotator/.env";
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

(async () => {
  const files = [
    { name: "ETF轮动日报.shortcut", path: "/workspace/etf-rotator/ETF轮动日报.shortcut" },
    { name: "ETF_Rotator_Text.js", path: "/workspace/etf-rotator/ETF_Rotator_Text.js" }
  ];
  const tr = nodemailer.createTransport({
    host: "smtp.qq.com", port: 587, secure: false,
    auth: { user: process.env.QQ_EMAIL, pass: process.env.QQ_AUTH_CODE }
  });
  await tr.sendMail({
    from: process.env.QQ_EMAIL,
    to: process.env.MAIL_TO || process.env.QQ_EMAIL,
    subject: "【ETF轮动】快捷指令文件(开箱即用版) + 纯文本脚本",
    html: "<p><b>开箱即用版快捷指令</b>：这次已把「运行脚本的结果」直接接进邮件正文（变量引用已写入文件）。</p><ul>" +
          "<li><b>ETF轮动日报.shortcut</b>：手机「文件」App 打开 → 导入到快捷指令。导入后「运行脚本+发送邮件」两动作已就绪，邮件正文应自动是选股排名。</li>" +
          "<li><b>ETF_Rotator_Text.js</b>：纯文本版脚本，复制到 Scriptable，命名 <b>ETF Rotator Shortcuts</b>。</li>" +
          "</ul>" +
          "<p>⚠️ 若导入后邮件正文是空的/显示异常（不同 iOS 版本的变量结构有差异），打开该快捷指令，点「发送邮件」正文处，从变量选「运行脚本的结果」即可（约 30 秒）。</p>" +
          "<p>⚠️ 每天 16:00 自动触发需在快捷指令 App 的「自动化」里单独建（个人自动化 → 特定时间 → 运行此快捷指令 → 关运行前询问），这部分无法打包进文件。</p>",
    attachments: files.map(f => {
      if (f.name.endsWith(".shortcut")) {
        return { filename: f.name, content: fs.readFileSync(f.path), contentType: "application/octet-stream" };
      }
      return { filename: f.name, content: "﻿" + fs.readFileSync(f.path, "utf8"), contentType: "text/javascript; charset=utf-8" };
    })
  });
  console.log("✅ 已发送开箱即用版 -> " + (process.env.MAIL_TO || process.env.QQ_EMAIL));
})().catch(e => { console.error("❌", e.message); process.exit(1); });
