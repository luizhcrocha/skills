/**
 * The hub's index: every fleet on this machine and on each peer hub, grouped by machine, with what
 * each is doing, what waits on the user in it, whether its host reads the chat, and the way to its
 * page. The plan's usage and the gate sit on top, the ports the machine serves that no fleet names at
 * the bottom. The page follows `/events` (`fleets` events) and draws itself again on each.
 */
import { dumps, type JsonObject } from "../json.ts";

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#e3e2dc;--accent:#2f6fde;--warn:#b5620b;--bad:#c2372f;--good:#2c8a4b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--mute:#9b9b94;--line:#33332f;--accent:#7aa7ff;--warn:#e3a14b;--bad:#ff7b72;--good:#56c27a;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}
h1{font-size:20px;margin:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:24px 0 8px;font-weight:600}
.live{font-size:12px;color:var(--mute)}.live::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--mute);margin-right:6px;vertical-align:middle}
.live.on::before{background:var(--good)}
.bars{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--mute)}
.bar{min-width:180px}.bar i{display:block;height:6px;background:var(--line);border-radius:3px;margin-top:4px;overflow:hidden}.bar i b{display:block;height:100%;background:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
a.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:inherit;text-decoration:none}
a.card:hover{border-color:var(--accent)}
.top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.name{font-weight:600;font-size:15px;overflow-wrap:anywhere}
.pill{font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid var(--line);color:var(--mute);white-space:nowrap}
.pill.running{color:var(--good);border-color:var(--good)}.pill.blocked{color:var(--bad);border-color:var(--bad)}.pill.paused{color:var(--warn);border-color:var(--warn)}
.now{margin:6px 0;overflow-wrap:anywhere}
.meta{font-size:12px;color:var(--mute);display:flex;gap:10px;flex-wrap:wrap}
.need{color:var(--bad);font-weight:600}.deaf{color:var(--warn)}
ul.asks{margin:6px 0 0;padding-left:18px;font-size:13px}
.empty{color:var(--mute);font-size:13px}
table{border-collapse:collapse;font-size:12px;width:100%}td{border-top:1px solid var(--line);padding:4px 6px;vertical-align:top;overflow-wrap:anywhere}
`;

const SCRIPT = `
(function(){
  var esc=function(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})};
  var ago=function(t){var d=(Date.now()-Date.parse(t))/1000;if(!isFinite(d))return"";if(d<60)return"just now";if(d<3600)return Math.floor(d/60)+" min ago";if(d<86400)return Math.floor(d/3600)+" h ago";return Math.floor(d/86400)+" d ago"};
  function card(f){
    var open=(f.decisions||[]).filter(function(d){return d.asks!=="manager"});
    var w=f.workers||{},running=(w.running||0)+(w.blocked||0)+(w.queued||0);
    var chat=f.chat||{};
    var meta=[];
    if(open.length)meta.push('<span class="need">'+open.length+' waiting on you</span>');
    if(chat.unread)meta.push('<span class="'+(chat.on?"":"deaf")+'">'+chat.unread+' unread'+(chat.on?"":", chat not read")+'</span>');
    meta.push(running+" worker"+(running===1?"":"s")+" live");
    if(f.roadblocks)meta.push(f.roadblocks+" roadblock"+(f.roadblocks===1?"":"s"));
    if(f.now_at)meta.push("said "+ago(f.now_at));
    var asks=open.slice(0,4).map(function(d){return"<li>"+esc((d.ref?d.ref+" ":"")+d.title)+(d.answered?" (answered)":"")+"</li>"}).join("");
    return '<a class="card" href="'+esc(f.path)+'"><div class="top"><span class="name">'+esc(f.id)+(f.role==="manager"?" (manager)":"")+'</span><span class="pill '+esc(f.status)+'">'+esc(f.status)+'</span></div>'+
      '<div class="now">'+esc(f.now||f.goal||"")+'</div><div class="meta">'+meta.join("")+'</div>'+(asks?'<ul class="asks">'+asks+"</ul>":"")+"</a>";
  }
  function draw(p){
    var out="";
    var u=p.usage||{};
    var bars=[["five_hour","5-hour window"],["seven_day","7-day window"]].filter(function(k){return u[k[0]]}).map(function(k){var r=u[k[0]];return'<div class="bar">'+k[1]+": "+esc(r.used_percentage)+'% used<i><b style="width:'+Math.min(100,Number(r.used_percentage)||0)+'%"></b></i></div>'}).join("");
    document.getElementById("bars").innerHTML=bars+(p.gate?'<div class="bar">gate held by '+esc(p.gate.fleet)+": "+esc(p.gate.what)+"</div>":"");
    (p.machines||[]).forEach(function(m){
      out+="<h2>"+esc(m.name)+(m.here?" (this machine)":"")+"</h2>";
      out+=m.fleets&&m.fleets.length?'<div class="grid">'+m.fleets.map(card).join("")+"</div>":'<p class="empty">No fleet is being served here.</p>';
    });
    var found=p.found||[];
    if(found.length)out+="<h2>Also served on this machine</h2><table>"+found.map(function(x){return'<tr><td><a href="'+esc(x.url)+'" target="_blank" rel="noopener">'+esc(x.url)+"</a></td><td>"+(x.up?"up":"down")+"</td><td>"+esc(x.fleet||"(no fleet)")+"</td><td>"+esc(x.cwd)+"</td></tr>"}).join("")+"</table>";
    document.getElementById("machines").innerHTML=out;
  }
  var data=JSON.parse(document.getElementById("fleets").textContent);
  draw(data);
  setInterval(function(){draw(data)},30000);
  var live=document.getElementById("live");
  if(window.EventSource){
    var es=new EventSource("events");
    es.addEventListener("open",function(){live.className="live on";live.textContent="live"});
    es.addEventListener("fleets",function(e){try{data=JSON.parse(e.data);draw(data)}catch(_){}});
    es.onerror=function(){live.className="live";live.textContent="reconnecting"};
  }
})();
`;

/** The index page with `payload` (what `Hub.indexPayload` returns) inlined. */
export function indexHtml(payload: JsonObject): string {
  const data = dumps(payload, { ensureAscii: false }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Fleets</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header><h1>Fleets</h1><span class="live" id="live">connecting</span></header>
<div class="bars" id="bars"></div>
<div id="machines"></div>
</main>
<script id="fleets" type="application/json">${data}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
