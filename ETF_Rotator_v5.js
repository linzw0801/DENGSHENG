// ETF轮动 v5 — 零 setTimeout 引用版 (Scriptable, iOS)
// 修复: 彻底删除所有 setTimeout/clearTimeout/setInterval 引用
const ETF_LIST=[{code:"510300",name:"沪深",market:"sh"},{code:"159915",name:"创业",market:"sz"},{code:"513100",name:"纳指",market:"sh"},{code:"518880",name:"黄金",market:"sh"}];
const N=25,VOL_WINDOW=20,TRADING_DAYS=250,FETCH_DAYS=100,TIMEOUT=8;
const AVG_VOL_THRESHOLD=0.40,TREND_THRESHOLD=95.0,HOLD_VOL_THRESHOLD_B=0.24,HOLD_VOL_THRESHOLD_C=0.40,AVG_VOL_THRESHOLD_C=0.30;

// ★ 邮箱配置
const MAIL_TO="3059402@qq.com";
const MAIL_FROM="3059402@qq.com";
const MAIL_AUTH_CODE="pxjprkeefonubgbf";

// ★ 纯 Timer.wait()，不引用任何浏览器全局 API
function sleep(sec){ return Timer.wait(sec); }

async function fetchEM(code,market){
  const secid=(market==="sh"?"1.":"0.")+code;
  const url="https://push2his.eastmoney.com/api/qt/stock/kline/get?secid="+secid+"&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt="+FETCH_DAYS;
  const req=new Request(url);
  req.timeoutInterval=TIMEOUT;
  req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://quote.eastmoney.com/"};
  const d=await req.loadJSON();
  if(!d||!d.data||!d.data.klines)return null;
  var valid=[];
  for(var k of d.data.klines){
    var r=k.split(",");
    if(parseFloat(r[5])<=0)continue;
    valid.push({day:r[0],open:parseFloat(r[1]),close:parseFloat(r[2]),high:parseFloat(r[3]),low:parseFloat(r[4]),volume:parseFloat(r[5])});
  }
  return valid.length>=60?valid:null;
}
async function fetchSina(code,market){
  var url="https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol="+market+code+"&datalen="+FETCH_DAYS+"&scale=240&ma=no";
  var req=new Request(url);
  req.timeoutInterval=TIMEOUT;
  req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://finance.sina.com.cn"};
  var data=await req.loadJSON();
  if(!Array.isArray(data)||data.length<60)return null;
  var valid=[];
  for(var d of data){
    if(parseFloat(d.volume)<=0)continue;
    valid.push({day:d.day||d.date,open:parseFloat(d.open),close:parseFloat(d.close),high:parseFloat(d.high),low:parseFloat(d.low),volume:parseFloat(d.volume)});
  }
  return valid.length>=60?valid:null;
}
async function fetchKlines(code,market){
  for(var attempt=0;attempt<2;attempt++){
    try{
      var r=await fetchEM(code,market);
      if(r)return r;
    }catch(e){}
    if(attempt<1)await sleep(1);
  }
  try{
    var r=await fetchSina(code,market);
    if(r)return r;
  }catch(e){}
  return null;
}

// 核心算法
function calcScore(c){
  c=c.slice(-N);
  if(c.length<N||Math.min.apply(null,c)<=0)return 0;
  var y=c.map(function(x){return Math.log(x)});
  var x=[];for(var i=0;i<N;i++)x.push(i);
  var n=x.length,sx=0,sy=0,sxx=0,sxy=0;
  for(var i=0;i<n;i++){sx+=x[i];sy+=y[i];sxx+=x[i]*x[i];sxy+=x[i]*y[i];}
  var denom=n*sxx-sx*sx;if(denom===0)return 0;
  var slope=(n*sxy-sx*sy)/denom;
  var intercept=(sy-slope*sx)/n;
  var annual=Math.exp(slope*TRADING_DAYS)-1;
  var ym=sy/n,ssr=0,sst=0;
  for(var i=0;i<n;i++){var pred=slope*x[i]+intercept;ssr+=(y[i]-pred)*(y[i]-pred);sst+=(y[i]-ym)*(y[i]-ym);}
  var r2=sst>0?1-ssr/sst:0;
  return annual*r2;
}
function calcVol20(closes){
  if(closes.length<VOL_WINDOW+1)return 0;
  var rec=closes.slice(-(VOL_WINDOW+1));
  var rets=[];
  for(var i=1;i<rec.length;i++){
    if(rec[i-1]>0)rets.push((rec[i]-rec[i-1])/rec[i-1]);
  }
  if(rets.length<VOL_WINDOW)return 0;
  var m=0;for(var i=0;i<rets.length;i++)m+=rets[i];
  m/=rets.length;
  var v=0;for(var i=0;i<rets.length;i++)v+=(rets[i]-m)*(rets[i]-m);
  v/=(rets.length-1);
  return Math.sqrt(v)*Math.sqrt(TRADING_DAYS);
}
function tdxSma(values,n,m){
  var out=[];for(var i=0;i<values.length;i++)out.push(NaN);
  var y=NaN;
  for(var i=0;i<values.length;i++){
    var x=values[i];
    if(isNaN(x)){out[i]=y;continue;}
    if(isNaN(y))y=x;else y=(x*m+y*(n-m))/n;
    out[i]=y;
  }
  return out;
}
function calcTrend(highs,lows,closes){
  var n=closes.length;
  if(n<55)return 50;
  var rsv=[];
  for(var i=0;i<n;i++){
    if(i<54){rsv.push(50);continue;}
    var llv=Infinity,hhv=-Infinity;
    for(var j=i-54;j<=i;j++){
      if(lows[j]<llv)llv=lows[j];
      if(highs[j]>hhv)hhv=highs[j];
    }
    rsv.push(hhv===llv?50:(closes[i]-llv)/(hhv-llv)*100);
  }
  var s5=tdxSma(rsv,5,1);
  var s53=tdxSma(s5,3,1);
  var v11=[];
  for(var i=0;i<n;i++){
    v11.push((!isNaN(s5[i])&&!isNaN(s53[i]))?(3*s5[i]-2*s53[i]):50);
  }
  var ema=[];for(var i=0;i<n;i++)ema.push(NaN);
  ema[0]=v11[0];
  var al=2/(3+1);
  for(var i=1;i<n;i++)ema[i]=al*v11[i]+(1-al)*ema[i-1];
  return ema[n-1];
}
function checkRisk(avgVol,holdVol,holdTrend){
  var triggered=[];
  if(avgVol>AVG_VOL_THRESHOLD)
    triggered.push("① vol20="+(avgVol*100).toFixed(1)+"% >"+(AVG_VOL_THRESHOLD*100)+"%");
  if(holdTrend>TREND_THRESHOLD&&holdVol>HOLD_VOL_THRESHOLD_B)
    triggered.push("② 趋势="+holdTrend.toFixed(1)+">"+TREND_THRESHOLD+" 持有vol="+(holdVol*100).toFixed(1)+"%");
  if(holdVol>HOLD_VOL_THRESHOLD_C&&avgVol>AVG_VOL_THRESHOLD_C)
    triggered.push("③ 持有vol="+(holdVol*100).toFixed(1)+"% 均="+(avgVol*100).toFixed(1)+"%");
  return {triggered:triggered.length>0,reasons:triggered};
}

async function run(){
  var results=await Promise.all(
    ETF_LIST.map(function(etf,idx){
      if(idx>0)try{return sleep(0.1)}catch(e){}
      return fetchKlines(etf.code,etf.market).then(function(raw){return {etf:etf,raw:raw};});
    })
  );
  var fail=results.filter(function(r){return r.raw===null;});
  if(fail.length>0){
    await sleep(2);
    var retry=await Promise.all(
      fail.map(function(item){
        return fetchKlines(item.etf.code,item.etf.market).then(function(raw){return {etf:item.etf,raw:raw};});
      })
    );
    for(var rr of retry){
      if(rr.raw!==null){
        var idx=-1;
        for(var i=0;i<results.length;i++){if(results[i].etf.code===rr.etf.code){idx=i;break;}}
        if(idx>=0)results[idx].raw=rr.raw;
      }
    }
  }
  var vr=[],newestDate=null;
  for(var item of results){
    if(!item.raw)continue;
    var closes=item.raw.map(function(d){return d.close});
    var highs=item.raw.map(function(d){return d.high});
    var lows=item.raw.map(function(d){return d.low});
    var lastBar=item.raw[item.raw.length-1];
    var ld=lastBar.day||lastBar.date||"";
    if(ld&&(newestDate===null||ld>newestDate))newestDate=ld;
    vr.push({
      code:item.etf.code,name:item.etf.name,
      score:calcScore(closes),
      vol:calcVol20(closes),
      trend:calcTrend(highs,lows,closes),
      price:closes[closes.length-1],
      date:ld
    });
  }
  if(vr.length===0)return {error:"无数据可用"};
  vr.sort(function(a,b){return b.score-a.score;});
  var best=vr[0];
  var avgVol=0;for(var i=0;i<vr.length;i++)avgVol+=vr[i].vol;
  avgVol/=vr.length;
  var rk=checkRisk(avgVol,best.vol,best.trend);
  return {
    results:vr,best:best,avgVol:avgVol,
    triggered:rk.triggered,reasons:rk.reasons,
    newestDate:newestDate||"未知",
    partialFail:vr.length<ETF_LIST.length
  };
}

function esc(s){
  return String(s).replace(/[&<>"]/g,function(c){
    return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]);
  });
}
function html(data){
  if(data.error) return "<p style='color:red;padding:16px'>❌ "+esc(data.error)+"</p>";
  var medals=["🥇","🥈","🥉","🏳️"];
  var rows=data.results.map(function(r,i){
    var mb=medals[i]||"·";
    var best=!data.triggered&&i===0;
    var sc=r.score>=0?"+":"";
    return "<tr"+(best?" class='best'":"")+">"+
      "<td>"+mb+"</td>"+
      "<td><b>"+esc(r.name)+"</b><br><span class='code'>"+esc(r.code)+"</span></td>"+
      "<td class='"+(r.score>=0?"pos":"neg")+"'>"+sc+r.score.toFixed(3)+"</td>"+
      "<td>"+(r.vol*100).toFixed(1)+"%</td>"+
      "<td>"+r.trend.toFixed(1)+"</td>"+
      "<td>&yen;"+r.price.toFixed(3)+"</td>"+
      "<td>"+(best?"<span class='badge'>推荐</span>":"")+"</td></tr>";
  }).join("");
  var riskHtml=data.triggered
    ?data.reasons.map(function(r){return"<li>"+esc(r)+"</li>";}).join("")
    :"<li class='ok'>✅ 风控未触发</li>";
  var banner=data.triggered?"🔴 清仓 ETF，全仓逆回购":"🟢 满仓持有 "+esc(data.best.name)+" ("+esc(data.best.code)+")";
  var bc=data.triggered?"#e53935":"#2e7d32";
  return "<!DOCTYPE html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"+
    "<style>body{font-family:-apple-system,sans-serif;background:#f4f6f8;padding:24px;color:#222}"+
    ".card{max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}"+
    ".banner{background:"+bc+";color:#fff;padding:22px 24px}.banner h1{margin:0;font-size:20px}"+
    ".body{padding:22px 24px}.meta{color:#888;font-size:13px;margin-bottom:16px}"+
    "h2{font-size:15px;color:#333;border-left:4px solid #1a73e8;padding-left:8px;margin:20px 0 10px}"+
    "ul{margin:6px 0;padding-left:20px;font-size:14px;line-height:1.7}li.ok{color:#2e7d32}"+
    "table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:9px 8px;text-align:left;border-bottom:1px solid #eee}"+
    "th{color:#999;font-weight:600;font-size:12px}tr.best{background:#e8f5e9}"+
    ".pos{color:#2e7d32;font-weight:600}.neg{color:#e53935;font-weight:600}"+
    ".code{color:#999;font-size:11px}.badge{background:#2e7d32;color:#fff;font-size:11px;padding:2px 7px;border-radius:10px}"+
    ".avg{margin-top:14px;font-size:13px;color:#555;background:#f1f3f4;padding:10px 12px;border-radius:8px}"+
    ".foot{max-width:680px;margin:14px auto 0;color:#aaa;font-size:12px;text-align:center}</style></head><body>"+
    "<div class='card'><div class='banner'><h1>"+banner+"</h1></div>"+
    "<div class='body'><div class='meta'>📅 数据日期："+esc(data.newestDate)+"</div>"+
    "<h2>风控信号</h2><ul>"+riskHtml+"</ul>"+
    "<h2>动量得分排名</h2><table><thead><tr><th></th><th>标的</th><th>动量</th><th>vol20</th><th>趋势</th><th>价</th><th></th></tr></thead><tbody>"+
    rows+"</tbody></table>"+
    "<div class='avg'>等权平均 vol20：<b>"+(data.avgVol*100).toFixed(1)+"%</b> (阈值 "+(AVG_VOL_THRESHOLD*100)+"%)</div>"+
    "</div></div><div class='foot'>仅供研究参考，不构成投资建议</div></body></html>";
}

// SMTP 发送
async function sendMail(subject,bodyHtml){
  var smtp=new Smtp();
  smtp.host="smtp.qq.com";
  smtp.port=587;
  smtp.auth=true;
  smtp.username=MAIL_FROM;
  smtp.password=MAIL_AUTH_CODE;
  smtp.security="starttls";
  var msg=new Mail();
  msg.subject=subject;
  msg.body=bodyHtml;
  msg.isHtmlContent=true;
  msg.fromRecipients=[new MailRecipient("User",MAIL_FROM)];
  msg.toRecipients=[new MailRecipient("Me",MAIL_TO)];
  await smtp.connect();
  try{
    await smtp.send(msg);
    console.log("✅ 邮件已发送 -> "+MAIL_TO);
  }catch(e){
    console.log("⚠️ 发送失败: "+String(e.message||e));
  }finally{
    await smtp.quit();
  }
}

// 主入口
(async function(){
  try{
    var data = await run();
    if(data.error){
      var out = "❌ "+data.error;
      if(typeof Script!=="undefined"&&Script.setShortcutOutput) Script.setShortcutOutput(out);
      console.log(out);
    }else{
      var report = html(data);
      var subj = data.triggered ? "【ETF轮动日报】🔴清仓切逆回购 · "+data.newestDate : "【ETF轮动日报】🟢持有"+data.best.name+"("+data.best.code+") · "+data.newestDate;
      if(typeof Script!=="undefined"&&Script.setShortcutOutput) Script.setShortcutOutput(report);
      console.log(report);
      try{ await sendMail(subj,report); }catch(me){console.log("⚠️ 邮件异常: "+String(me.message||me));}
    }
  }catch(err){
    var eMsg = "❌ 异常: "+String(err.message||err);
    if(typeof Script!=="undefined"&&Script.setShortcutOutput) Script.setShortcutOutput(eMsg);
    console.log(eMsg);
  }finally{
    if(typeof Script!=="undefined"&&typeof Script.complete==="function") Script.complete();
  }
})();
