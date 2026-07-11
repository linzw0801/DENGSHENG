// ============================================================
// 内置调度模式（不依赖系统 crontab）
// 每天 16:00 自动运行 index.js（选股 + 发邮件）。
//
// 启动方式（任选其一，保持进程常驻即可）:
//   nohup node schedule.js > cron.log 2>&1 &
//   pm2 start schedule.js --name etf-rotator
//   systemd / supervisor / 群晖任务计划 等
// ============================================================
const { execFile } = require("child_process");
const path = require("path");

const HOUR = 16, MIN = 0; // 每天 16:00

function nextRunTime() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(HOUR, MIN, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // 今天已过则排到明天
  return next;
}

function tick() {
  const target = nextRunTime();
  const delay = target - Date.now();
  console.log(`[调度] 下次运行: ${target.toLocaleString()} （约 ${Math.round(delay / 60000)} 分钟后）`);

  setTimeout(() => {
    console.log(`\n[调度] ⏰ 触发运行 @ ${new Date().toLocaleString()}`);
    const child = execFile(
      process.execPath,
      [path.join(__dirname, "index.js")],
      { env: process.env },
      (err, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (err) console.error("[调度] 运行出错:", err.message);
      }
    );
    child.stdout && child.stdout.on("data", d => process.stdout.write(d));
    child.stderr && child.stderr.on("data", d => process.stderr.write(d));
    tick(); // 排下一次
  }, delay);
}

console.log("[调度] ETF 轮动内置调度已启动，目标时间每天 " +
  String(HOUR).padStart(2, "0") + ":" + String(MIN).padStart(2, "0"));
tick();
