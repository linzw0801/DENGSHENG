// 把指定文件作为附件发到 QQ 邮箱（带 UTF-8 BOM，避免中文乱码）
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const withBOM = (s) => "﻿" + s;

(async () => {
  const files = [
    { name: "ETF_Rotator_Mini.js", path: path.join(__dirname, "ETF_Rotator_Mini.js"), type: "text/javascript" },
    { name: "SHORTCUT_GUIDE.md", path: path.join(__dirname, "SHORTCUT_GUIDE.md"), type: "text/markdown" }
  ];
  const transporter = nodemailer.createTransport({
    host: "smtp.qq.com", port: 587, secure: false,
    auth: { user: process.env.QQ_EMAIL, pass: process.env.QQ_AUTH_CODE }
  });
  await transporter.sendMail({
    from: process.env.QQ_EMAIL,
    to: process.env.MAIL_TO || process.env.QQ_EMAIL,
    subject: "【ETF轮动】手机脚本精简版(短·不易复制错) + 指南",
    html: `<p>附件：</p>
      <ul>
        <li><b>ETF_Rotator_Mini.js</b>：精简版 Scriptable 脚本（行数少，复制不易漏结尾）。复制到手机 Scriptable，命名 <b>ETF Rotator Shortcuts</b>。</li>
        <li><b>SHORTCUT_GUIDE.md</b>：快捷指令搭建步骤。</li>
      </ul>
      <p>如仍从对话复制，请务必复制到最后一行的 <code>Script.complete();</code> 为止。</p>`,
    attachments: files.map(f => ({
      filename: f.name,
      content: withBOM(fs.readFileSync(f.path, "utf8")),
      contentType: f.type + "; charset=utf-8"
    }))
  });
  console.log("✅ 已发送精简版附件邮件 -> " + (process.env.MAIL_TO || process.env.QQ_EMAIL));
})().catch(e => { console.error("❌", e.message); process.exit(1); });
