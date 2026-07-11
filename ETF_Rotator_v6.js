// ETF轮动 v6 — 零延迟零依赖版 (Scriptable, iOS 快捷指令专用)
// 原则: 不用 setTimeout / Timer / sleep / 任何异步等待
const ETF_LIST=[{code:"510300",name:"沪深",market:"sh"},{code:"159915",name:"创业",market:"sz"},{code:"513100",name:"纳指",market:"sh"},{code:"518880",name:"黄金",market:"sh"}];
const N=25,VOL_WINDOW=20,TRADING_DAYS=250,FETCH_DAYS=100,TIMEOUT=8;
const AVG_VOL_THRESHOLD=0.40,TREND_THRESHOLD=95.0,HOLD_VOL_THRESHOLD_B=0.24,HOLD_VOL_THRESHOLD_C=0.40,AVG_VOL_THRESHOLD_C=0.30;
const MAIL_TO="3059402@qq.com";
const MAIL_FROM="3059402@qq.com";
const MAIL_AUTH_CODE="pxjprkeefonubgbf";

// 数据源（无任何 sleep 调用）
async function fetchEM(code,market){
  var secid=(market==="sh"?"1.":"0.")+code;
  var url="https://push2his.eastmoney.com/api/qt/stock/kline/get?secid="+secid+"&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt="+FETCH_DAYS;
  var req=new Request(url);
  req.timeoutInterval=TIMEOUT;
  req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://quote.eastmoney.com/"};
  var d=await req.loadJSON();
  if(!d||!d.data||!d.data.klines)return null;
  var valid=[];
  for(var k of d.data.klines){var r=k.split(",");if(parseFloat(r[5])<=0)continue;valid.push({day:r[0],open:parseFloat(r[1]),close:parseFloat(r[2]),high:parseFloat(r[3]),low:parseFloat(r[4]),volume:parseFloat(r[5])});}
  return valid.length>=60?valid:null;
}
async function fetchSina(code,market){
  var url="https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol="+market+code+"&datalen="+FETCH_DAYS+"&scale=240&ma=no";
  var req=new Request(url);req.timeoutInterval=TIMEOUT;req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://finance.sina.com.cn"};
  var data=await req.loadJSON();
  if(!Array.isArray(data)||data.length<60)return null;
  var valid=[];
  for(var d of data){if(parseFloat(d.volume)<=0)continue;valid.push({day:d.day||d.date,open:parseFloat(d.open),close:parseFloat(d.close),high:parseFloat(d.high),low:parseFloat(d.low),volume:parseFloat(d.volume)});}
  return valid.length>=60?valid:null;
}
async function fetchKlines(code,market){
  // 尝试东财，失败切新浪（不sleep，直接切）
  try{var r=await fetchEM(code,market);if(r)return r;}catch(e){}
  try{return await fetchSina(code,market);}catch(e){}
  return null;
}

// 核心算法
function calcScore(c){c=c.slice(-N);if(c.length<N||Math.min.apply(null,c)<=0)return 0;var y=c.map(function(x){return Math.log(x)}),x=[];for(var i=0;i<N;i++)x.push(i);var n=x.length,sx=0,sy=0,sxx=0,sxy=0;for(var i=0;i<n;i++){sx+=x[i];sy+=y[i];sxx+=x[i]*x[i];sxy+=x[i]*y[i];}var denom=n*sxx-sx*sx;if(denom===0)return 0;var slope=(n*sxy-sx*sy)/denom,annual=Math.exp(slope*TRADING_DAYS)-1,ym=sy/n,ssr=0,sst=0;for(var i=0;i<n;i++){var p=slope*x[i]+(sy-slope*sx)/n;ssr+=(y[i]-p)*(y[i]-p);sst+=(y[i]-ym)*(y[i]-ym);}return annual*(sst>0?1-ssr/sst:0);}
function calcVol20(closes){if(closes.length<VOL_WINDOW+1)return 0;var rec=closes.slice(-(VOL_WINDOW+1)),rets=[];for(var i=1;i<rec.length;i++){if(rec[i-1]>0)rets.push((rec[i]-rec[i-1])/rec[i-1]);}if(rets.length<VOL_WINDOW)return 0;var m=0;for(var i=0;i<rets.length;i++)m+=rets[i];m/=rets.length;var v=0;for(var i=0;i<rets.length;i++)v+=(rets[i]-m)*(rets[i]-m);v/=(rets.length-1);return Math.sqrt(v)*Math.sqrt(TRADING_DAYS);}
function tdxSma(values,n,m){var out=[];for(var i=0;i<values.length;i++)out.push(NaN);var y=NaN;for(var i=0;i<values.length;i++){var x=values[i];if(isNaN(x)){out[i]=y;continue;}if(isNaN(y))y=x;else y=(x*m+y*(n-m))/n;out[i]=y;}return out;}
function calcTrend(highs,lows,closes){var n=closes.length;if(n<55)return 50;var rsv=[];for(var i=0;i<n;i++){if(i<54){rsv.push(50);continue;}var llv=Infinity,hhv=-Infinity;for(var j=i-54;j<=i;j++){if(lows[j]<llv)llv=lows[j];if(highs[j]>hhv)hhv=highs[j];}rsv.push(hhv===llv?50:(closes[i]-llv)/(hhv-llv)*100);}var s5=tdxSma(rsv,5,1),s53=tdxSma(s5,3,1),v11=[];for(var i=0;i<n;i++)v11.push(!isNaN(s5[i])&&!isNaN(s53[i])?3*s5[i]-2*s53[i]:50);var ema=[];for(var i=0;i<n;i++)ema.push(NaN);ema[0]=v11[0];var al=2/(3+1);for(var i=1;i<n;i++)ema[i]=al*v11[i]+(1-al)*ema[i-1];return ema[n-1];}
function checkRisk(avg,hv,ht){var t=[];if(avg>AVG_VOL_THRESHOLD)t.push("① vol="+(avg*100).toFixed(1)+"%");if(ht>TREND_THRESHOLD&&hv>HOLD_VOL_THRESHOLD_B)t.push("② 趋势="+ht+" vol="+(hv*100).toFixed(1)+"%");if(hv>HOLD_VOL_THRESHOLD_C&&avg>AVG_VOL_THRESHOLD_C)t.push("③ 共振");return{triggered:t.length>0,reasons:t};}

// 主流程：纯并行获取 + 无延迟
async function run(){
  // 并行拉取全部 4 个 ETF（不加延迟间隔）
  var results=[];
  for(var ei=0;ei<ETF_LIST.length;ei++){
    var etf=ETF_LIST[ei];
    var raw=null;
    // 先尝试东财
    try{raw=await fetchEM(etf.code,etf.market);}catch(e){}
    // 东财失败立刻切新浪
    if(!raw)try{raw=await fetchSina(etf.code,etf.market);}catch(e){}
    results.push({etf:etf,raw:raw});
  }
  // 失败的重试一次新浪
  for(var i=0;i<results.length;i++){
    if(results[i].raw===null){
      try{results[i].raw=await fetchSina(results[i].etf.code,results[i].etf.market);}catch(e){}
    }
  }
  // 整理结果
  var vr=[],nd=null;
  for(var it of results){
    if(!it.raw)continue;
    var c=it.raw.map(function(d){return d.close}),h=it.raw.map(function(d){return d.high}),l=it.raw.map(function(d){return d.low});
    var ld=it.raw[it.raw.length-1].day||it.raw[it.raw.length-1].date||"";
    if(ld&&(nd===null||ld>nd))nd=ld;
    vr.push({code:it.etf.code,name:it.etf.name,score:calcScore(c),vol:calcVol20(c),trend:calcTrend(h,l,c),price:c[c.length-1],date:ld});
  }
  if(vr.length===0)return{error:"所有数据源均失败"};
  vr.sort(function(a,b){return b.score-a.score});
  var best=vr[0],av=0;for(var i=0;i<vr.length;i++)av+=vr[i].vol;av/=vr.length;
  var rk=checkRisk(av,best.vol,best.trend);
  return{results:vr,best:best,avgVol:av,triggered:rk.triggered,reasons:rk.reasons,newestDate:nd||"未知",partialFail:vr.length<ETF_LIST.length};
}

// HTML 报告
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]);});}
function html(d){
  if(d.error)return"<p style='color:red;padding:16px'>❌ "+esc(d.error)+"</p>";
  var rows=d.results.map(function(r,i){var mb=["🥇","🥈","🥉","🏳️"][i]||"·",b=!d.triggered&&i===0,sc=r.score>=0?"+":"";return"<tr"+(b?" class='best'":"")+"><td>"+mb+"</td><td><b>"+esc(r.name)+"</b><br><span class='code'>"+esc(r.code)+"</span></td><td class='"+(r.score>=0?"pos":"neg")+"'>"+sc+r.score.toFixed(3)+"</td><td>"+(r.vol*100).toFixed(1)+"%</td><td>"+r.trend.toFixed(1)+"</td><td>&yen;"+r.price.toFixed(3)+"</td><td>"+(b?"<span class='badge'>推荐</span>":"")+"</td></tr>";}).join("");
  var rh=d.triggered?d.reasons.map(function(r){return"<li>"+esc(r)+"</li>";}).join(""):"<li class='ok'>✅ 风控未触发</li>";
  var bn=d.triggered?"🔴 清仓 ETF，全仓逆回购 GC001/R-001":"🟢 满仓持有 "+esc(d.best.name)+" ("+esc(d.best.code)+")",bc=d.triggered?"#e53935":"#2e7d32";
  return"<!DOCTYPE html><html lang=zh-CN><head><meta charset=utf-8><style>body{font-family:-apple-system,sans-serif;background:#f4f6f8;padding:24px;color:#222}.card{max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}.banner{background:"+bc+";color:#fff;padding:22px 24px}.banner h1{margin:0;font-size:20px}.body{padding:22px 24px}.meta{color:#888;font-size:13px;margin-bottom:16px}h2{font-size:15px;color:#333;border-left:4px solid #1a73e8;padding-left:8px;margin:20px 0 10px}ul{font-size:14px;line-height:1.7}li.ok{color:#2e7d32}table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:9px 8px;text-align:left;border-bottom:1px solid #eee}th{color:#999;font-size:12px}tr.best{background:#e8f5e9}.pos{color:#2e7d32;font-weight:600}.neg{color:#e53935;font-weight:600}.code{color:#999;font-size:11px}.badge{background:#2e7d32;color:#fff;font-size:11px;padding:2px 7px;border-radius:10px}.avg{margin-top:14px;font-size:13px;background:#f1f3f4;padding:10px 12px;border-radius:8px}.foot{max-width:680px;margin:14px auto 0;color:#aaa;font-size:12px;text-align:center}</style></head><body><div class='card'><div class='banner'><h1>"+bn+"</h1></div><div class='body'><div class='meta'>📅 数据日期："+esc(d.newestDate)+"</div><h2>风控信号</h2><ul>"+rh+"</ul><h2>动量得分排名</h2><table><thead><tr><th></th><th>标的</th><th>动量</th><th>vol20</th><th>趋势</th><th>价</th><th></th></tr></thead><tbody>"+rows+"</tbody></table><div class='avg'>等权平均 vol20：<b>"+(d.avgVol*100).toFixed(1)+"%</b> (阈值"+(AVG_VOL_THRESHOLD*100)+"%) · 趋势阈值"+TREND_THRESHOLD+" · 持有vol B"+HOLD_VOL_THRESHOLD_B*100+"% C"+HOLD_VOL_THRESHOLD_C*100+"%</div></div></div><div class='foot'>仅供研究参考，不构成投资建议</div></body></html>";
}

// SMTP 发送
async function sendMail(subj,bodyHtml){
  var sm=new Smtp();sm.host="smtp.qq.com";sm.port=587;sm.auth=true;sm.username=MAIL_FROM;sm.password=MAIL_AUTH_CODE;sm.security="starttls";
  var msg=new Mail();msg.subject=subj;msg.body=bodyHtml;msg.isHtmlContent=true;
  msg.fromRecipients=[new MailRecipient("U",MAIL_FROM)];msg.toRecipients=[new MailRecipient("M",MAIL_TO)];
  await sm.connect();try{await sm.send(msg);console.log("✅ 已发送 -> "+MAIL_TO);}catch(e){console.log("⚠️ 发送失败: "+String(e.message||e));}finally{await sm.quit();}
}

// 入口
(async function(){
try{
  var data=await run();
  if(data.error){var o="❌ "+data.error;if(typeof Script!=="undefined"&&Script.setShortcutOutput)Script.setShortcutOutput(o);console.log(o);}
  else{
    var rep=html(data),sj=data.triggered?"【ETF轮动日报】🔴清仓切逆回购 · "+data.newestDate:"【ETF轮动日报】🟢持有"+data.best.name+"("+data.best.code+") · "+data.newestDate;
    if(typeof Script!=="undefined"&&Script.setShortcutOutput)Script.setShortcutOutput(rep);
    console.log(rep);
    try{await sendMail(sj,rep);}catch(me){console.log("⚠️ 邮件异常: "+String(me.message||me));}
  }
}catch(err){
  var em="❌ 异常: "+String(err.message||err);if(typeof Script!=="undefined"&&Script.setShortcutOutput)Script.setShortcutOutput(em);console.log(em);
}finally{if(typeof Script!=="undefined"&&typeof Script.complete==="function")Script.complete();}
})();
