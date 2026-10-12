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

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function parseXmlItems(xml, tag) {
  const items = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) items.push(m[1]);
  return items;
}
function getTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'))
           || block.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}
function getAttr(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
  return m ? m[1].trim() : '';
}

async function fetchReddit() {
  try {
    const subs = ['popular','technology','worldnews','programming','business'];
    const results = await Promise.allSettled(subs.map(sub =>
      fetch(`https://www.reddit.com/r/${sub}/.rss`, {
        headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/xml,text/xml,*/*' },
        redirect: 'follow'
      }).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    ));
    const items = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const entries = parseXmlItems(r.value, 'entry');
      for (const e of entries) {
        const title = getTag(e, 'title');
        const link = getAttr(e, 'link', 'href') || getTag(e, 'link');
        const updated = getTag(e, 'updated');
        const category = getAttr(e, 'category', 'label') || getTag(e, 'category');
        if (!title || !link) continue;
        const seenAt = updated ? new Date(updated).getTime() : Date.now();
        items.push({ platform: 'Reddit', title, meta: category ? `r/${category}` : 'Reddit', url: link, tags: ['reddit'], score: 0, seenAt, lastSeen: Date.now() });
      }
    }
    return items.filter(i => Date.now() - i.seenAt <= H48);
  } catch(e) { console.error('Reddit error:', e.message); return []; }
}

async function fetchGoogle() {
  // Try multiple Google Trends endpoints
  const endpoints = [
    'https://trends.google.com/trending/rss?geo=US',
    'https://trends.google.com/trends/trendingsearches/realtime/rss?geo=US&cat=all',
    'https://trends.google.com/trends/trendingsearches/daily/rss?geo=US&hl=en-US',
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/xml,application/xml,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://trends.google.com/' },
        redirect: 'follow'
      });
      if (!res.ok) { console.error(`Google Trends ${url} => ${res.status}`); continue; }
      const xml = await res.text();
      const rawItems = parseXmlItems(xml, 'item');
      if (!rawItems.length) continue;
      const items = rawItems.map(item => {
        const title = getTag(item, 'title');
        const traffic = getTag(item, 'ht:approx_traffic') || getTag(item, 'approx_traffic') || '';
        // Use first news article URL, falling back to a Google search for the trend
        const newsUrl = getTag(item, 'ht:news_item_url');
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(title)}`;
        const link = (newsUrl && newsUrl.startsWith('http')) ? newsUrl : searchUrl;
        const pubDate = getTag(item, 'pubDate');
        const seenAt = pubDate ? new Date(pubDate).getTime() : Date.now();
        return { platform: 'Google Trends', title, meta: traffic ? `~${traffic} searches` : 'Trending', url: link, tags: ['trending'], score: 0, seenAt: isNaN(seenAt) ? Date.now() : seenAt, lastSeen: Date.now() };
      }).filter(i => i.title && Date.now() - i.seenAt <= H48);
      console.log(`Google Trends OK via ${url}: ${items.length} items`);
      return items;
    } catch(e) { console.error(`Google Trends ${url} error:`, e.message); }
  }
  return [];
}

async function fetchHN() {
  try {
    const [top,fresh] = await Promise.allSettled([
      fetch('https://hacker-news.firebaseio.com/v0/topstories.json').then(r=>r.json()),
      fetch('https://hacker-news.firebaseio.com/v0/newstories.json').then(r=>r.json())
    ]);
    const ids = [...new Set([...((top.status==='fulfilled'?top.value:[]).slice(0,20)),...((fresh.status==='fulfilled'?fresh.value:[]).slice(0,10))])];
    const stories = await Promise.allSettled(ids.map(id=>fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r=>r.json())));
    return stories.filter(r=>r.status==='fulfilled'&&r.value?.title).map(r=>{const d=r.value;return{platform:'Hacker News',title:d.title,meta:`${d.score||0} points · ${d.descendants||0} comments · by ${d.by}`,url:d.url||`https://news.ycombinator.com/item?id=${d.id}`,tags:['hackernews'],score:(d.score||0)+(d.descendants||0),seenAt:(d.time||0)*1000,lastSeen:Date.now()};}).filter(i=>Date.now()-i.seenAt<=H48);
  } catch(e){ return []; }
}

async function fetchDevTo() {
  try {
    const res=await fetch('https://dev.to/api/articles?top=1&per_page=20',{headers:{'User-Agent':'TokyoRadar/1.0'}});
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

async function fetchXTrends() {
  // Try multiple sources for X/Twitter trends
  const sources = [
    // trends24.in — HTML scrape
    async () => {
      const res = await fetch('https://trends24.in/united-states/', {
        headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow'
      });
      if (!res.ok) throw new Error('trends24 ' + res.status);
      const html = await res.text();
      const items = [];
      // trends24 uses <ol class="trend-card__list"> with <a> tags
      const cardRx = /<ol[^>]*class="[^"]*trend-card__list[^"]*"[^>]*>([\s\S]*?)<\/ol>/gi;
      let cardMatch = cardRx.exec(html);
      if (!cardMatch) throw new Error('trends24 no card found');
      const listHtml = cardMatch[1];
      const aRx = /<a[^>]*>([^<]+)<\/a>/gi;
      let m; let rank = 1;
      while ((m = aRx.exec(listHtml)) !== null && rank <= 25) {
        const title = m[1].trim();
        if (title && title.length > 1) {
          items.push({ platform: 'X Trends', title, meta: '#' + rank + ' on X', url: 'https://x.com/search?q=' + encodeURIComponent(title) + '&src=trend_click', tags: ['x'], score: 0, seenAt: Date.now(), lastSeen: Date.now() });
          rank++;
        }
      }
      if (!items.length) throw new Error('trends24 parsed 0 items');
      return items;
    },
    // twittrends.com JSON API
    async () => {
      const res = await fetch('https://twittrends.com/api/trends?country=US&lang=en', {
        headers: { 'User-Agent': CHROME_UA }, redirect: 'follow'
      });
      if (!res.ok) throw new Error('twittrends ' + res.status);
      const json = await res.json();
      const trends = json.trends || json.data || json;
      if (!Array.isArray(trends)) throw new Error('twittrends bad format');
      return trends.slice(0, 25).map((t, i) => ({
        platform: 'X Trends', title: t.name || t.query || t, meta: '#' + (i+1) + ' on X' + (t.tweet_volume ? ' · ' + Number(t.tweet_volume).toLocaleString() + ' tweets' : ''),
        url: 'https://x.com/search?q=' + encodeURIComponent(t.name || t.query || t) + '&src=trend_click',
        tags: ['x'], score: 0, seenAt: Date.now(), lastSeen: Date.now()
      }));
    }
  ];
  for (const src of sources) {
    try { const items = await src(); if (items.length) return items; } catch(e) { console.error('X Trends source error:', e.message); }
  }
  return [];
}

async function fetchAll(){
  const [reddit, google, hn, devto, xtrends] = await Promise.all([fetchReddit(), fetchGoogle(), fetchHN(), fetchDevTo(), fetchXTrends()]);
  CACHE.items = merge(CACHE.items, [...reddit, ...google, ...hn, ...devto, ...xtrends]);
  CACHE.lastFetch = Date.now();
  const counts = { Reddit: reddit.length, 'Google Trends': google.length, 'Hacker News': hn.length, 'Dev.to': devto.length, 'X Trends': xtrends.length };
  console.log(`[${new Date().toLocaleTimeString()}] Fetched:`, counts, '| Total cache:', CACHE.items.length);
}
fetchAll();
setInterval(fetchAll, 60000);

app.get('/api/trends',(req,res)=>{
  const now=Date.now(),items=CACHE.items;
  res.json({updated_at:CACHE.lastFetch,sources:[...new Set(items.map(i=>i.platform))],now_items:items.filter(i=>now-i.seenAt<=H6),history_items:items.filter(i=>now-i.seenAt>H6),all_items:items});
});
app.get('/api/status',(req,res)=>res.json({ok:true,items:CACHE.items.length,sources:[...new Set(CACHE.items.map(i=>i.platform))]}));
app.listen(PORT,()=>console.log(`Tokyo Radar running at http://localhost:${PORT}`));
