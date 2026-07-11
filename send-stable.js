const fs = require("fs");
const path = require("path");
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

const withBOM = (s) => "﻿" + s;

(async () => {
  const files = [{ name: "ETF_Rotator_Stable.js", path: "/workspace/etf-rotator/ETF_Rotator_Stable.js", type: "text/javascript" }];
  const tr = nodemailer.createTransport({
    host: "smtp.qq.com", port: 587, secure: false,
    auth: { user: process.env.QQ_EMAIL, pass: process.env.QQ_AUTH_CODE }
  });
  await tr.sendMail({
    from: process.env.QQ_EMAIL,
    to: process.env.MAIL_TO || process.env.QQ_EMAIL,
    subject: "【ETF轮动】稳定版脚本(无弹窗·Siri安全)",
    html: "<p>这是<strong>稳定版</strong> Scriptable 脚本（已彻底移除 Alert/Notification 弹窗，Siri/快捷指令不再报 alerts 错）。</p>" +
          "<ul><li><b>ETF_Rotator_Stable.js</b>：复制到手机 Scriptable，命名 <b>ETF Rotator Shortcuts</b>，替换掉原来的脚本即可。</li></ul>" +
          "<p>用法不变：快捷指令「运行脚本」选它，关掉运行前询问，16:00 自动跑。</p>",
    attachments: files.map(f => ({
      filename: f.name,
      content: withBOM(fs.readFileSync(f.path, "utf8")),
      contentType: f.type + "; charset=utf-8"
    }))
  });
  console.log("✅ 已发送稳定版 -> " + (process.env.MAIL_TO || process.env.QQ_EMAIL));
})().catch(e => { console.error("❌", e.message); process.exit(1); });
