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

async function fetchReddit() {
  try {
    // Use RSS feeds which are less blocked than JSON API
    const feeds = [
      'https://www.reddit.com/r/popular.rss?limit=25',
      'https://www.reddit.com/r/technology.rss?limit=25',
      'https://www.reddit.com/r/worldnews.rss?limit=25',
    ];
    const HEADERS = {
      'User-Agent':'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Accept':'application/rss+xml,application/xml,text/xml,*/*',
    };
    const results = await Promise.allSettled(feeds.map(u=>fetch(u,{headers:HEADERS,redirect:'follow'}).then(r=>r.text())));
    const items = [];
    for(const r of results){
      if(r.status!=='fulfilled') continue;
      const xml=r.value;
      const entries=[...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
      for(const m of entries){
        const b=m[1];
        const title=b.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/,'$1')?.trim();
        const link=b.match(/<link[^>]*href="([^"]+)"/)?.[1]||b.match(/<link[^>]*>(.*?)<\/link>/)?.[1]?.trim();
        const updated=b.match(/<updated>(.*?)<\/updated>/)?.[1]?.trim();
        const t=updated?new Date(updated).getTime():Date.now();
        const cat=b.match(/<category[^>]*term="([^"]+)"/)?.[1]||'reddit';
        if(title&&!isNaN(t)&&Date.now()-t<=H48){
          items.push({platform:'Reddit',title,meta:`r/${cat}`,url:link||'https://reddit.com',tags:[cat],score:0,seenAt:t,lastSeen:Date.now()});
        }
      }
    }
    return items;
  } catch(e){ console.log('Reddit error:',e.message); return []; }
}

async function fetchHN() {
  try {
    const [top,fresh] = await Promise.allSettled([
      fetch('https://hacker-news.firebaseio.com/v0/topstories.json').then(r=>r.json()),
      fetch('https://hacker-news.firebaseio.com/v0/newstories.json').then(r=>r.json())
    ]);
    const ids = [...new Set([...((top.status==='fulfilled'?top.value:[]).slice(0,15)),...((fresh.status==='fulfilled'?fresh.value:[]).slice(0,15))])];
    const stories = await Promise.allSettled(ids.map(id=>fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r=>r.json())));
    return stories.filter(r=>r.status==='fulfilled'&&r.value?.title).map(r=>{const d=r.value;return{platform:'Hacker News',title:d.title,meta:`${d.score||0} points · ${d.descendants||0} comments · by ${d.by}`,url:d.url||`https://news.ycombinator.com/item?id=${d.id}`,tags:['hackernews'],score:(d.score||0)+(d.descendants||0),seenAt:(d.time||0)*1000,lastSeen:Date.now()};}).filter(i=>Date.now()-i.seenAt<=H48);
  } catch(e){ return []; }
}

async function fetchGoogle() {
  try {
    // Use multiple fallback trending sources
    const sources = [
      // Bing News RSS - works from cloud, covers trending topics
      'https://feeds.feedburner.com/TechCrunch',
      // Yahoo Finance trending - works from cloud
      'https://finance.yahoo.com/news/rssindex',
    ];
    const items = [];
    for (const url of sources) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Accept': 'application/rss+xml,text/xml,*/*' },
          redirect: 'follow'
        });
        if (!res.ok) continue;
        const xml = await res.text();
        const rx = /<item>([\s\S]*?)<\/item>/g; let m;
        while ((m = rx.exec(xml)) !== null) {
          const b = m[1];
          const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]>/) || b.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
          const link = b.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || b.match(/<link[^>]+href="([^"]+)"/)?.[1];
          const pub = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
          const t = pub ? new Date(pub).getTime() : Date.now();
          const platform = url.includes('TechCrunch') ? 'TechCrunch' : 'Yahoo Finance';
          if (title && !isNaN(t) && Date.now() - t <= H48) {
            items.push({ platform, title, meta: 'trending', url: link || url, tags: ['trending'], score: 0, seenAt: t, lastSeen: Date.now() });
          }
        }
      } catch(e) { console.log('Feed error:', url, e.message); }
    }
    return items.slice(0, 30);
  } catch(e){ console.log('Trends error:',e.message); return []; }
}

async function fetchDevTo() {
  try {
    const res=await fetch('https://dev.to/api/articles?top=1&per_page=15',{headers:{'User-Agent':'TokyoRadar/1.0'}});
    const json=await res.json();
    return json.map(a=>{const t=new Date(a.published_at||a.created_at).getTime();return{platform:'Dev.to',title:a.title,meta:`${a.positive_reactions_count} reactions · ${a.comments_count} comments · by ${a.user.name}`,url:a.url,tags:a.tag_list||[],score:a.positive_reactions_count+a.comments_count*2,seenAt:isNaN(t)?Date.now():t,lastSeen:Date.now()};}).filter(i=>Date.now()-i.seenAt<=H48);
  } catch(e){ return []; }
}

function merge(ex,fr){
  const map=new Map();
  for(const i of ex) map.set(`${i.platform}::${i.title.toLowerCase().trim()}`,i);
  for(const i of fr){const k=`${i.platform}::${i.title.toLowerCase().trim()}`;if(map.has(k)){map.get(k).lastSeen=i.lastSeen;map.get(k).score=i.score;}else map.set(k,i);}
  return Array.from(map.values()).filter(i=>Date.now()-i.seenAt<=H48).sort((a,b)=>b.seenAt-a.seenAt);
}

async function fetchAll(){
  const [r,h,g,d]=await Promise.all([fetchReddit(),fetchHN(),fetchGoogle(),fetchDevTo()]);
  CACHE.items=merge(CACHE.items,[...r,...h,...g,...d]);
  CACHE.lastFetch=Date.now();
  console.log(`[${new Date().toLocaleTimeString()}] Items: ${CACHE.items.length}`);
}
fetchAll();
setInterval(fetchAll,60000);

app.get('/api/trends',(req,res)=>{
  const now=Date.now(),items=CACHE.items;
  res.json({updated_at:CACHE.lastFetch,sources:[...new Set(items.map(i=>i.platform))],now_items:items.filter(i=>now-i.seenAt<=H6),history_items:items.filter(i=>now-i.seenAt>H6),all_items:items});
});
app.get('/api/status',(req,res)=>res.json({ok:true,items:CACHE.items.length}));
app.listen(PORT,()=>console.log(`Tokyo Radar running at http://localhost:${PORT}`));
