const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = 4112;
const HOST = '0.0.0.0';

// Favorites are stored server-side so all browsers/devices share them.
const FAVS_FILE = path.join(__dirname, 'favs.json');

// In-memory cache for group discussion lists (reduces upstream requests and
// makes repeat visits instant). Payload is the full JSON response object.
const groupCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function readFavs() {
  try {
    const j = JSON.parse(fs.readFileSync(FAVS_FILE, 'utf8'));
    if (Array.isArray(j.favs)) return j.favs;
  } catch (e) { /* missing/corrupt -> empty */ }
  return [];
}

function sanitizeFavs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const f of list.slice(0, 200)) {
    if (!f || typeof f !== 'object') continue;
    const id = String(f.id || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = String(f.name || '').replace(/[\u0000-\u001f<>"']/g, '').slice(0, 50);
    out.push({ id, name: name || id });
  }
  return out;
}

// ---------- Rexxar API constants ----------

const REXXAR_API = 'https://m.douban.com/rexxar/api';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

// ---------- Fetch helpers ----------

// Normalize protocol-relative URLs (//host/path -> https://host/path) so
// new URL() works in fetchJSON/fetchImageProxy; keep absolute URLs as-is.
function absoluteUrl(u) {
  if (typeof u !== 'string') return u;
  u = u.trim();
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}

function fetchJSON(urlStr, opts = {}) {
  urlStr = absoluteUrl(urlStr);
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, {
      rejectUnauthorized: false,
      headers: Object.assign({
        'User-Agent': MOBILE_UA,
        'Accept': 'application/json',
        'Referer': 'https://m.douban.com/',
      }, opts.headers || {}),
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchJSON(res.headers.location, opts));
        } else {
          try {
            const json = JSON.parse(data);
            resolve({ ok: true, data: json, status: res.statusCode });
          } catch (e) {
            resolve({ ok: false, error: 'parse error', status: res.statusCode, raw: data.substring(0, 200) });
          }
        }
      });
    });
    req.on('error', e => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchHTML(urlStr) {
  urlStr = absoluteUrl(urlStr);
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const client = u.protocol === 'https:' ? https : http;
    client.get(urlStr, {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ---------- Image fetch with redirect support ----------

// Restrict image proxying to douban-hosted https URLs (blocks arbitrary
// internal/private-network targets via SSRF). Redirects are re-validated
// at every hop because fetchImageProxy re-enters through safeImageUrl().
function safeImageUrl(url) {
  let u;
  try { u = new URL(absoluteUrl(url)); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  const h = (u.hostname || '').toLowerCase();
  const allowed = h === 'douban.com' || h === 'doubanio.com' ||
    h.endsWith('.douban.com') || h.endsWith('.doubanio.com');
  if (!allowed) return null;
  return u;
}

function fetchImageProxy(url, res, redirects) {
  redirects = redirects || 5;
  if (redirects <= 0) { res.writeHead(502); res.end('too many redirects'); return; }
  const u = safeImageUrl(url);
  if (!u) { res.writeHead(400); res.end('invalid url'); return; }
  https.get(u.href, {
    rejectUnauthorized: false,
    headers: {
      'User-Agent': MOBILE_UA,
      'Referer': 'https://www.douban.com/',
    }
  }, (imgRes) => {
    if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
      fetchImageProxy(imgRes.headers.location, res, redirects - 1);
      return;
    }
    const contentType = imgRes.headers['content-type'] || 'image/jpeg';
    res.writeHead(imgRes.statusCode, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    });
    imgRes.pipe(res);
  }).on('error', (e) => {
    res.writeHead(500);
    res.end('proxy error');
  });
}

// ---------- HTML parsing (for explore page) ----------

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseHotGroups(html) {
  const results = [];
  const groupRegex = /<a[^>]*href="https:\/\/www\.douban\.com\/group\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  let match;
  while ((match = groupRegex.exec(html)) !== null) {
    const id = match[1];
    const name = stripTags(match[2]).trim();
    if (id && name && !seen.has(id) && !name.includes('更多') && name.length < 30) {
      seen.add(id);
      results.push({ id, name });
      if (results.length >= 20) break;
    }
  }
  return results;
}

// ---------- Build topic list from API response ----------

// Extract image URLs embedded in a comment's text/HTML, plus any dedicated
// image fields (c.image / c.images / c.photos / c.attachment).
// Prefers data-original-url (raw original) so animated images stay animated.
function extractCommentImages(c) {
  const out = [];
  const push = (u) => {
    if (typeof u === 'string' && u && !/^data:/i.test(u) && out.indexOf(u) === -1) out.push(u);
  };
  const pick = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) { for (const i of v) push(pick(i)); return ''; }
    if (typeof v === 'object') {
      for (const k of ['image', 'raw', 'original', 'src', 'url', 'large', 'normal', 'thumb']) {
        if (v[k]) { const r = pick(v[k]); if (r) return r; }
      }
    }
    return '';
  };
  const text = c.text || '';
  const tagRe = /<img[^>]*>/gi;
  let tag;
  while ((tag = tagRe.exec(text)) !== null) {
    const rawMatch = tag[0].match(/data-original-url\s*=\s*["']([^"']+)["']/i);
    const srcMatch = tag[0].match(/(?:src|data-src)\s*=\s*["']([^"']+)["']/i);
    push((rawMatch && rawMatch[1]) || (srcMatch && srcMatch[1]) || '');
  }
  for (const key of ['image', 'images', 'photos', 'attachment']) {
    const v = c[key];
    if (Array.isArray(v)) for (const i of v) push(pick(i));
    else push(pick(v));
  }
  return out;
}

function buildTopics(json) {
  const topics = [];
  for (const t of (json.topics || [])) {
    topics.push({
      id: String(t.id),
      title: t.title || '',
      author: t.author?.name || '匿名',
      replies: String(t.comments_count || t.reply_count || '0'),
      lastReply: t.update_time || t.create_time || '',
      createTime: t.create_time || '',
      url: t.url || '',
    });
  }
  return topics;
}

// ---------- MIME types ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// Send a JSON response, transparently gzip-compressing larger bodies when the
// client supports it (the group list can be tens of KB).
function sendJSON(req, res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const enc = (req.headers['accept-encoding'] || '').toLowerCase();
  const buf = Buffer.from(body);
  if (buf.length > 1024 && enc.includes('gzip')) {
    const z = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = z.length;
    res.writeHead(status, headers);
    res.end(z);
  } else {
    headers['Content-Length'] = buf.length;
    res.writeHead(status, headers);
    res.end(buf);
  }
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = u.pathname;
  const params = u.searchParams;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ---------- API: list group discussions ----------
    if (pathname === '/api/group' && params.has('id')) {
      const groupId = params.get('id').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(groupId)) {
        sendJSON(req, res, 400, { ok: false, error: '无效的小组 ID' });
        return;
      }

      const cached = groupCache.get(groupId);
      if (cached && (Date.now() - cached.time < CACHE_TTL)) {
        sendJSON(req, res, 200, cached.payload);
        return;
      }

      const infoRes = await fetchJSON(`${REXXAR_API}/v2/group/${groupId}`);

      let discussions = [];
      const PAGE_SIZE = 100;
      const MAX_TOPICS = 300;
      let offset = 0;
      while (offset < MAX_TOPICS) {
        const topicsRes = await fetchJSON(`${REXXAR_API}/v2/group/${groupId}/topics?start=${offset}&count=${PAGE_SIZE}`);
        if (!topicsRes.ok) break;
        const topics = buildTopics(topicsRes.data);
        if (topics.length === 0) break;
        discussions = discussions.concat(topics);
        if (topics.length < PAGE_SIZE) break;
        offset += topics.length;
      }

      const groupName = infoRes.ok ? (infoRes.data.name || infoRes.data.title || `小组 ${groupId}`) : `小组 ${groupId}`;

      const payload = { ok: true, groupId, data: { groupName, discussions, total: discussions.length } };
      groupCache.set(groupId, { time: Date.now(), payload });
      sendJSON(req, res, 200, payload);
      return;
    }

    // ---------- API: get topic detail ----------
    if (pathname === '/api/post' && params.has('id')) {
      const topicId = params.get('id').trim();
      if (!/^[A-Za-z0-9_-]+$/.test(topicId)) {
        sendJSON(req, res, 400, { ok: false, error: '无效的帖子 ID' });
        return;
      }

      const topicRes = await fetchJSON(`${REXXAR_API}/v2/group/topic/${topicId}`);

      if (!topicRes.ok || topicRes.status >= 400) {
        const msg = topicRes.data && (topicRes.data.msg === 'need_permission' || topicRes.data.code === 1000)
          ? '豆瓣风控拦截：请稍后再试'
          : '无法获取帖子详情';
        sendJSON(req, res, 500, { ok: false, error: msg });
        return;
      }

      const t = topicRes.data;

      // Extract images from post content.
      // The <img src> points to a static JPEG (gifs are flattened), but
      // data-original-url carries the raw original which for animated
      // images is a real GIF served as image/jpeg — browsers sniff the
      // bytes and play it. Prefer the raw URL so animated images animate.
      let images = [];
      if (t.content) {
        const tagRe = /<img[^>]*>/gi;
        let tag;
        while ((tag = tagRe.exec(t.content)) !== null) {
          const rawMatch = tag[0].match(/data-original-url\s*=\s*["']([^"']+)["']/i);
          const srcMatch = tag[0].match(/(?:src|data-src)\s*=\s*["']([^"']+)["']/i);
          const url = (rawMatch && rawMatch[1]) || (srcMatch && srcMatch[1]) || '';
          if (url && !/^data:/i.test(url) && !images.includes(url)) images.push(url);
        }
      }
     // Also check for attached_photos / photos array from API
     if (t.attached_photos && Array.isArray(t.attached_photos)) {
       t.attached_photos.forEach(p => {
         const src = p.src || p.url || p.image?.raw?.url || p.image?.large?.url ||
           p.image?.normal?.url || p.image?.src || p.image?.url || p.large?.url;
         if (src && !images.includes(src)) images.push(src);
       });
     }
     if (t.photos && Array.isArray(t.photos)) {
       t.photos.forEach(p => {
         const src = p.src || p.url || p.image?.raw?.url || p.image?.large?.url ||
           p.image?.normal?.url || p.image?.src || p.image?.url || p.large?.url;
         if (src && !images.includes(src)) images.push(src);
       });
     }

     // Extract content - strip HTML tags
     let content = '';
      if (t.content) {
        content = t.content
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<p[^>]*>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<div[^>]*>/gi, '\n')
          .replace(/<\/div>/gi, '')
          .replace(/<blockquote[^>]*>/gi, '\n> ')
          .replace(/<\/blockquote>/gi, '\n')
          .replace(/<[^>]*>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
          .replace(/\n{4,}/g, '\n\n')
          .replace(/^\s+/gm, '')
          .trim();
      }

      // Fetch comments from the dedicated API. Pages are requested in parallel
      // (instead of sequentially) so popular posts with many comments load much
      // faster. Results stay in original page order.
      let comments = [];
      const totalComments = t.comments_count || 0;
      let commentsLocked = false;
      const PAGE = 100;
      const MAX_COMMENTS = 1000;
      const target = Math.min(totalComments, MAX_COMMENTS);
      if (target > 0) {
        const starts = [];
        for (let s = 0; s < target; s += PAGE) starts.push(s);
        const pages = await Promise.all(starts.map(s =>
          fetchJSON(`${REXXAR_API}/v2/group/topic/${topicId}/comments?start=${s}&count=${PAGE}`).catch(() => null)
        ));
        for (const commentsRes of pages) {
          if (!commentsRes || !commentsRes.ok) continue;
          const cd = commentsRes.data;
          if (commentsRes.status >= 400) {
            if (cd && (cd.msg === 'need_permission' || cd.code === 1000)) commentsLocked = true;
            continue;
          }
          if (Array.isArray(cd.comments)) {
            comments = comments.concat(cd.comments.map(c => ({
              author: c.author?.name || '匿名',
              content: (c.text || '').replace(/<[^>]*>/g, '').trim(),
              images: extractCommentImages(c),
              time: c.create_time || '',
            })));
          }
        }
      }

      sendJSON(req, res, 200, {
        ok: true,
        data: {
          title: t.title || '无标题',
          author: t.author?.name || '匿名',
          content,
          images,
          comments,
          commentsCount: totalComments,
          commentsLocked,
          createTime: t.create_time || '',
        }
      });
      return;
    }

    // ---------- API: proxy image (bypass hotlink protection) ----------
    if (pathname === '/api/image' && params.has('url')) {
      fetchImageProxy(params.get('url'), res);
      return;
    }

    // ---------- API: search groups ----------
    if (pathname === '/api/search') {
      const q = params.get('q') || '';
      const searchUrl = `https://www.douban.com/search?q=${encodeURIComponent(q)}&cat=1019`;

      const html = await fetchHTML(searchUrl);

      const results = [];

      // Parse search results page
      // Split by result div boundaries
      const sections = html.split('<div class="result">');
      for (let i = 1; i < sections.length && results.length < 20; i++) {
        const block = sections[i];

        // Extract group ID - try several patterns:
        // 1. Direct URL: /group/586674/
        // 2. Encoded URL: %2Fgroup%2F586674%2F (in link2 redirects)
        // 3. sid parameter in onclick: sid: 586674
        let id = '';
        const directMatch = block.match(/\/group\/(\d+)\//);
        if (directMatch) {
          id = directMatch[1];
        } else {
          const encodedMatch = block.match(/group%2F(\d+)%2F/);
          if (encodedMatch) {
            id = encodedMatch[1];
          } else {
            const sidMatch = block.match(/sid:\s*(\d+)/);
            if (sidMatch) id = sidMatch[1];
          }
        }
        if (!id) continue;

        // Extract group name from title attribute
        const titleMatch = block.match(/title="([^"]*)"/);
        let name = '';
        if (titleMatch) {
          name = titleMatch[1].trim();
        } else {
          // Fallback: extract from link text inside H3
          const h3Link = block.match(/<h3[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
          if (h3Link) name = stripTags(h3Link[1]).trim();
        }
        name = name.replace(/^\[小组\]\s*/, '').trim();
        if (name && !results.find(r => r.id === id)) {
          results.push({ id, name });
        }
      }

      sendJSON(req, res, 200, { ok: true, q, results });
      return;
    }

    // ---------- API: hot groups ----------
    if (pathname === '/api/hot') {
      const html = await fetchHTML('https://www.douban.com/group/explore');
      const results = parseHotGroups(html);

      sendJSON(req, res, 200, { ok: true, results });
      return;
    }

    // ---------- API: favorites (shared across browsers) ----------
    if (pathname === '/api/favs') {
      if (req.method === 'GET') {
        sendJSON(req, res, 200, { ok: true, favs: sanitizeFavs(readFavs()) });
        return;
      }
      if (req.method === 'POST') {
        // Same-origin check: reject cross-site writes (CSRF). Browsers send
        // an Origin header on cross-site POSTs; curl/local tools send none.
        const origin = req.headers.origin;
        if (origin) {
          let same = false;
          try { same = new URL(origin).host === (req.headers.host || ''); } catch (e) {}
          if (!same) {
            sendJSON(req, res, 403, { ok: false, error: 'cross-origin write rejected' });
            return;
          }
        }
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 65536) req.destroy();
        });
        req.on('end', () => {
          try {
            const j = JSON.parse(body || '{}');
            const favs = sanitizeFavs(j.favs);
            // Atomic write: write to a temp file then rename, so a concurrent
            // request or crash can never leave a half-written favs.json.
            const tmp = FAVS_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ favs }, null, 2));
            fs.renameSync(tmp, FAVS_FILE);
            sendJSON(req, res, 200, { ok: true, count: favs.length });
          } catch (e) {
            sendJSON(req, res, 400, { ok: false, error: '无效的收藏数据' });
          }
        });
        return;
      }
      sendJSON(req, res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);

    if (!(filePath === __dirname || filePath.startsWith(__dirname + path.sep))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      let content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
      };
      // Compress text assets (index.html is the bulk of the payload).
      const enc = (req.headers['accept-encoding'] || '').toLowerCase();
      if (content.length > 1024 && /\btext\/|application\/(json|javascript)/.test(type) && enc.includes('gzip')) {
        content = zlib.gzipSync(content);
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = content.length;
      } else {
        headers['Content-Length'] = content.length;
      }
      res.writeHead(200, headers);
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  } catch (err) {
    console.error('Server error:', err);
    sendJSON(req, res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`豆瓣小组浏览器运行在 http://${HOST}:${PORT}/`);
});
