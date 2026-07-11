// ============================================================
// QQ 邮箱 SMTP 发送模块
// ============================================================
const nodemailer = require("nodemailer");

function buildTransport() {
  return nodemailer.createTransport({
    host: "smtp.qq.com",
    port: 587,
    secure: false, // STARTTLS
    auth: {
      user: process.env.QQ_EMAIL,
      pass: process.env.QQ_AUTH_CODE
    }
  });
}

/**
 * 发送 HTML 邮件
 * @param {{to:string, subject:string, html:string}} opts
 */
async function sendHtml(opts) {
  const from = process.env.QQ_EMAIL;
  const to = opts.to || process.env.MAIL_TO || from;
  if (!from) throw new Error("未配置 QQ_EMAIL，无法发送邮件");
  if (!to) throw new Error("未配置收件人（MAIL_TO 或 QQ_EMAIL）");

  const transporter = buildTransport();
  const info = await transporter.sendMail({
    from: `"ETF轮动选股器" <${from}>`,
    to,
    subject: opts.subject,
    html: opts.html
  });
  return info;
}

module.exports = { sendHtml, buildTransport };
