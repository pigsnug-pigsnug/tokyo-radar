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

async function fetchYouTube() {
  const countries = [
    {code:'US',label:'🇺🇸'},{code:'GB',label:'🇬🇧'},{code:'IN',label:'🇮🇳'},
    {code:'JP',label:'🇯🇵'},{code:'BR',label:'🇧🇷'},{code:'DE',label:'🇩🇪'},
    {code:'FR',label:'🇫🇷'},{code:'AU',label:'🇦🇺'},{code:'KR',label:'🇰🇷'},{code:'MX',label:'🇲🇽'}
  ];
  const now = Date.now();
  const titleMap = new Map(); // normalized title -> {item, countries[], labels[]}

  const results = await Promise.allSettled(countries.map(c =>
    fetch(`https://www.youtube.com/feeds/videos.xml?chart=most_popular&regionCode=${c.code}`, {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/xml,text/xml,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(8000)
    }).then(r => { if (!r.ok) throw new Error(r.status); return r.text().then(xml => ({xml, c})); })
  ));

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const {xml, c} = r.value;
    const entries = parseXmlItems(xml, 'entry');
    for (const e of entries) {
      const title = getTag(e, 'title');
      const videoId = getTag(e, 'yt:videoId') || (getAttr(e,'link','href')||'').match(/v=([^&]+)/)?.[1];
      const author = getTag(e, 'name') || getTag(e, 'author');
      const published = getTag(e, 'published') || getTag(e, 'updated');
      if (!title || !videoId) continue;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const key = title.toLowerCase().trim().slice(0, 60);
      if (titleMap.has(key)) {
        const ex = titleMap.get(key);
        if (!ex.countries.includes(c.code)) { ex.countries.push(c.code); ex.labels.push(c.label); }
      } else {
        const seenAt = published ? new Date(published).getTime() : now;
        titleMap.set(key, {
          item: { platform: 'YouTube', title, meta: author ? `by ${author}` : 'YouTube', url, tags: ['youtube'], score: 0, seenAt: isNaN(seenAt) ? now : seenAt, lastSeen: now },
          countries: [c.code], labels: [c.label]
        });
      }
    }
  }

  const items = [];
  for (const {item, countries: cs, labels} of titleMap.values()) {
    const global = cs.length >= 2;
    item.meta = (global ? '🌍 ' + labels.join('') + ' · ' : labels[0] + ' · ') + item.meta;
    if (global) item.tags.push('worldwide');
    items.push(item);
  }
  // Sort: worldwide first, then by recency
  items.sort((a,b) => {
    const ag = a.tags.includes('worldwide') ? 1 : 0;
    const bg = b.tags.includes('worldwide') ? 1 : 0;
    if (bg !== ag) return bg - ag;
    return b.seenAt - a.seenAt;
  });
  console.log(`YouTube OK: ${items.length} videos (${items.filter(i=>i.tags.includes('worldwide')).length} worldwide)`);
  return items.slice(0, 50);
}

async function fetchTikTok() {
  const now = Date.now();
  const sources = [
    'https://tokboard.com/',
    'https://www.tiktok.com/discover',
  ];

  // Try tokboard first
  try {
    const res = await fetch('https://tokboard.com/', {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const html = await res.text();
      const items = [];
      const seen = new Set();
      // tokboard shows hashtag trends — try multiple patterns
      const patterns = [
        /#([A-Za-z][A-Za-z0-9]{2,})/g,
        /class="[^"]*hashtag[^"]*"[^>]*>#?([A-Za-z][A-Za-z0-9]{2,})/gi,
        /trending[^>]*>\s*#?([A-Za-z][A-Za-z0-9]{2,})/gi,
        /<a[^>]+href="[^"]*tag[^"]*"[^>]*>#?([A-Za-z][A-Za-z0-9]{2,})/gi,
        /data-[a-z]+=["']#?([A-Za-z][A-Za-z0-9]{2,})["']/gi,
      ];
      for (const rx of patterns) {
        let m; rx.lastIndex = 0;
        while ((m = rx.exec(html)) !== null && items.length < 30) {
          const tag = m[1].trim();
          const skip = 'the and for with you your are was this that new hot top trending viral views likes comments shares videos tiktok tokboard home page search';
          if (tag.length < 3 || skip.split(' ').includes(tag.toLowerCase()) || seen.has(tag.toLowerCase())) continue;
          seen.add(tag.toLowerCase());
          items.push({ platform: 'TikTok', title: '#' + tag, meta: 'Trending on TikTok', url: `https://www.tiktok.com/tag/${tag}`, tags: ['tiktok'], score: 0, seenAt: now, lastSeen: now });
        }
        if (items.length >= 15) break;
      }
      if (items.length >= 5) { console.log(`TikTok OK via tokboard: ${items.length} items`); return items; }
      console.error('TikTok tokboard: parsed only', items.length, 'items');
    } else { console.error('TikTok tokboard:', res.status); }
  } catch(e) { console.error('TikTok tokboard error:', e.message); }

  // Fallback: trendpopular.com
  try {
    const res = await fetch('https://trendpopular.com/tiktok-trends/', {
      headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/html,*/*' },
      redirect: 'follow', signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const html = await res.text();
      const items = [];
      const seen = new Set();
      const rx = /<h[2-4][^>]*>([^<]{5,80})<\/h[2-4]>/gi;
      let m;
      while ((m = rx.exec(html)) !== null && items.length < 20) {
        const title = m[1].trim();
        if (seen.has(title.toLowerCase())) continue;
        seen.add(title.toLowerCase());
        items.push({ platform: 'TikTok', title, meta: 'Trending on TikTok', url: `https://www.tiktok.com/search?q=${encodeURIComponent(title)}`, tags: ['tiktok'], score: 0, seenAt: now, lastSeen: now });
      }
      if (items.length) { console.log(`TikTok OK via trendpopular: ${items.length} items`); return items; }
    }
  } catch(e) { console.error('TikTok trendpopular error:', e.message); }

  console.error('TikTok: all sources failed');
  return [];
}

async function fetchAll(){
  const [reddit, google, hn, devto, xtrends, youtube, tiktok] = await Promise.all([fetchReddit(), fetchGoogle(), fetchHN(), fetchDevTo(), fetchXTrends(), fetchYouTube(), fetchTikTok()]);
  CACHE.items = merge(CACHE.items, [...reddit, ...google, ...hn, ...devto, ...xtrends, ...youtube, ...tiktok]);
  CACHE.lastFetch = Date.now();
  const counts = { Reddit: reddit.length, 'Google Trends': google.length, 'Hacker News': hn.length, 'Dev.to': devto.length, 'X Trends': xtrends.length, YouTube: youtube.length, TikTok: tiktok.length };
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
