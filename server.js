const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
let CACHE = { items: [], lastFetch: 0 };
const H48 = 48*60*60*1000;
const H6  = 6*60*60*1000;

app.use(express.static(path.join(__dirname,'static')));
app.use(express.static(path.join(__dirname)));

// Hacker News - 100% reliable, public API, no IP blocking
async function fetchHN() {
  try {
    const [top,fresh] = await Promise.allSettled([
      fetch('https://hacker-news.firebaseio.com/v0/topstories.json').then(r=>r.json()),
      fetch('https://hacker-news.firebaseio.com/v0/newstories.json').then(r=>r.json())
    ]);
    const ids = [...new Set([
      ...((top.status==='fulfilled'?top.value:[]).slice(0,20)),
      ...((fresh.status==='fulfilled'?fresh.value:[]).slice(0,10))
    ])];
    const stories = await Promise.allSettled(ids.map(id=>fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r=>r.json())));
    return stories
      .filter(r=>r.status==='fulfilled'&&r.value?.title)
      .map(r=>{const d=r.value;return{platform:'Hacker News',title:d.title,meta:`${d.score||0} pts · ${d.descendants||0} comments · by ${d.by}`,url:d.url||`https://news.ycombinator.com/item?id=${d.id}`,tags:['hackernews'],score:(d.score||0)+(d.descendants||0)*2,seenAt:(d.time||0)*1000,lastSeen:Date.now()};})
      .filter(i=>Date.now()-i.seenAt<=H48);
  } catch(e){ console.log('HN error:',e.message); return []; }
}

// Dev.to - 100% reliable public API
async function fetchDevTo() {
  try {
    const [top,fresh] = await Promise.allSettled([
      fetch('https://dev.to/api/articles?top=1&per_page=20',{headers:{'User-Agent':'TokyoRadar/1.0'}}).then(r=>r.json()),
      fetch('https://dev.to/api/articles?per_page=15',{headers:{'User-Agent':'TokyoRadar/1.0'}}).then(r=>r.json()),
    ]);
    const all = [...(top.value||[]), ...(fresh.value||[])];
    const seen = new Set();
    return all
      .filter(a=>{if(seen.has(a.id))return false;seen.add(a.id);return true;})
      .map(a=>{const t=new Date(a.published_at||a.created_at).getTime();return{platform:'Dev.to',title:a.title,meta:`${a.positive_reactions_count} ❤️ · ${a.comments_count} 💬 · ${a.user.name}`,url:a.url,tags:a.tag_list||[],score:a.positive_reactions_count+(a.comments_count*2),seenAt:isNaN(t)?Date.now():t,lastSeen:Date.now()};})
      .filter(i=>Date.now()-i.seenAt<=H48);
  } catch(e){ console.log('DevTo error:',e.message); return []; }
}

// GitHub Trending - public, no auth, no IP blocking (via unofficial API)
async function fetchGitHub() {
  try {
    const res = await fetch('https://api.github.com/search/repositories?q=created:>2026-10-01&sort=stars&order=desc&per_page=20',{
      headers:{'User-Agent':'TokyoRadar/1.0','Accept':'application/vnd.github.v3+json'}
    });
    if(!res.ok) throw new Error(res.status);
    const json = await res.json();
    return (json.items||[]).map(r=>{return{
      platform:'GitHub',
      title:`${r.full_name} — ${r.description||'No description'}`,
      meta:`⭐ ${(r.stargazers_count||0).toLocaleString()} stars · ${r.language||'Unknown'}`,
      url:r.html_url,
      tags:[r.language,r.topics?.[0]].filter(Boolean),
      score:r.stargazers_count||0,
      seenAt:new Date(r.created_at).getTime(),
      lastSeen:Date.now()
    };});
  } catch(e){ console.log('GitHub error:',e.message); return []; }
}

// Product Hunt - public RSS, no IP blocking
async function fetchProductHunt() {
  try {
    const res = await fetch('https://www.producthunt.com/feed',{
      headers:{'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36','Accept':'application/rss+xml,text/xml,*/*'}
    });
    if(!res.ok) throw new Error(res.status);
    const xml = await res.text();
    const items=[];
    const rx=/<item>([\s\S]*?)<\/item>/g; let m;
    while((m=rx.exec(xml))!==null){
      const b=m[1];
      const title=(b.match(/<title><!\[CDATA\[(.*?)\]\]>/)||b.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
      const link=(b.match(/<link>(.*?)<\/link>/)||[])?.[1]?.trim();
      const pub=b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
      const t=pub?new Date(pub).getTime():Date.now();
      if(title&&!isNaN(t)&&Date.now()-t<=H48){
        items.push({platform:'Product Hunt',title,meta:'🚀 New launch',url:link||'https://producthunt.com',tags:['startup','product'],score:0,seenAt:t,lastSeen:Date.now()});
      }
    }
    return items.slice(0,20);
  } catch(e){ console.log('ProductHunt error:',e.message); return []; }
}

// The Verge RSS - reliable tech news RSS
async function fetchVerge() {
  try {
    const res = await fetch('https://www.theverge.com/rss/index.xml',{
      headers:{'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36','Accept':'application/rss+xml,text/xml,*/*'}
    });
    if(!res.ok) throw new Error(res.status);
    const xml = await res.text();
    const items=[];
    const rx=/<entry>([\s\S]*?)<\/entry>/g; let m;
    while((m=rx.exec(xml))!==null){
      const b=m[1];
      const title=b.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/,'$1')?.replace(/&amp;/g,'&')?.replace(/&lt;/g,'<')?.trim();
      const link=b.match(/<link[^>]+href="([^"]+)"/)?.[1]||b.match(/<link>(.*?)<\/link>/)?.[1]?.trim();
      const updated=b.match(/<updated>(.*?)<\/updated>/)?.[1]?.trim();
      const t=updated?new Date(updated).getTime():Date.now();
      if(title&&!isNaN(t)&&Date.now()-t<=H48){
        items.push({platform:'The Verge',title,meta:'📰 Tech news',url:link||'https://theverge.com',tags:['tech','news'],score:0,seenAt:t,lastSeen:Date.now()});
      }
    }
    return items.slice(0,20);
  } catch(e){ console.log('Verge error:',e.message); return []; }
}

// Lobste.rs - HN-style tech community, public JSON API, zero blocking
async function fetchLobsters() {
  try {
    const [hot,fresh] = await Promise.allSettled([
      fetch('https://lobste.rs/hottest.json',{headers:{'User-Agent':'TokyoRadar/1.0'}}).then(r=>r.json()),
      fetch('https://lobste.rs/newest.json',{headers:{'User-Agent':'TokyoRadar/1.0'}}).then(r=>r.json()),
    ]);
    const all=[...(hot.value||[]),...(fresh.value||[])];
    const seen=new Set();
    return all
      .filter(s=>{if(seen.has(s.short_id))return false;seen.add(s.short_id);return true;})
      .map(s=>{const t=new Date(s.created_at).getTime();return{
        platform:'Lobsters',title:s.title,
        meta:`${s.score||0} pts · ${s.comment_count||0} comments · ${s.submitter_user.username}`,
        url:s.url||`https://lobste.rs/s/${s.short_id}`,
        tags:s.tags||[],score:(s.score||0)+(s.comment_count||0)*2,seenAt:isNaN(t)?Date.now():t,lastSeen:Date.now()
      };})
      .filter(i=>Date.now()-i.seenAt<=H48);
  } catch(e){ console.log('Lobsters error:',e.message); return []; }
}

function merge(ex,fr){
  const map=new Map();
  for(const i of ex) map.set(`${i.platform}::${i.title.toLowerCase().trim()}`,i);
  for(const i of fr){const k=`${i.platform}::${i.title.toLowerCase().trim()}`;if(map.has(k)){map.get(k).lastSeen=i.lastSeen;map.get(k).score=i.score;}else map.set(k,i);}
  return Array.from(map.values()).filter(i=>Date.now()-i.seenAt<=H48).sort((a,b)=>b.seenAt-a.seenAt);
}

async function fetchAll(){
  const [hn,dev,gh,ph,vg,lb]=await Promise.all([
    fetchHN(),fetchDevTo(),fetchGitHub(),fetchProductHunt(),fetchVerge(),fetchLobsters()
  ]);
  const fresh=[...hn,...dev,...gh,...ph,...vg,...lb];
  CACHE.items=merge(CACHE.items,fresh);
  CACHE.lastFetch=Date.now();
  console.log(`[${new Date().toLocaleTimeString()}] Items: ${CACHE.items.length} | HN:${hn.length} Dev:${dev.length} GH:${gh.length} PH:${ph.length} VG:${vg.length} LB:${lb.length}`);
}
fetchAll();
setInterval(fetchAll,60000);

app.get('/api/trends',(req,res)=>{
  const now=Date.now(),items=CACHE.items;
  res.json({updated_at:CACHE.lastFetch,sources:[...new Set(items.map(i=>i.platform))],now_items:items.filter(i=>now-i.seenAt<=H6),history_items:items.filter(i=>now-i.seenAt>H6),all_items:items});
});
app.get('/api/status',(req,res)=>res.json({ok:true,items:CACHE.items.length}));
app.listen(PORT,()=>console.log(`Tokyo Radar running at http://localhost:${PORT}`));
