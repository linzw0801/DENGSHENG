// ETF轮动 最终版 (Scriptable, iOS) — 内置SMTP发送，无需iOS配置邮箱
// 特点: ①消除 without presenting UI 警告 ②自带SMTP发邮件(不依赖系统邮箱)
const ETF_LIST=[{code:"510300",name:"沪深",market:"sh"},{code:"159915",name:"创业",market:"sz"},{code:"513100",name:"纳指",market:"sh"},{code:"518880",name:"黄金",market:"sh"}];
const N=25,VOL_WINDOW=20,TRADING_DAYS=250,FETCH_DAYS=100,TIMEOUT=8;
const AVG_VOL_THRESHOLD=0.40,TREND_THRESHOLD=95.0,HOLD_VOL_THRESHOLD_B=0.24,HOLD_VOL_THRESHOLD_C=0.40,AVG_VOL_THRESHOLD_C=0.30;

// ============================================================
// ★ 邮箱配置（在此处修改）
// ============================================================
const MAIL_TO = "3059402@qq.com";        // 收件人
const MAIL_FROM = "3059402@qq.com";       // 发件人（你的QQ邮箱）
const MAIL_AUTH_CODE = "pxjprkeefonubgbf"; // QQ邮箱授权码（不是登录密码）

const sleep=s=>new Promise(r=>setTimeout(r,s*1000));

// ============================================================
// 数据源
// ============================================================
async function fetchEM(code,market){const secid=(market==="sh"?"1.":"0.")+code;const url=`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=${FETCH_DAYS}`;const req=new Request(url);req.timeoutInterval=TIMEOUT;req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://quote.eastmoney.com/"};const d=await req.loadJSON();if(!d||!d.data||!d.data.klines)return null;const v=d.data.klines.map(k=>k.split(",")).filter(r=>parseFloat(r[5])>0).map(r=>({day:r[0],open:parseFloat(r[1]),close:parseFloat(r[2]),high:parseFloat(r[3]),low:parseFloat(r[4]),volume:parseFloat(r[5])}));return v.length>=60?v:null;}
async function fetchSina(code,market){const url=`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${market}${code}&datalen=${FETCH_DAYS}&scale=240&ma=no`;const req=new Request(url);req.timeoutInterval=TIMEOUT;req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://finance.sina.com.cn"};const data=await req.loadJSON();if(!Array.isArray(data)||data.length<60)return null;const v=data.filter(d=>parseFloat(d.volume)>0).map(d=>({day:d.day||d.date,open:parseFloat(d.open),close:parseFloat(d.close),high:parseFloat(d.high),low:parseFloat(d.low),volume:parseFloat(d.volume)}));return v.length>=60?v:null;}
async function fetchKlines(code,market){for(let a=0;a<2;a++){try{const r=await fetchEM(code,market);if(r)return r;}catch(e){}if(a<1)await sleep(1);}try{const r=await fetchSina(code,market);if(r)return r;}catch(e){}return null;}

// ============================================================
// 核心算法
// ============================================================
function calcScore(c){c=c.slice(-N);if(c.length<N||Math.min(...c)<=0)return 0;const y=c.map(x=>Math.log(x)),x=Array.from({length:N},(_,i)=>i),n=x.length,sx=x.reduce((a,b)=>a+b,0),sy=y.reduce((a,b)=>a+b,0),sxx=x.reduce((a,b)=>a+b*b,0),sxy=x.reduce((a,b,i)=>a+b*y[i],0);const denom=n*sxx-sx*sx;if(denom===0)return 0;const slope=(n*sxy-sx*sy)/denom,annual=Math.exp(slope*TRADING_DAYS)-1,yP=x.map(xi=>slope*xi+(sy-slope*sx)/n),ym=sy/n,ssr=y.reduce((a,_,i)=>a+(y[i]-yP[i])**2,0),sst=y.reduce((a,yi)=>a+(yi-ym)**2,0),r2=sst>0?1-ssr/sst:0;return annual*r2;}
function calcVol20(closes){if(closes.length<VOL_WINDOW+1)return 0;const rec=closes.slice(-(VOL_WINDOW+1)),rets=[];for(let i=1;i<rec.length;i++)if(rec[i-1]>0)rets.push((rec[i]-rec[i-1])/rec[i-1]);if(rets.length<VOL_WINDOW)return 0;const m=rets.reduce((a,b)=>a+b,0)/rets.length,v=rets.reduce((a,b)=>a+(b-m)**2,0)/(rets.length-1);return Math.sqrt(v)*Math.sqrt(TRADING_DAYS);}
function tdxSma(v,n,m){const o=new Array(v.length).fill(NaN);let y=NaN;for(let i=0;i<v.length;i++){if(isNaN(v[i])){o[i]=y;continue;}if(isNaN(y))y=v[i];else y=(v[i]*m+y*(n-m))/n;o[i]=y;}return o;}
function calcTrend(h,l,c){const n=c.length;if(n<55)return 50;const rsv=[];for(let i=0;i<n;i++){if(i<54){rsv.push(50);continue;}let llv=Infinity,hh=-Infinity;for(let j=i-54;j<=i;j++){if(l[j]<llv)llv=l[j];if(h[j]>hh)hh=h[j];}rsv.push(hh===llv?50:(c[i]-llv)/(hh-llv)*100);}const s5=tdxSma(rsv,5,1),s53=tdxSma(s5,3,1),v11=[];for(let i=0;i<n;i++)v11.push(!isNaN(s5[i])&&!isNaN(s53[i])?3*s5[i]-2*s53[i]:50);const ema=new Array(n).fill(NaN);ema[0]=v11[0];const al=0.5;for(let i=1;i<n;i++)ema[i]=al*v11[i]+(1-al)*ema[i-1];return ema[n-1];}
function checkRisk(avg,hv,ht){const t=[];if(avg>AVG_VOL_THRESHOLD)t.push("① 等权vol20="+(avg*100).toFixed(1)+"%>"+(AVG_VOL_THRESHOLD*100)+"%");if(ht>TREND_THRESHOLD&&hv>HOLD_VOL_THRESHOLD_B)t.push("② 趋势="+ht.toFixed(1)+">"+TREND_THRESHOLD+"且持有vol="+(hv*100).toFixed(1)+"%");if(hv>HOLD_VOL_THRESHOLD_C&&avg>AVG_VOL_THRESHOLD_C)t.push("③ 持有vol="+(hv*100).toFixed(1)+"%且均="+(avg*100).toFixed(1)+"%");return{triggered:t.length>0,reasons:t};}
async function run(){let res=await Promise.all(ETF_LIST.map(async(e,i)=>{if(i>0)await sleep(0.1);return{e,raw:await fetchKlines(e.code,e.market)};}));let fail=res.filter(r=>!r.raw);if(fail.length){await sleep(2);const rt=await Promise.all(fail.map(async({e})=>({e,raw:await fetchKlines(e.code,e.market)})));for(const xr of rt){if(xr.raw){const i=res.findIndex(r=>r.e.code===xr.e.code);if(i>=0)res[i].raw=xr.raw;}}}
const vr=[];for(const{e,raw}of res){if(!raw)continue;const c=raw.map(d=>d.close),h=raw.map(d=>d.high),l=raw.map(d=>d.low),d=raw[raw.length-1].day||raw[raw.length-1].date;vr.push({code:e.code,name:e.name,score:calcScore(c),vol:calcVol20(c),trend:calcTrend(h,l,c),price:c[c.length-1],date:d});}
if(!vr.length)return{error:"无数据"};vr.sort((a,b)=>b.score-a.score);const best=vr[0],avg=vr.reduce((a,r)=>a+r.vol,0)/vr.length,rk=checkRisk(avg,best.vol,best.trend);return{results:vr,best,avgVol:avg,triggered:rk.triggered,reasons:rk.reasons,newestDate:vr.map(r=>r.date).sort().pop(),partialFail:vr.length<ETF_LIST.length};}

// ============================================================
// HTML 报告生成
// ============================================================
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function html(d){if(d.error)return"<p style='color:red;font-size:16px;padding:16px'>❌ 数据获取失败："+esc(d.error)+"</p>";let rows=d.results.map((r,i)=>{const mb=["🥇","🥈","🥉","🏳️"][i]||"·",best=!d.triggered&&i===0,sc=r.score>=0?"+":"";return`<tr class="${best?"best":""}"><td>${mb}</td><td><b>${esc(r.name)}</b><br><span class=code>${esc(r.code)}</span></td><td class="${r.score>=0?"pos":"neg"}">${sc}${r.score.toFixed(3)}</td><td>${(r.vol*100).toFixed(1)}%</td><td>${r.trend.toFixed(1)}</td><td>¥${r.price.toFixed(3)}</td><td>${best?'<span class=badge>推荐</span>':""}</td></tr>`;}).join("");let risk=d.triggered?d.reasons.map(r=>`<li>${esc(r)}</li>`).join(""):'<li class=ok>✅ 风控未触发</li>';let banner=d.triggered?"🔴 清仓ETF，全仓逆回购":"🟢 满仓持有 "+esc(d.best.name)+" ("+esc(d.best.code)+")";let bc=d.triggered?"#e53935":"#2e7d32";return`<!DOCTYPE html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><style>body{font-family:-apple-system,sans-serif;background:#f4f6f8;padding:24px;color:#222}.card{max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}.banner{background:${bc};color:#fff;padding:22px 24px}.banner h1{margin:0;font-size:20px}.body{padding:22px 24px}.meta{color:#888;font-size:13px;margin-bottom:16px}h2{font-size:15px;border-left:4px solid #1a73e8;padding-left:8px}ul{font-size:14px;line-height:1.7}li.ok{color:#2e7d32}table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:9px 8px;text-align:left;border-bottom:1px solid #eee}th{color:#999;font-size:12px}tr.best{background:#e8f5e9}.pos{color:#2e7d32;font-weight:600}.neg{color:#e53935;font-weight:600}.code{color:#999;font-size:11px}.badge{background:#2e7d32;color:#fff;font-size:11px;padding:2px 7px;border-radius:10px}.avg{margin-top:14px;font-size:13px;background:#f1f3f4;padding:10px 12px;border-radius:8px}.foot{max-width:680px;margin:14px auto 0;color:#aaa;font-size:12px;text-align:center}</style></head><body><div class=card><div class=banner><h1>${banner}</h1></div><div class=body><div class=meta>📅 数据日期：${esc(d.newestDate)}</div><h2>风控信号</h2><ul>${risk}</ul><h2>动量得分排名</h2><table><thead><tr><th></th><th>标的</th><th>动量</th><th>vol20</th><th>趋势</th><th>价</th><th></th></tr></thead><tbody>${rows}</tbody></table><div class=avg>等权vol20：${(d.avgVol*100).toFixed(1)}%（阈值${AVG_VOL_THRESHOLD*100}%）</div></div></div><div class=foot>仅供研究参考，不构成投资建议</div></body></html>`;}

// ============================================================
// ★ SMTP 发送（Scriptable 内置 Smtp 类，不依赖 iOS 系统邮箱）
// ============================================================
async function sendMail(subject, htmlBody){
  const smtp=new Smtp();
  smtp.host="smtp.qq.com";
  smtp.port=587;
  smtp.auth=true;
  smtp.username=MAIL_FROM;
  smtp.password=MAIL_AUTH_CODE;
  smtp.security="starttls";

  const msg=new Mail();
  msg.subject=subject;
  msg.body=htmlBody;
  msg.isHtmlContent=true;
  msg.fromRecipients=[new MailRecipient("User",MAIL_FROM)];
  msg.toRecipients=[new MailRecipient("Me",MAIL_TO)];

  await smtp.connect();
  try{
    await smtp.send(msg);
    console.log("✅ 邮件已发送 -> "+MAIL_TO);
  }finally{
    await smtp.quit();
  }
}

// ============================================================
// 主入口
// ============================================================
(async()=>{
try{
  const data = await run();
  if(data.error){
    const output = "❌ "+data.error;
    if(typeof Script!=="undefined"&&Script.setShortcutOutput) Script.setShortcutOutput(output);
    console.log(output);
  }else{
    // 生成报告
    const reportHtml = html(data);
    const subject = data.triggered ? "【ETF轮动日报】🔴清仓切逆回购 · "+data.newestDate : "【ETF轮动日报】🟢持有"+data.best.name+"("+data.best.code+") · "+data.newestDate;

    // 输出给快捷指令
    if(typeof Script!=="undefined"&&Script.setShortcutOutput){
      Script.setShortcutOutput(reportHtml);
    }
    console.log(reportHtml);

    // ★ 自动发送邮件
    try{
      await sendMail(subject, reportHtml);
    }catch(mailErr){
      console.log("⚠️ 邮件发送失败: "+String(mailErr.message||mailErr));
    }
  }
}catch(err){
  const errMsg = "❌ 运行异常: "+String(err.message||err);
  if(typeof Script!=="undefined"&&Script.setShortcutOutput) Script.setShortcutOutput(errMsg);
  console.log(errMsg);
}finally{
  if(typeof Script!=="undefined"&&typeof Script.complete==="function"){
    Script.complete();
  }
}
})();
