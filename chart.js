var PriceChart = (function(){
  var DAY=86400000,PREF_KEY="cs_chart_prefs_v1",SVG_NS="http://www.w3.org/2000/svg";
  var SERIES=[
    {id:"close",label:"Daily close",color:"var(--accent)",description:"Binance daily closing price in USDT, shown as approximate USD."},
    {id:"ma",label:"MA200",color:"var(--chart-ma)",description:"The average of 200 consecutive completed daily closes."},
    {id:"hi",label:"5y high",color:"var(--chart-high)",description:"The highest Binance price in up to five years, including the latest available candle."},
    {id:"lo",label:"5y low",color:"var(--chart-low)",description:"The lowest Binance price in up to five years, including the latest available candle."},
    {id:"lth",label:"Long-term realized (BTC default)",color:"var(--sell)",value:48720,btc:true,description:"The supply-weighted price when long-term holder coins last moved on-chain. This fixed default is not live and may differ from what their owners paid."},
    {id:"sth",label:"Short-term realized (BTC default)",color:"var(--hold)",value:74100,btc:true,description:"The supply-weighted price when short-term holder coins last moved on-chain. This fixed default is not live and may differ from what their owners paid."},
    {id:"overall",label:"Overall realized (BTC default)",color:"var(--chart-overall)",value:53780,btc:true,description:"The supply-weighted price when circulating BTC last moved on-chain. This fixed default is not live and may differ from what its owners paid."}
  ];
  var prefs={coin:"1",scale:"all",hidden:[]},items={},coins=[],updated=null,marketError=null,signature="",geometry=null,hoverIndex=-1,resizeFrame=null;
  function el(id){return document.getElementById(id)}
  function number(v){return (typeof v==="number"||(typeof v==="string"&&v.trim()!==""))?Number(v):NaN}
  function formatPrice(v){
    var a=Math.abs(v);
    if(Number.isFinite(v)&&a>0&&a<0.000001)return "$"+v.toPrecision(5);
    if(Number.isFinite(v)&&a>0&&a<0.01)return "$"+v.toLocaleString(undefined,{maximumSignificantDigits:5});
    return fmt(v);
  }
  function processCandles(candles,now){
    if(!Array.isArray(candles)||!Number.isFinite(now))throw new Error("Invalid daily candle data");
    var date=new Date(now);
    if(isNaN(date.getTime()))throw new Error("Invalid current date");
    var today=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());
    var cutoff=new Date(today);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-5);
    var start=today-30*DAY,closes=[],times=[],points=[],sum=0,high=null,low=null,previous=-1;
    for(var i=0;i<candles.length;i++){
      var c=candles[i];
      if(!Array.isArray(c))throw new Error("Invalid daily candle");
      var t=number(c[0]),h=number(c[2]),l=number(c[3]),close=number(c[4]);
      if(!Number.isSafeInteger(t)||t<=0||t%DAY!==0||t<=previous||
         !Number.isFinite(h)||!Number.isFinite(l)||!Number.isFinite(close)||h<=0||l<=0||close<=0||h<l){
        throw new Error("Invalid daily candle values");
      }
      previous=t;times.push(t);closes.push(close);sum+=close;
      if(i>=200)sum-=closes[i-200];
      if(t>=cutoff.getTime()&&t<=today){high=high===null?h:Math.max(high,h);low=low===null?l:Math.min(low,l)}
      if(t>=start&&t<today){
        var ma=i>=199&&t-times[i-199]===199*DAY?sum/200:null;
        points.push([t,close,ma]);
      }
    }
    return {closes:closes,high:high,low:low,points:points};
  }
  function loadPrefs(){
    try{
      var raw=localStorage.getItem(PREF_KEY);
      if(raw===null)return;
      var p=JSON.parse(raw);
      if(!p||typeof p.coin!=="string"||!/^\d+$/.test(p.coin)||
         (p.scale!=="all"&&p.scale!=="focus")||!Array.isArray(p.hidden)||
         p.hidden.some(function(id){return !SERIES.some(function(s){return s.id===id})})){
        throw new Error("Invalid chart settings");
      }
      prefs={coin:p.coin,scale:p.scale,hidden:p.hidden};
    }catch(e){
      console.warn("Couldn’t read chart settings:",e);
      el("chartPrefNotice").textContent="Chart settings could not be read in this browser.";
    }
  }
  function savePrefs(){
    try{
      localStorage.setItem(PREF_KEY,JSON.stringify(prefs));
      el("chartPrefNotice").textContent="";
    }catch(e){
      console.warn("Couldn’t save chart settings:",e);
      el("chartPrefNotice").textContent="Chart settings could not be saved in this browser.";
    }
  }
  function makeLegend(){
    var field=el("chartLegend");
    SERIES.forEach(function(s){
      var label=document.createElement("label"),input=document.createElement("input"),swatch=document.createElement("span");
      var name=document.createElement("span"),value=document.createElement("span");
      input.type="checkbox";input.value=s.id;input.checked=prefs.hidden.indexOf(s.id)<0;
      swatch.className="chart-swatch";swatch.style.setProperty("--series-color",s.color);swatch.setAttribute("aria-hidden","true");
      name.textContent=s.label;value.className="chart-value";
      label.title=s.description;
      label.appendChild(input);label.appendChild(swatch);label.appendChild(name);label.appendChild(value);
      field.appendChild(label);items[s.id]={label:label,input:input,value:value};
    });
  }
  function findCoin(id){
    for(var i=0;i<coins.length;i++)if(String(coins[i].id)===id)return coins[i];
    return null;
  }
  function fillCoins(){
    var select=el("chartCoin"),next=JSON.stringify(coins.map(function(c){return [c.id,c.sym,c.name]}));
    if(next!==signature){
      signature=next;select.innerHTML="";
      if(!coins.length){
        var empty=document.createElement("option");empty.textContent="Loading…";empty.value="";select.appendChild(empty);
      }else{
        coins.forEach(function(c){
          var option=document.createElement("option");option.value=String(c.id);option.textContent=c.sym+" – "+c.name;select.appendChild(option);
        });
      }
    }
    select.disabled=!coins.length;
    if(!coins.length)return null;
    var row=findCoin(prefs.coin)||findCoin("1")||coins[0];
    prefs.coin=String(row.id);select.value=prefs.coin;
    return row;
  }
  function validPoints(points){
    if(!Array.isArray(points)||points.length>30)return false;
    var previous=-1;
    return points.every(function(p){
      if(!Array.isArray(p)||p.length!==3||!Number.isSafeInteger(p[0])||p[0]<=0||p[0]<=previous||p[0]%DAY!==0||
         !Number.isFinite(p[1])||p[1]<=0||(p[2]!==null&&(!Number.isFinite(p[2])||p[2]<=0)))return false;
      previous=p[0];return true;
    });
  }
  function seriesValue(s,row,points){
    var last=points[points.length-1];
    if(s.id==="close")return last[1];
    if(s.id==="ma")return last[2];
    if(s.id==="hi")return row.chartHigh===undefined?row.hi:row.chartHigh;
    if(s.id==="lo")return row.chartLow===undefined?row.lo:row.chartLow;
    return s.value;
  }
  function available(s,row,points){
    if(s.id==="ma")return points.some(function(p){return p[2]!==null});
    var value=seriesValue(s,row,points);
    return Number.isFinite(value)&&value>0;
  }
  function updateLegend(row,points){
    SERIES.forEach(function(s){
      var item=items[s.id],value=seriesValue(s,row,points),has=available(s,row,points);
      item.label.hidden=!!s.btc&&String(row.id)!=="1";
      item.input.disabled=!has;
      item.value.textContent=value==null?"n/a":formatPrice(value);
      item.input.setAttribute("aria-label",s.label+": "+(value==null?"not available":formatPrice(value))+". "+s.description);
    });
  }
  function svgNode(name,attrs,text){
    var node=document.createElementNS(SVG_NS,name);
    Object.keys(attrs||{}).forEach(function(k){node.setAttribute(k,String(attrs[k]))});
    if(text!=null)node.textContent=text;
    return node;
  }
  function rangeFor(row,points){
    var values=[];
    if(prefs.scale==="focus")values=points.map(function(p){return p[1]});
    else{
      SERIES.forEach(function(s){
        var item=items[s.id];
        if(item.label.hidden||item.input.disabled||!item.input.checked)return;
        if(s.id==="close")points.forEach(function(p){values.push(p[1])});
        else if(s.id==="ma")points.forEach(function(p){if(p[2]!==null)values.push(p[2])});
        else values.push(seriesValue(s,row,points));
      });
      if(!values.length)values=points.map(function(p){return p[1]});
    }
    var min=Math.min.apply(null,values),max=Math.max.apply(null,values);
    var padding=(max-min)*0.06||Math.abs(min)*0.05;
    return {min:Math.max(0,min-padding),max:max+padding};
  }
  function clearChart(message){
    var svg=el("chartSvg");
    svg.setAttribute("hidden","");el("chartLegend").hidden=true;
    el("chartStatus").textContent=message;el("chartReadout").textContent="";
    geometry=null;hoverIndex=-1;
  }
  function render(){
    var row=findCoin(el("chartCoin").value);
    if(!row){clearChart(marketError?"Market data is unavailable ("+marketError+").":"Loading market data…");return}
    if(row.historyLoading||!row.state){clearChart("Loading "+row.sym+" history from the existing Binance requests…");return}
    if(row.state==="na"&&!Array.isArray(row.chartHistory)){clearChart("Binance history is unavailable for "+row.sym+(row.historyError?" ("+row.historyError+")":"")+".");return}
    if(!Array.isArray(row.chartHistory)){
      var reason=row.state==="stable"?"History is not loaded for this stablecoin.":"This saved snapshot predates the chart. History will appear after the next allowed market refresh.";
      clearChart(reason);return;
    }
    if(!validPoints(row.chartHistory)){
      clearChart("Saved chart data is invalid; it will be replaced on the next market refresh.");return;
    }
    var points=row.chartHistory;
    if(!points.length){clearChart("No completed daily candles are available for "+row.sym+" in the last 30 UTC days.");return}
    var last=points[points.length-1],asOf=new Date(last[0]).toISOString().slice(0,10);
    var today=new Date(),todayUtc=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());
    var status=row.name+" ("+row.sym+"): "+points.length+" of 30 completed UTC days, through "+asOf+".";
    if(updated)status+=" Market data updated "+new Date(updated).toLocaleString()+".";
    if(last[0]<todayUtc-DAY)status+=" The latest daily close is older than yesterday.";
    if(row.state==="na")status+=" Indicators unavailable"+(row.historyError?" ("+row.historyError+")":"")+".";
    el("chartStatus").textContent=status;
    var svg=el("chartSvg");svg.removeAttribute("hidden");el("chartLegend").hidden=false;
    svg.setAttribute("aria-label",row.name+" 30-day price chart. Use the left and right arrow keys to inspect daily values.");
    updateLegend(row,points);
    var width=Math.max(280,svg.clientWidth),height=300,left=82,right=width-16,top=18,bottom=height-42;
    var range=rangeFor(row,points),span=range.max-range.min,start=points[0][0],duration=last[0]-start;
    function x(t){return duration?left+(t-start)/duration*(right-left):(left+right)/2}
    function y(value){return bottom-(value-range.min)/span*(bottom-top)}
    svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.innerHTML="";
    var defs=svgNode("defs"),clip=svgNode("clipPath",{id:"priceChartClip"});
    clip.appendChild(svgNode("rect",{x:left,y:top,width:right-left,height:bottom-top}));defs.appendChild(clip);svg.appendChild(defs);
    for(var i=0;i<=4;i++){
      var gy=top+(bottom-top)*i/4,value=range.max-span*i/4;
      svg.appendChild(svgNode("line",{x1:left,y1:gy,x2:right,y2:gy,stroke:"var(--line)"}));
      svg.appendChild(svgNode("text",{x:left-8,y:gy+4,"text-anchor":"end",fill:"var(--muted)","font-size":11},formatPrice(value)));
    }
    var ticks=points.length===1?[0]:[0,Math.floor((points.length-1)/2),points.length-1];
    ticks.filter(function(v,i,a){return a.indexOf(v)===i}).forEach(function(i){
      svg.appendChild(svgNode("text",{x:x(points[i][0]),y:bottom+20,"text-anchor":i===0?"start":i===points.length-1?"end":"middle",fill:"var(--muted)","font-size":11},new Date(points[i][0]).toISOString().slice(5,10)));
    });
    var plot=svgNode("g",{"clip-path":"url(#priceChartClip)"});
    SERIES.forEach(function(s){
      var item=items[s.id];
      if(s.id==="close"||s.id==="ma"||item.label.hidden||item.input.disabled||!item.input.checked)return;
      var v=seriesValue(s,row,points);
      plot.appendChild(svgNode("line",{"data-series":s.id,x1:left,y1:y(v),x2:right,y2:y(v),stroke:s.color,"stroke-width":1.5,"stroke-dasharray":"6 4"}));
      if(prefs.scale==="focus"&&(v<range.min||v>range.max))item.value.textContent=formatPrice(v)+" (outside view)";
    });
    ["ma","close"].forEach(function(id){
      var s=SERIES.filter(function(v){return v.id===id})[0],item=items[id];
      if(item.input.disabled||!item.input.checked)return;
      var path="",markers=[];
      points.forEach(function(p,i){
        var v=id==="close"?p[1]:p[2];
        if(v===null)return;
        var prev=points[i-1],next=points[i+1];
        var connected=!!prev&&prev[0]+DAY===p[0]&&(id==="close"||prev[2]!==null);
        var connectedNext=!!next&&p[0]+DAY===next[0]&&(id==="close"||next[2]!==null);
        var px=x(p[0]),py=y(v);path+=(connected?" L ":" M ")+px.toFixed(2)+" "+py.toFixed(2);
        if(!connected&&!connectedNext)markers.push({x:px,y:py});
      });
      if(path)plot.appendChild(svgNode("path",{"data-series":id,d:path.trim(),fill:"none",stroke:s.color,"stroke-width":id==="close"?2.5:2,"stroke-linejoin":"round","stroke-linecap":"round"}));
      markers.forEach(function(p){plot.appendChild(svgNode("circle",{"data-series":id,cx:p.x,cy:p.y,r:3,fill:s.color}))});
    });
    var cross=svgNode("line",{x1:left,y1:top,x2:left,y2:bottom,stroke:"var(--muted)","stroke-dasharray":"3 3",visibility:"hidden"});
    plot.appendChild(cross);svg.appendChild(plot);
    geometry={points:points,width:width,left:left,right:right,start:start,duration:duration,cross:cross};
    hoverIndex=-1;el("chartReadout").textContent="Hover over the chart or use the left and right arrow keys to inspect a day.";
  }
  function showPoint(index){
    if(!geometry)return;
    var p=geometry.points[index],x=geometry.duration?geometry.left+(p[0]-geometry.start)/geometry.duration*(geometry.right-geometry.left):(geometry.left+geometry.right)/2;
    geometry.cross.setAttribute("x1",x);geometry.cross.setAttribute("x2",x);geometry.cross.setAttribute("visibility","visible");
    hoverIndex=index;
    el("chartReadout").textContent=new Date(p[0]).toISOString().slice(0,10)+" UTC · Close "+formatPrice(p[1])+" · MA200 "+(p[2]===null?"n/a":formatPrice(p[2]));
  }
  function pointer(e){
    if(!geometry)return;
    var rect=el("chartSvg").getBoundingClientRect();
    if(!rect.width)return;
    var px=(e.clientX-rect.left)*geometry.width/rect.width;
    var ratio=Math.max(0,Math.min(1,(px-geometry.left)/(geometry.right-geometry.left)));
    var target=geometry.start+geometry.duration*ratio,best=0;
    geometry.points.forEach(function(p,i){if(Math.abs(p[0]-target)<Math.abs(geometry.points[best][0]-target))best=i});
    showPoint(best);
  }
  function init(){
    loadPrefs();makeLegend();el("chartScale").value=prefs.scale;
    el("chartCoin").addEventListener("change",function(){prefs.coin=this.value;savePrefs();render()});
    el("chartScale").addEventListener("change",function(){prefs.scale=this.value;savePrefs();render()});
    el("chartLegend").addEventListener("change",function(){
      prefs.hidden=SERIES.filter(function(s){return !items[s.id].input.checked}).map(function(s){return s.id});
      savePrefs();render();
    });
    var svg=el("chartSvg");
    svg.addEventListener("pointermove",pointer);svg.addEventListener("pointerdown",pointer);
    svg.addEventListener("pointerleave",function(){
      if(geometry){geometry.cross.setAttribute("visibility","hidden");hoverIndex=-1;el("chartReadout").textContent="Hover over the chart or use the left and right arrow keys to inspect a day."}
    });
    svg.addEventListener("keydown",function(e){
      if(!geometry||(e.key!=="ArrowLeft"&&e.key!=="ArrowRight"))return;
      e.preventDefault();
      var next=hoverIndex<0?(e.key==="ArrowLeft"?geometry.points.length-1:0):hoverIndex+(e.key==="ArrowLeft"?-1:1);
      showPoint(Math.max(0,Math.min(geometry.points.length-1,next)));
    });
    window.addEventListener("resize",function(){
      if(resizeFrame!==null)cancelAnimationFrame(resizeFrame);
      resizeFrame=requestAnimationFrame(function(){resizeFrame=null;render()});
    });
  }
  function sync(rows,time,error){coins=rows;updated=time;marketError=error;fillCoins();render()}
  return {init:init,sync:sync,processCandles:processCandles};
})();
if(typeof module!=="undefined"&&module.exports)module.exports=PriceChart;
