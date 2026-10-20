const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
let CACHE = { items: [], lastFetch: 0 };
const H48 = 48*60*60*1000;
const H6  = 6*60*60*1000;
const CACHE_FILE = path.join(__dirname, '.cache.json');

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const saved = JSON.parse(raw);
      // Only restore items that are still within 48h window
      const fresh = (saved.items || []).filter(i => Date.now() - i.seenAt <= H48);
      if (fresh.length) {
        CACHE.items = fresh;
        CACHE.lastFetch = saved.lastFetch || 0;
        console.log(`[Cache] Restored ${fresh.length} items from disk`);
      }
    }
  } catch(e) { console.error('[Cache] Load error:', e.message); }
}

function saveCacheToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ items: CACHE.items, lastFetch: CACHE.lastFetch }));
  } catch(e) { console.error('[Cache] Save error:', e.message); }
}

loadCacheFromDisk();

// No-cache for HTML so browser always gets latest deploy
app.use(function(req,res,next){
  if(req.path==='/'||req.path==='/index.html'){
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
    res.setHeader('Pragma','no-cache');
    res.setHeader('Expires','0');
  }
  next();
});
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
  const subs = ['popular','technology','worldnews','programming','business'];
  // RSS — reliable from any IP, no upvote counts but posts load consistently
  try {
    const rssResults = await Promise.allSettled(subs.map(sub =>
      fetch(`https://www.reddit.com/r/${sub}/.rss`, {
        headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/xml,text/xml,*/*' },
        redirect: 'follow'
      }).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    ));
    const rssItems = [];
    for (const r of rssResults) {
      if (r.status !== 'fulfilled') continue;
      const entries = parseXmlItems(r.value, 'entry');
      for (const e of entries) {
        const title = getTag(e, 'title');
        const link = getAttr(e, 'link', 'href') || getTag(e, 'link');
        const updated = getTag(e, 'updated');
        const category = getAttr(e, 'category', 'label') || getTag(e, 'category');
        if (!title || !link) continue;
        const seenAt = updated ? new Date(updated).getTime() : Date.now();
        rssItems.push({ platform: 'Reddit', title, meta: category ? `r/${category}` : 'Reddit', url: link, tags: ['reddit'], score: 0, seenAt, lastSeen: Date.now() });
      }
    }
    return rssItems.filter(i => Date.now() - i.seenAt <= H48);
  } catch(e) { console.error('Reddit RSS fallback error:', e.message); return []; }
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
  for(const i of fr){
    const k=`${i.platform}::${i.title.toLowerCase().trim()}`;
    if(map.has(k)){
      const existing=map.get(k);
      existing.lastSeen=i.lastSeen;
      existing.score=i.score;
      // Velocity: count how many fetch cycles this item has reappeared
      existing.hitCount=(existing.hitCount||1)+1;
    } else {
      i.hitCount=1;
      map.set(k,i);
    }
  }
  const now=Date.now();
  const H1=60*60*1000;
  const items=Array.from(map.values()).filter(i=>now-i.seenAt<=H48);
  // Compute velocity: items seen multiple times recently get higher score
  for(const i of items){
    const ageH=(now-i.seenAt)/H1; // hours old
    const hits=i.hitCount||1;
    // velocity = 0 (new), 1 (seen 2-3x or very recent multi-hit), 2 (seen 4+ times), 3 (seen 6+ and fresh)
    if(hits>=6&&ageH<6) i.velocity=3;
    else if(hits>=4) i.velocity=2;
    else if(hits>=2) i.velocity=1;
    else i.velocity=0;
  }
  return items.sort((a,b)=>b.seenAt-a.seenAt);
}

async function fetchXTrends() {
  const now = Date.now();

  // Source 1: trends24.in — flexible HTML scrape
  try {
    const res = await fetch('https://trends24.in/united-states/', {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const html = await res.text();
      const items = [];
      const seen = new Set();
      // Try multiple selectors: href="/search?q=..." links, or any <a> inside trend containers
      const patterns = [
        /href="\/search\?q=([^"&]+)[^"]*"[^>]*>([^<]+)<\/a>/gi,
        /<a[^>]+class="[^"]*trend[^"]*"[^>]*>([^<]+)<\/a>/gi,
        /class="[^"]*trend[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi,
        /<li[^>]*>\s*(?:<span[^>]*>\d+<\/span>\s*)?<a[^>]*>([^<]+)<\/a>/gi,
      ];
      for (const rx of patterns) {
        let m; rx.lastIndex = 0;
        while ((m = rx.exec(html)) !== null && items.length < 25) {
          const title = (m[2] || m[1]).trim().replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim();
          if (title.length < 2 || /^[\d\s]+$/.test(title) || seen.has(title.toLowerCase())) continue;
          seen.add(title.toLowerCase());
          const q = m[1] && m[1] !== title ? decodeURIComponent(m[1]) : title;
          items.push({ platform: 'X Trends', title, meta: '#' + items.length+1 + ' on X', url: 'https://x.com/search?q=' + encodeURIComponent(q) + '&src=trend_click', tags: ['x'], score: 0, seenAt: now, lastSeen: now });
        }
        if (items.length >= 10) break;
      }
      if (items.length) { console.log(`X Trends OK via trends24.in: ${items.length} items`); return items; }
      console.error('X Trends trends24.in: reached but parsed 0 items');
    } else { console.error('X Trends trends24.in:', res.status); }
  } catch(e) { console.error('X Trends trends24.in error:', e.message); }

  // Source 2: Nitter public instances RSS
  const nitterHosts = ['https://nitter.poast.org','https://nitter.privacyredirect.com','https://nitter.tiekoetter.com','https://nitter.1d4.us'];
  for (const host of nitterHosts) {
    try {
      const res = await fetch(`${host}/search/rss?f=tweets&q=%23trending&since_id=0`, {
        headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/rss+xml,text/xml,*/*' },
        redirect: 'follow', signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) { console.error(`Nitter ${host} => ${res.status}`); continue; }
      const xml = await res.text();
      const entries = parseXmlItems(xml, 'item');
      if (!entries.length) continue;
      const seen = new Set();
      const items = [];
      for (const e of entries) {
        const title = getTag(e, 'title').replace(/@\w+:\s*/, '').replace(/#(\w)/g,'$1').trim().slice(0,100);
        const link = getTag(e, 'link');
        if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;
        seen.add(title.toLowerCase());
        items.push({ platform: 'X Trends', title, meta: 'Trending on X', url: link || 'https://x.com/search?q='+encodeURIComponent(title), tags: ['x'], score: 0, seenAt: now, lastSeen: now });
        if (items.length >= 20) break;
      }
      if (items.length) { console.log(`X Trends OK via ${host}: ${items.length} items`); return items; }
    } catch(e) { console.error(`Nitter ${host} error:`, e.message); }
  }

  console.error('X Trends: all sources failed');
  return [];
}

async function fetchTikTok() {
  const now = Date.now();
  // trends24.in has a TikTok section — same domain that works for X Trends
  try {
    const res = await fetch('https://trends24.in/united-states/', {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const html = await res.text();
      // Look for TikTok section — trends24 sometimes includes it
      const ttSection = html.match(/tiktok[\s\S]{0,5000}/i)?.[0] || '';
      if (ttSection) {
        const items = [];
        const seen = new Set();
        const rx = /#([A-Za-z][A-Za-z0-9]{2,})/g;
        let m;
        while ((m = rx.exec(ttSection)) !== null && items.length < 20) {
          const tag = m[1];
          const skip = new Set('fyp foryou foryoupage trending viral tiktok'.split(' '));
          if (skip.has(tag.toLowerCase()) || seen.has(tag.toLowerCase())) continue;
          seen.add(tag.toLowerCase());
          items.push({ platform: 'TikTok', title: '#' + tag, meta: 'Trending on TikTok', url: `https://www.google.com/search?q=%23${encodeURIComponent(tag)}+tiktok+trend`, tags: ['tiktok'], score: 0, seenAt: now, lastSeen: now });
        }
        if (items.length >= 5) { console.log(`TikTok OK via trends24 TikTok section: ${items.length} items`); return items; }
      }
    }
  } catch(e) { console.error('TikTok trends24 error:', e.message); }

  // Fallback: Google Trends as proxy for TikTok-adjacent topics
  // Use Reddit r/TikTokTrends or similar — actually scrape explodingTopics
  try {
    const res = await fetch('https://explodingtopics.com/blog/tiktok-trends', {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/html,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const html = await res.text();
      const items = [];
      const seen = new Set();
      const rx = /<h[2-3][^>]*>([^<]{5,80})<\/h[2-3]>/gi;
      let m;
      while ((m = rx.exec(html)) !== null && items.length < 15) {
        const title = m[1].trim();
        if (seen.has(title.toLowerCase()) || title.length < 5) continue;
        seen.add(title.toLowerCase());
        items.push({ platform: 'TikTok', title, meta: 'TikTok trend', url: `https://www.google.com/search?q=${encodeURIComponent(title)}+tiktok+trend`, tags: ['tiktok'], score: 0, seenAt: now, lastSeen: now });
      }
      if (items.length >= 3) { console.log(`TikTok OK via explodingtopics: ${items.length} items`); return items; }
    }
  } catch(e) { console.error('TikTok explodingtopics error:', e.message); }

  console.error('TikTok: all sources failed');
  return [];
}

// SOL Web: keyword-filtered feed across Google News, HN Algolia, YouTube, crypto RSS
const SOL_KEYWORDS = ['solana','$sol',' sol ','sol/usd','solana network','solana ecosystem','solana nft','solana defi','solana token','solana blockchain','solana wallet','solana validator','solana dao','sol price','sol pump','sol dump','solana hack','solana exploit','solana upgrade','solana mainnet','solana devnet'];
function isSolMatch(text){
  const t=(text||'').toLowerCase();
  return SOL_KEYWORDS.some(k=>t.includes(k));
}

async function fetchSolWeb(){
  const now=Date.now();
  const results=[];

  // 1. Google News RSS — widest coverage (news sites, blogs, articles)
  try{
    const queries=['solana','SOL+crypto'];
    const rssUrls=queries.map(q=>`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
    const fetches=await Promise.allSettled(rssUrls.map(u=>fetch(u,{headers:{'User-Agent':CHROME_UA},signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.text():Promise.reject(r.status))));
    for(const f of fetches){
      if(f.status!=='fulfilled')continue;
      const items=parseXmlItems(f.value,'item');
      for(const item of items){
        const title=getTag(item,'title');
        const link=getTag(item,'link');
        const pubDate=getTag(item,'pubDate');
        const source=getTag(item,'source')||'Google News';
        if(!title||!isSolMatch(title))continue;
        const seenAt=pubDate?new Date(pubDate).getTime():now;
        results.push({platform:'SOL Web',title,meta:'📰 '+source,url:link||'https://news.google.com',tags:['sol','news'],score:0,seenAt:isNaN(seenAt)?now:seenAt,lastSeen:now});
      }
    }
    console.log(`SOL Web Google News: ${results.length} items so far`);
  }catch(e){console.error('SOL Web Google News error:',e.message);}

  // 2. Hacker News Algolia — searches HN for Solana posts
  try{
    const hnRes=await fetch('https://hn.algolia.com/api/v1/search?query=solana&tags=story&hitsPerPage=20',{signal:AbortSignal.timeout(8000)});
    if(hnRes.ok){
      const hnJson=await hnRes.json();
      for(const hit of (hnJson.hits||[])){
        if(!hit.title)continue;
        const seenAt=hit.created_at?new Date(hit.created_at).getTime():now;
        results.push({platform:'SOL Web',title:hit.title,meta:`💬 HN · ${hit.points||0} pts · ${hit.num_comments||0} comments`,url:hit.url||`https://news.ycombinator.com/item?id=${hit.objectID}`,tags:['sol','hackernews'],score:(hit.points||0)+(hit.num_comments||0)*2,seenAt:isNaN(seenAt)?now:seenAt,lastSeen:now});
      }
    }
  }catch(e){console.error('SOL Web HN Algolia error:',e.message);}

  // 3. YouTube RSS search feed
  try{
    const ytRes=await fetch('https://www.youtube.com/feeds/videos.xml?search_query=solana',{headers:{'User-Agent':CHROME_UA},signal:AbortSignal.timeout(8000)});
    if(ytRes.ok){
      const ytXml=await ytRes.text();
      const entries=parseXmlItems(ytXml,'entry');
      for(const e of entries){
        const title=getTag(e,'title')||getTag(e,'media:title');
        const link=getAttr(e,'link','href')||getTag(e,'link');
        const published=getTag(e,'published');
        const author=getTag(e,'name');
        if(!title)continue;
        const seenAt=published?new Date(published).getTime():now;
        results.push({platform:'SOL Web',title,meta:`▶ YouTube · ${author||''}`,url:link||'https://youtube.com',tags:['sol','youtube'],score:0,seenAt:isNaN(seenAt)?now:seenAt,lastSeen:now});
      }
    }
  }catch(e){console.error('SOL Web YouTube error:',e.message);}

  // 4. CoinTelegraph RSS — crypto news
  try{
    const ctRes=await fetch('https://cointelegraph.com/rss',{headers:{'User-Agent':CHROME_UA},signal:AbortSignal.timeout(8000)});
    if(ctRes.ok){
      const ctXml=await ctRes.text();
      const items=parseXmlItems(ctXml,'item');
      for(const item of items){
        const title=getTag(item,'title');
        const link=getTag(item,'link');
        const pubDate=getTag(item,'pubDate');
        if(!title||!isSolMatch(title))continue;
        const seenAt=pubDate?new Date(pubDate).getTime():now;
        results.push({platform:'SOL Web',title,meta:'📡 CoinTelegraph',url:link||'https://cointelegraph.com',tags:['sol','news'],score:0,seenAt:isNaN(seenAt)?now:seenAt,lastSeen:now});
      }
    }
  }catch(e){console.error('SOL Web CoinTelegraph error:',e.message);}

  // 5. Decrypt RSS — crypto news
  try{
    const dRes=await fetch('https://decrypt.co/feed',{headers:{'User-Agent':CHROME_UA},signal:AbortSignal.timeout(8000)});
    if(dRes.ok){
      const dXml=await dRes.text();
      const items=parseXmlItems(dXml,'item');
      for(const item of items){
        const title=getTag(item,'title');
        const link=getTag(item,'link');
        const pubDate=getTag(item,'pubDate');
        if(!title||!isSolMatch(title))continue;
        const seenAt=pubDate?new Date(pubDate).getTime():now;
        results.push({platform:'SOL Web',title,meta:'📡 Decrypt',url:link||'https://decrypt.co',tags:['sol','news'],score:0,seenAt:isNaN(seenAt)?now:seenAt,lastSeen:now});
      }
    }
  }catch(e){console.error('SOL Web Decrypt error:',e.message);}

  // Dedupe by title
  const seen=new Set();
  const deduped=results.filter(i=>{
    const k=i.title.toLowerCase().trim();
    if(seen.has(k))return false;
    seen.add(k);
    return true;
  });
  console.log(`SOL Web total: ${deduped.length} items`);
  return deduped.filter(i=>now-i.seenAt<=H48);
}

async function fetchAlJazeera() {
  const now = Date.now();
  const feeds = [
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'AJ World' },
    { url: 'https://www.aljazeera.com/xml/rss/newsheadlines.xml', label: 'AJ Headlines' },
  ];
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/xml,application/xml,*/*' },
        redirect: 'follow', signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) { console.error(`Al Jazeera ${feed.url} => ${res.status}`); continue; }
      const xml = await res.text();
      const rawItems = parseXmlItems(xml, 'item');
      if (!rawItems.length) continue;
      const items = rawItems.slice(0, 20).map(item => {
        const title = getTag(item, 'title');
        const link = getTag(item, 'link');
        const pubDate = getTag(item, 'pubDate');
        const seenAt = pubDate ? new Date(pubDate).getTime() : now;
        if (!title) return null;
        return { platform: 'Al Jazeera', title, meta: feed.label, url: link || 'https://www.aljazeera.com', tags: ['news','aljazeera'], score: 0, seenAt: isNaN(seenAt) ? now : seenAt, lastSeen: now };
      }).filter(i => i && i.title && Date.now() - i.seenAt <= H48);
      if (items.length) { console.log(`Al Jazeera OK via ${feed.url}: ${items.length} items`); return items; }
    } catch(e) { console.error(`Al Jazeera ${feed.url} error:`, e.message); }
  }
  return [];
}

async function fetchAll(){
  const [reddit, google, hn, devto, xtrends, tiktok, aljazeera, solweb] = await Promise.all([fetchReddit(), fetchGoogle(), fetchHN(), fetchDevTo(), fetchXTrends(), fetchTikTok(), fetchAlJazeera(), fetchSolWeb()]);
  CACHE.items = merge(CACHE.items, [...reddit, ...google, ...hn, ...devto, ...xtrends, ...tiktok, ...aljazeera, ...solweb]);
  CACHE.lastFetch = Date.now();
  const counts = { Reddit: reddit.length, 'Google Trends': google.length, 'Hacker News': hn.length, 'Dev.to': devto.length, 'X Trends': xtrends.length, TikTok: tiktok.length, 'Al Jazeera': aljazeera.length, 'SOL Web': solweb.length };
  console.log(`[${new Date().toLocaleTimeString()}] Fetched:`, counts, '| Total cache:', CACHE.items.length);
  saveCacheToDisk();
}
fetchAll();
setInterval(fetchAll, 60000);

app.get('/api/trends',(req,res)=>{
  const now=Date.now(),items=CACHE.items;
  res.json({updated_at:CACHE.lastFetch,sources:[...new Set(items.map(i=>i.platform))],now_items:items.filter(i=>now-i.seenAt<=H6),history_items:items.filter(i=>now-i.seenAt>H6),all_items:items});
});
app.get('/api/status',(req,res)=>res.json({ok:true,items:CACHE.items.length,sources:[...new Set(CACHE.items.map(i=>i.platform))]}));
app.listen(PORT,()=>console.log(`Tokyo Radar running at http://localhost:${PORT}`));
