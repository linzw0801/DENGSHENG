#!/usr/bin/env bash
# 配置 ETF 轮动选股器每天 16:00 自动运行并发送邮件（依赖系统 crontab）
set -e

if ! command -v crontab >/dev/null 2>&1; then
  echo "⚠️ 当前环境未安装 crontab，无法使用系统定时任务。"
  echo "   建议改用内置调度（无需系统 cron）："
  echo "     nohup node schedule.js > cron.log 2>&1 &"
  echo "   或使用 pm2:  pm2 start schedule.js --name etf-rotator"
  exit 0
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
LOG="$DIR/cron.log"
CRON_LINE="0 16 * * * cd $DIR && $NODE_BIN index.js >> $LOG 2>&1"

echo "项目目录: $DIR"
echo "Node 路径: $NODE_BIN"

# 先移除本项目已有的旧任务（按目录匹配，避免重复）
EXISTING="$(crontab -l 2>/dev/null | grep -v "$DIR/index.js" || true)"
# 再追加新任务
{
  [ -n "$EXISTING" ] && echo "$EXISTING"
  echo "$CRON_LINE"
} | crontab -

echo "✅ 已写入定时任务:"
echo "   $CRON_LINE"
echo ""
echo "查看: crontab -l"
echo "日志: tail -f $LOG"
echo "删除全部定时任务: crontab -r"
echo ""
echo "⚠️ 注意: 需要常驻运行的环境（VPS/树莓派/NAS/不关机电脑），"
echo "   容器或电脑休眠时不会执行。"
