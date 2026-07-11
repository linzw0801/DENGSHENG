// ETF轮动 v8 增强版 — 信息更丰富 + HTML 附件发送
// 输出：纯文本报告 + iCloud HTML 文件附件（邮件打开美观）
const ETF_LIST=[{code:"510300",name:"沪深",market:"sh"},{code:"159915",name:"创业",market:"sz"},{code:"513100",name:"纳指",market:"sh"},{code:"518880",name:"黄金",market:"sh"}];
const N=25,VOL_WINDOW=20,TRADING_DAYS=250,FETCH_DAYS=120,TIMEOUT=8;
const AVG_VOL_THRESHOLD=0.40,TREND_THRESHOLD=95.0,HOLD_VOL_THRESHOLD_B=0.24,HOLD_VOL_THRESHOLD_C=0.40,AVG_VOL_THRESHOLD_C=0.30;
const MAIL_TO="3059402@qq.com";
const SCT_KEY="SCT376693TNOKnsEMP0owffhklxYcnarYC";

async function fetchEM(code,market){
  var secid=(market==="sh"?"1.":"0.")+code;
  var url="https://push2his.eastmoney.com/api/qt/stock/kline/get?secid="+secid+"&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt="+FETCH_DAYS;
  var req=new Request(url);req.timeoutInterval=TIMEOUT;req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://quote.eastmoney.com/"};
  var d=await req.loadJSON();if(!d||!d.data||!d.data.klines)return null;
  var valid=[];for(var k of d.data.klines){var r=k.split(",");if(parseFloat(r[5])<=0)continue;valid.push({day:r[0],open:parseFloat(r[1]),close:parseFloat(r[2]),high:parseFloat(r[3]),low:parseFloat(r[4]),volume:parseFloat(r[5])});}
  return valid.length>=60?valid:null;
}
async function fetchSina(code,market){
  var url="https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol="+market+code+"&datalen="+FETCH_DAYS+"&scale=240&ma=no";
  var req=new Request(url);req.timeoutInterval=TIMEOUT;req.headers={"User-Agent":"Mozilla/5.0","Referer":"https://finance.sina.com.cn"};
  var data=await req.loadJSON();if(!Array.isArray(data)||data.length<60)return null;
  var valid=[];for(var d of data){if(parseFloat(d.volume)<=0)continue;valid.push({day:d.day||d.date,open:parseFloat(d.open),close:parseFloat(d.close),high:parseFloat(d.high),low:parseFloat(d.low),volume:parseFloat(d.volume)});}
  return valid.length>=60?valid:null;
}
async function fetchKlines(code,market){try{var r=await fetchEM(code,market);if(r)return r;}catch(e){}try{return await fetchSina(code,market);}catch(e){}return null;}

// 工具函数
function sum(arr){var s=0;for(var i=0;i<arr.length;i++)s+=arr[i];return s;}
function avg(arr){return sum(arr)/arr.length;}
function max(arr){var m=-Infinity;for(var i=0;i<arr.length;i++)if(arr[i]>m)m=arr[i];return m;}
function min(arr){var m=Infinity;for(var i=0;i<arr.length;i++)if(arr[i]<m)m=arr[i];return m;}
function std(arr){var a=avg(arr),v=0;for(var i=0;i<arr.length;i++)v+=(arr[i]-a)*(arr[i]-a);return Math.sqrt(v/(arr.length-1));}
function returnPct(closes,days){if(closes.length<days+1)return 0;return (closes[closes.length-1]-closes[closes.length-1-days])/closes[closes.length-1-days]*100;}
function ma(closes,days){if(closes.length<days)return 0;return sum(closes.slice(-days))/days;}
function maxDrawdown(closes){var peak=closes[0],mdd=0;for(var i=1;i<closes.length;i++){if(closes[i]>peak)peak=closes[i];var dd=(peak-closes[i])/peak*100;if(dd>mdd)mdd=dd;}return mdd;}

function calcScore(c){c=c.slice(-N);if(c.length<N||Math.min.apply(null,c)<=0)return 0;var y=c.map(function(x){return Math.log(x)}),x=[];for(var i=0;i<N;i++)x.push(i);var n=x.length,sx=0,sy=0,sxx=0,sxy=0;for(var i=0;i<n;i++){sx+=x[i];sy+=y[i];sxx+=x[i]*x[i];sxy+=x[i]*y[i];}var denom=n*sxx-sx*sx;if(denom===0)return 0;var slope=(n*sxy-sx*sy)/denom,annual=Math.exp(slope*TRADING_DAYS)-1,ym=sy/n,ssr=0,sst=0;for(var i=0;i<n;i++){var p=slope*x[i]+(sy-slope*sx)/n;ssr+=(y[i]-p)*(y[i]-p);sst+=(y[i]-ym)*(y[i]-ym);}return annual*(sst>0?1-ssr/sst:0);}
function calcVol20(closes){if(closes.length<VOL_WINDOW+1)return 0;var rets=[];for(var i=closes.length-VOL_WINDOW;i<closes.length;i++){if(closes[i-1]>0)rets.push((closes[i]-closes[i-1])/closes[i-1]);}var s=std(rets);return s*Math.sqrt(TRADING_DAYS);}
function tdxSma(values,n,m){var out=[];for(var i=0;i<values.length;i++)out.push(NaN);var y=NaN;for(var i=0;i<values.length;i++){var x=values[i];if(isNaN(x)){out[i]=y;continue;}if(isNaN(y))y=x;else y=(x*m+y*(n-m))/n;out[i]=y;}return out;}
function calcTrend(highs,lows,closes){var n=closes.length;if(n<55)return 50;var rsv=[];for(var i=0;i<n;i++){if(i<54){rsv.push(50);continue;}var llv=Infinity,hhv=-Infinity;for(var j=i-54;j<=i;j++){if(lows[j]<llv)llv=lows[j];if(highs[j]>hhv)hhv=highs[j];}rsv.push(hhv===llv?50:(closes[i]-llv)/(hhv-llv)*100);}var s5=tdxSma(rsv,5,1),s53=tdxSma(s5,3,1),v11=[];for(var i=0;i<n;i++)v11.push(!isNaN(s5[i])&&!isNaN(s53[i])?3*s5[i]-2*s53[i]:50);var ema=[];for(var i=0;i<n;i++)ema.push(NaN);ema[0]=v11[0];var al=2/(3+1);for(var i=1;i<n;i++)ema[i]=al*v11[i]+(1-al)*ema[i-1];return ema[n-1];}
function checkRisk(avg,hv,ht){var t=[];if(avg>AVG_VOL_THRESHOLD)t.push("① 全市场平均波动率 "+(avg*100).toFixed(1)+"% 超过阈值 "+(AVG_VOL_THRESHOLD*100)+"%，整体风险偏高");if(ht>TREND_THRESHOLD&&hv>HOLD_VOL_THRESHOLD_B)t.push("② 趋势线 "+ht.toFixed(1)+" 超买且持有标的波动率 "+(hv*100).toFixed(1)+"% > "+(HOLD_VOL_THRESHOLD_B*100)+"%，阶段顶部信号");if(hv>HOLD_VOL_THRESHOLD_C&&avg>AVG_VOL_THRESHOLD_C)t.push("③ 持有标的波动率 "+(hv*100).toFixed(1)+"% 与全市场波动 "+(avg*100).toFixed(1)+"% 共振");return{triggered:t.length>0,reasons:t};}

async function run(){
  var results=[];
  for(var ei=0;ei<ETF_LIST.length;ei++){
    var etf=ETF_LIST[ei],raw=null,source="失败";
    try{raw=await fetchEM(etf.code,etf.market);if(raw)source="东财";}catch(e){}
    if(!raw){try{raw=await fetchSina(etf.code,etf.market);if(raw)source="新浪";}catch(e){}}
    results.push({etf:etf,raw:raw,source:source});
  }
  for(var i=0;i<results.length;i++){if(results[i].raw===null){try{var r=await fetchSina(results[i].etf.code,results[i].etf.market);if(r){results[i].raw=r;results[i].source="新浪(重试)";}}catch(e){}}}
  var vr=[],nd=null;
  for(var it of results){
    if(!it.raw)continue;
    var c=it.raw.map(function(d){return d.close}),h=it.raw.map(function(d){return d.high}),l=it.raw.map(function(d){return d.low});
    var ld=it.raw[it.raw.length-1].day||it.raw[it.raw.length-1].date||"";
    if(ld&&(nd===null||ld>nd))nd=ld;
    var ret1=returnPct(c,1),ret5=returnPct(c,5),ret20=returnPct(c,20);
    vr.push({code:it.etf.code,name:it.etf.name,score:calcScore(c),vol:calcVol20(c),trend:calcTrend(h,l,c),price:c[c.length-1],ret1:ret1,ret5:ret5,ret20:ret20,mdd:maxDrawdown(c),ma20:ma(c,20),aboveMa20:c[c.length-1]>ma(c,20),source:it.source,date:ld});
  }
  if(vr.length===0)return{error:"所有数据源均失败"};
  vr.sort(function(a,b){return b.score-a.score});
  var best=vr[0],av=0;for(var i=0;i<vr.length;i++)av+=vr[i].vol;av/=vr.length;
  var rk=checkRisk(av,best.vol,best.trend);
  return{results:vr,best:best,avgVol:av,newestDate:nd||"未知",partialFail:vr.length<ETF_LIST.length,risk:rk};
}

function esc(s){return String(s).replace(/[&<>"]/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]);});}

function textReport(data){
  if(data.error)return"❌ ETF轮动选股失败："+data.error;
  var L=[];L.push("━━━━━━━━━━━━━━━━━━━━");L.push("📅 数据日期："+data.newestDate);L.push("");
  if(data.risk.triggered){L.push("🔴 操作建议：清仓全部 ETF，全仓买逆回购 GC001 / R-001");L.push("");L.push("⚠️ 风控触发原因：");for(var i=0;i<data.risk.reasons.length;i++)L.push("   "+(i+1)+". "+data.risk.reasons[i]);}
  else{L.push("🟢 操作建议：满仓持有 "+data.best.name+" ("+data.best.code+")");L.push("");L.push("✅ 风控未触发，各项指标正常");}
  L.push("");L.push("📊 动量得分排名：");
  L.push("名次  标的     动量得分     日涨跌  5日    20日    vol20   趋势    最新价    数据源");
  var M=["🥇","🥈","🥉","4️⃣"];
  for(var i=0;i<data.results.length;i++){
    var r=data.results[i],sc=(r.score>=0?"+":"")+r.score.toFixed(4),star=(!data.risk.triggered&&i===0)?" ⬅ 推荐":"";
    L.push((M[i]||"  ")+" "+r.name.padEnd(6)+" "+sc.padStart(9)+" "+(r.ret1>=0?"+":"")+r.ret1.toFixed(2).padStart(6)+"% "+(r.ret5>=0?"+":"")+r.ret5.toFixed(2).padStart(6)+"% "+(r.ret20>=0?"+":"")+r.ret20.toFixed(2).padStart(6)+"% "+(r.vol*100).toFixed(1).padStart(6)+"% "+r.trend.toFixed(1).padStart(6)+" "+("¥"+r.price.toFixed(3)).padStart(8)+" "+r.source+star);
  }
  L.push("");L.push("📈 组合指标：等权平均 vol20 = "+(data.avgVol*100).toFixed(1)+"%（阈值 "+(AVG_VOL_THRESHOLD*100)+"%） 趋势阈值="+TREND_THRESHOLD+"  B="+(HOLD_VOL_THRESHOLD_B*100)+"% C="+(HOLD_VOL_THRESHOLD_C*100)+"%");
  if(data.partialFail){L.push("");L.push("⚠️ 注意：部分标的数据获取失败，结果仅供参考");}
  L.push("");L.push("━━━━━━━━━━━━━━━━━━━━");L.push("免责声明：本报告仅供研究参考，不构成投资建议。");
  return L.join("\n");
}

function htmlReport(data){
  if(data.error)return"<p style='color:red;padding:20px'>❌ "+esc(data.error)+"</p>";
  var rows=data.results.map(function(r,i){
    var mb=["🥇","🥈","🥉","🏳️"][i]||"·",b=!data.risk.triggered&&i===0,sc=r.score>=0?"+":"";
    var r1c=r.ret1>=0?"pos":"neg",r5c=r.ret5>=0?"pos":"neg",r20c=r.ret20>=0?"pos":"neg";
    return"<tr class='"+(b?"best":"")+"'><td>"+mb+"</td><td><b>"+esc(r.name)+"</b><br><span class='code'>"+esc(r.code)+"</span></td><td class='"+(r.score>=0?"pos":"neg")+"'>"+sc+r.score.toFixed(4)+"</td><td class='"+r1c+"'>"+(r.ret1>=0?"+":"")+r.ret1.toFixed(2)+"%</td><td class='"+r5c+"'>"+(r.ret5>=0?"+":"")+r.ret5.toFixed(2)+"%</td><td class='"+r20c+"'>"+(r.ret20>=0?"+":"")+r.ret20.toFixed(2)+"%</td><td>"+(r.vol*100).toFixed(1)+"%</td><td>"+r.trend.toFixed(1)+"</td><td>"+(r.aboveMa20?"✅":"❌")+"</td><td>&yen;"+r.price.toFixed(3)+"</td><td>"+esc(r.source)+"</td></tr>";
  }).join("");
  var rh=data.risk.triggered?data.risk.reasons.map(function(r){return"<li>"+esc(r)+"</li>";}).join(""):"<li class='ok'>✅ 风控未触发，各项指标正常</li>";
  var bn=data.risk.triggered?"🔴 清仓 ETF，全仓逆回购 GC001 / R-001":"🟢 满仓持有 "+esc(data.best.name)+" ("+esc(data.best.code)+")",bc=data.risk.triggered?"#e53935":"#2e7d32";
  var stats="等权平均 vol20：<b>"+(data.avgVol*100).toFixed(1)+"%</b>（阈值"+(AVG_VOL_THRESHOLD*100)+"%）｜ 趋势阈值："+TREND_THRESHOLD+" ｜ 持有vol B："+(HOLD_VOL_THRESHOLD_B*100)+"% C："+(HOLD_VOL_THRESHOLD_C*100)+"%";
  return"<!DOCTYPE html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#f4f6f8;padding:24px;color:#222}.card{max-width:720px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}.banner{background:"+bc+";color:#fff;padding:24px}.banner h1{margin:0;font-size:22px}.banner p{margin:8px 0 0;opacity:.9;font-size:14px}.body{padding:24px}.meta{color:#888;font-size:13px;margin-bottom:18px}h2{font-size:15px;color:#333;border-left:4px solid #1a73e8;padding-left:10px;margin:22px 0 12px}ul{font-size:14px;line-height:1.8;margin:8px 0}li.ok{color:#2e7d32}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}th,td{padding:10px 8px;text-align:left;border-bottom:1px solid #eee}th{background:#f8f9fa;color:#666;font-weight:600;font-size:12px}tr.best{background:#e8f5e9}.pos{color:#2e7d32;font-weight:600}.neg{color:#e53935;font-weight:600}.code{color:#999;font-size:11px}.avg{margin-top:16px;font-size:13px;color:#555;background:#f1f3f4;padding:12px;border-radius:8px}.foot{max-width:720px;margin:16px auto 0;color:#999;font-size:12px;text-align:center;line-height:1.6}</style></head><body><div class='card'><div class='banner'><h1>"+bn+"</h1><p>"+(data.risk.triggered?"市场进入防守状态，建议离场观望":"持有最强动量标的，顺势而为")+"</p></div><div class='body'><div class='meta'>📅 数据日期："+esc(data.newestDate)+"</div><h2>风控信号</h2><ul>"+rh+"</ul><h2>动量得分排名（按25日动量排序）</h2><table><thead><tr><th></th><th>标的</th><th>动量得分</th><th>1日</th><th>5日</th><th>20日</th><th>vol20</th><th>趋势</th><th>站上MA20</th><th>最新价</th><th>数据源</th></tr></thead><tbody>"+rows+"</tbody></table><div class='avg'>"+stats+"</div>"+(data.partialFail?"<div style='margin-top:12px;color:#b26a00;font-size:13px'>⚠️ 注意：部分标的数据获取失败，结果仅供参考</div>":"")+"</div></div><div class='foot'>本报告由 ETF 轮动选股器自动生成，仅供研究参考，不构成投资建议。<br>股市有风险，投资需谨慎。</div></body></html>";
}

// 保存 HTML 到 iCloud 文件（供邮件附件使用）
function saveHtmlAttachment(htmlContent){
  var fm=FileManager.iCloud();
  var dir=fm.documentsDirectory();
  var filePath=fm.joinPath(dir,"ETF轮动日报.html");
  fm.writeString(filePath,htmlContent);
  return filePath;
}

// Server酱推送
function pushToSCT(title,desp){
  var url="https://sctapi.ftqq.com/"+SCT_KEY+".send";
  var req=new Request(url);req.method="POST";req.headers={"Content-Type":"application/x-www-form-urlencoded"};req.body="title="+encodeURIComponent(title)+"&desp="+encodeURIComponent(desp);return req.loadJSON();
}

// 入口
(async function(){
try{
  var data=await run();
  var txt=textReport(data),htm=htmlReport(data);

  // 保存 HTML 文件到 iCloud，方便快捷指令作为邮件附件发送
  var filePath=saveHtmlAttachment(htm);
  console.log("HTML附件已保存: "+filePath);

  // 输出纯文本给快捷指令（邮件正文可读）+ 文件路径
  if(typeof Script!=="undefined"&&Script.setShortcutOutput){
    Script.setShortcutOutput(txt + "\n\n📎 HTML附件路径:\n" + filePath);
  }
  console.log(txt);

  // Server酱推送（纯文本）
  var subj=data.risk.triggered?"【ETF轮动】🔴清仓切逆回购 · "+data.newestDate:"【ETF轮动】🟢持有"+data.best.name+"("+data.best.code+") · "+data.newestDate;
  try{await pushToSCT(subj,txt);console.log("✅ 已推送到 Server酱");}catch(pe){console.log("⚠️ Server酱失败: "+String(pe.message||pe));}

}catch(err){
  var em="❌ 异常: "+String(err.message||err);if(typeof Script!=="undefined"&&Script.setShortcutOutput)Script.setShortcutOutput(em);console.log(em);
}finally{
  if(typeof Script!=="undefined"&&typeof Script.complete==="function")Script.complete();
}
})();
