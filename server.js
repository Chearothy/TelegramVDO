'use strict';
/*
 * Tele..VDO server (no dependencies, Node 18+)
 *  Mode A (default, no login): reads the public preview t.me/s/<channel>; direct links for small videos only.
 *  Mode B (TG_API_ID + TG_API_HASH + TG_SESSION set): logs in as a Telegram user, lists EVERY video and
 *         streams any size (up to 2 GB) through /stream/<id> with Range support.
 *  GET /api/videos -> JSON list (newest first), refreshed automatically.  GET / -> index.html
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const envInfo = require('./loadenv');

const CHANNEL = String(process.env.TELEGRAM_CHANNEL_USERNAME || 'rothy_video_library').replace(/[^A-Za-z0-9_]/g, '');
const WEB_BASE = (process.env.TELEGRAM_WEB_BASE || 'https://t.me').replace(/\/+$/, '');
const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_PAGES = Number(process.env.MAX_PAGES) || 200;          // ~20 posts per page
const REFRESH_MS = (Number(process.env.REFRESH_MINUTES) || 3) * 60000;
const FULL_SCAN_MS = (Number(process.env.FULL_SCAN_HOURS) || 6) * 3600000;
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS) || 400;

const USE_MT = !!(process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION);
let mt = null;
if (USE_MT) {
  try {
    mt = require('./mtproto')({ apiId: process.env.TG_API_ID, apiHash: process.env.TG_API_HASH, session: process.env.TG_SESSION, channel: CHANNEL });
  } catch (e) {
    console.error('[tele-vdo] Telegram login mode needs "npm install" first:', e.message);
    process.exit(1);
  }
}

const state = { videos: new Map(), loading: true, updated: null, error: null, lastFull: 0, busy: false };

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function decode(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); }).replace(/&amp;/g, '&');
}

async function fetchPage(before) {
  const url = WEB_BASE + '/s/' + CHANNEL + (before ? '?before=' + before : '');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TeleVDO/1.0)', 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error('Telegram answered HTTP ' + res.status);
  return res.text();
}

function parsePage(html) {
  const marks = [];
  const re = /data-post="[^"\/]+\/(\d+)"/g;
  let m;
  while ((m = re.exec(html))) marks.push({ id: Number(m[1]), idx: m.index });
  const videos = [];
  let minId = Infinity;
  for (let i = 0; i < marks.length; i++) {
    const id = marks[i].id;
    if (id < minId) minId = id;
    const chunk = html.slice(marks[i].idx, i + 1 < marks.length ? marks[i + 1].idx : html.length);
    if (!/tgme_widget_message_(?:round)?video_player/.test(chunk)) continue; // not a video post
    const src = (chunk.match(/<video\b[^>]*?\ssrc="([^"]+)"/) || [])[1];
    const thumb = (chunk.match(/tgme_widget_message_(?:round)?video_thumb"[^>]*?background-image:url\('([^']+)'\)/) || [])[1];
    const duration = (chunk.match(/message_video_duration[^>]*>([^<]+)</) || [])[1];
    const date = (chunk.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
    const rawText = (chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    const text = decode(rawText.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    const title = (text.split('\n').find(function (l) { return l.trim(); }) || '').trim().slice(0, 90);
    videos.push({
      id: id,
      date: date || null,
      title: title,
      text: text.slice(0, 500),
      thumb: thumb ? decode(thumb) : null,
      src: src ? decode(src) : null,   // null = video too large for Telegram's preview
      duration: duration ? duration.trim() : null,
      round: /roundvideo_player/.test(chunk)
    });
  }
  return { count: marks.length, minId: minId, videos: videos };
}

async function crawlMT(full) {
  const list = await mt.list(full);
  list.forEach(function (v) {
    v.stream = '/stream/' + v.id;
    v.thumb = v.hasThumb ? '/thumb/' + v.id : null;
    v.src = null;
    delete v.hasThumb;
    state.videos.set(v.id, v);
  });
  state.updated = new Date().toISOString();
}

async function crawl(full) {
  if (state.busy) return;
  state.busy = true;
  try {
    if (USE_MT) {
      await crawlMT(full);
      if (full) state.lastFull = Date.now();
      state.error = null;
      console.log('[tele-vdo] ' + (full ? 'full scan' : 'refresh') + ' done, ' + state.videos.size + ' videos');
      return;
    }
    let before = 0, pages = 0;
    while (pages < MAX_PAGES) {
      const page = parsePage(await fetchPage(before));
      if (!page.count) {
        if (pages === 0) throw new Error('No posts found. Is @' + CHANNEL + ' a public channel with preview enabled?');
        break;
      }
      page.videos.forEach(function (v) { state.videos.set(v.id, v); });
      state.updated = new Date().toISOString();
      if (!full || page.minId <= 1) break;
      before = page.minId;
      pages++;
      await sleep(PAGE_DELAY_MS);
    }
    if (full) state.lastFull = Date.now();
    state.error = null;
    console.log('[tele-vdo] ' + (full ? 'full scan' : 'refresh') + ' done, ' + state.videos.size + ' videos');
  } catch (e) {
    state.error = e.message;
    console.error('[tele-vdo] crawl failed:', e.message);
  } finally {
    state.loading = false;
    state.busy = false;
  }
}

async function handleStream(req, res, id) {
  const tag = '[tele-vdo] stream ' + id + ' range=' + (req.headers.range || '-');
  let sent = 0, expected = 0, started = Date.now();
  try {
    const info = await mt.info(id);
    if (!info) { console.error(tag + ' -> 404 (message not found or not a video)'); res.writeHead(404); return res.end(); }
    const size = info.size;
    let start = 0, end = size - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      status = 206;
    }
    expected = end - start + 1;
    const headers = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', 'Content-Length': expected, 'Cache-Control': 'public, max-age=3600' };
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    let closed = false;
    res.on('close', function () { closed = true; });
    for await (const buf of mt.download(id, start, end)) {
      if (closed) break;
      sent += buf.length;
      if (!res.write(buf)) await new Promise(function (r) { res.once('drain', r); res.once('close', r); });
    }
    if (!closed && sent !== expected) {
      // Telegram gave less than promised: cut the connection so the browser retries instead of waiting forever.
      console.error(tag + ' -> short read: sent ' + sent + ' of ' + expected + ' bytes (' + info.mime + ')');
      return res.destroy();
    }
    console.log(tag + ' -> ' + status + (closed ? ' (browser closed it)' : ' done') + ', ' + sent + ' bytes, ' + (Date.now() - started) + ' ms, ' + info.mime);
    res.end();
  } catch (e) {
    console.error(tag + ' FAILED after ' + sent + '/' + expected + ' bytes: ' + (e && (e.errorMessage || e.message) || e));
    if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
  }
}

// Open http://localhost:PORT/diag/<video id> to see exactly why a video does not stream.
async function handleDiag(res, id) {
  const out = { id: id, steps: [] };
  const t0 = Date.now();
  try {
    const info = await mt.info(id);
    out.steps.push('message lookup ok in ' + (Date.now() - t0) + ' ms');
    out.info = info;
    if (!info) throw new Error('message not found or it is not a video');
    let got = 0; const t1 = Date.now();
    for await (const buf of mt.download(id, 0, Math.min(info.size, 1024 * 1024) - 1)) got += buf.length;
    out.steps.push('downloaded first ' + got + ' bytes from Telegram in ' + (Date.now() - t1) + ' ms');
    out.browserCanPlayMime = /^video\/(mp4|webm|ogg)$/.test(info.mime) ? 'probably' : 'NO - browsers usually cannot play ' + info.mime;
    out.ok = got > 0;
  } catch (e) {
    out.ok = false; out.error = String(e && (e.errorMessage || e.message) || e);
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(out, null, 2));
}

async function handleThumb(res, id) {
  try {
    const buf = await mt.thumb(id);
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Content-Length': buf.length });
    res.end(buf);
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
}

function tick() { crawl(Date.now() - state.lastFull > FULL_SCAN_MS); }

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/api/videos') {
    const list = Array.from(state.videos.values()).sort(function (a, b) { return b.id - a.id; });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' });
    return res.end(JSON.stringify({ channel: CHANNEL, mode: USE_MT ? 'telegram-login' : 'public-preview', updated: state.updated, loading: state.loading || state.busy && !state.lastFull, error: state.error, count: list.length, videos: list }));
  }
  const dm = /^\/diag\/(\d+)$/.exec(url.pathname);
  if (dm && mt) return handleDiag(res, Number(dm[1]));
  const sm = /^\/(stream|thumb)\/(\d+)$/.exec(url.pathname);
  if (sm && mt) return sm[1] === 'stream' ? handleStream(req, res, Number(sm[2])) : handleThumb(res, Number(sm[2]));
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return fs.readFile(path.join(__dirname, 'index.html'), function (err, data) {
      if (err) { res.writeHead(404); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, function () {
  console.log('[tele-vdo] http://localhost:' + PORT + '  channel: @' + CHANNEL + '  mode: ' + (USE_MT ? 'Telegram login (all sizes)' : 'public preview (small videos)'));
  if (envInfo.file) console.log('[tele-vdo] settings file: ' + envInfo.file);
  else console.log('[tele-vdo] WARNING: no .env file in ' + __dirname + ' (copy .env.example to .env and fill it in)');
  envInfo.notes.forEach(function (n) { console.log('[tele-vdo] NOTE: ' + n); });
  if (!USE_MT) {
    const missing = ['TG_API_ID', 'TG_API_HASH', 'TG_SESSION'].filter(function (k) { return !process.env[k]; });
    console.log('[tele-vdo] Telegram login is OFF (big videos will not play). Missing or empty: ' + missing.join(', '));
  }
  crawl(true).then(function () { setInterval(tick, REFRESH_MS); });
});
