# ETF 轮动选股器 · Node.js 服务端版

把你的 iOS Scriptable 选股器搬到了服务器，每天下午 **16:00（收盘后）** 自动跑最新结果，并把 **HTML 报告发到你的 QQ 邮箱**。

## 功能
- 完全保留原 Scriptable 脚本的核心算法（动量得分 `calcScore`、年化波动率 `calcVol20`、趋势线 `calcTrendLine`、风控 `checkRisk`），与回测/云端一致。
- 双数据源（东方财富 → 失败自动切新浪），带自动重试。
- 生成美观的 HTML 邮件：操作建议横幅、风控信号、动量排名表、平均波动率。
- 通过 QQ 邮箱 SMTP 发送。

## 文件
| 文件 | 作用 |
|------|------|
| `selector.js` | 核心算法 + 数据获取 |
| `report.js`   | HTML 报告生成 |
| `mailer.js`   | QQ 邮箱 SMTP 发送 |
| `index.js`    | 主入口（运行 → 生成 → 发送） |
| `schedule.js` | 内置调度（常驻进程，每天 16:00，不依赖系统 cron） |
| `.env`        | 邮箱配置（**含授权码，勿外泄**） |
| `install-cron.sh` | 一键配置系统 crontab（每天 16:00） |
| `latest-report.html` | 最近一次生成的报告 |

## 部署步骤
```bash
# 1. 安装依赖
npm install

# 2. 配置邮箱：编辑 .env
#    QQ_EMAIL=你的QQ号@qq.com
#    QQ_AUTH_CODE=授权码（你已提供，已写入）
#    获取授权码：QQ邮箱网页端 → 设置 → 账户 → 开启SMTP → 生成授权码

# 3. 测试（仅生成 HTML，不发送）
node index.js --no-mail

# 4. 正式运行（生成 + 发送邮件，验证整条链路）
node index.js
```

## 定时自动运行（二选一）

### 方案一：系统 cron（推荐，适用于有 cron 的 Linux/Mac/树莓派/NAS）
```bash
bash install-cron.sh
```
会写入：`0 16 * * * cd <项目目录> && node index.js >> cron.log 2>&1`

### 方案二：内置调度（不依赖系统 cron，适合任何能常驻 Node 的环境）
```bash
# 后台常驻
nohup node schedule.js > cron.log 2>&1 &

# 或用 pm2 管理（崩溃自动重启）
pm2 start schedule.js --name etf-rotator
```
`schedule.js` 会自己算「下一个 16:00」并每天触发 `index.js`，无需系统级定时服务。

> ⚠️ 无论哪种方案，都需要**常驻运行的环境**（VPS / 树莓派 / NAS / 不关机的电脑）。容器或电脑休眠时不会执行。

## 安全提醒
- `.env` 里的 `QQ_AUTH_CODE` 是**邮箱授权码，等同于邮箱密码**，请勿提交到公开代码仓库或发给他人。
- 建议在自己的服务器上使用，而非共享环境。
- 本报告仅供研究参考，不构成投资建议。

## 调参
算法阈值集中在 `selector.js` 顶部常量（`AVG_VOL_THRESHOLD`、`TREND_THRESHOLD`、`HOLD_VOL_THRESHOLD_B/C` 等），与原脚本一致，可直接修改。

## 沙箱/受限网络说明
- 若东方财富接口不可达（如网络限制），代码会自动切换到新浪数据源，功能不受影响。
- 若环境中没有 `crontab` 命令，`install-cron.sh` 会提示改用方案二（内置调度）。
