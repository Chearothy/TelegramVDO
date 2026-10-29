'use strict';
/*
 * Telegram client (MTProto) provider. Lists every video of the channel and streams any size
 * (Telegram's limit: 2 GB, 4 GB for Premium uploads) with HTTP Range support.
 * Needs: api_id + api_hash from https://my.telegram.org and a saved login (npm run login).
 */
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const REQUEST = 512 * 1024; // download chunk, must divide 1 MB and be a multiple of 4096

module.exports = function createMtproto(opts) {
  let client = null, entity = null, connecting = null;
  const msgs = new Map();      // id -> gramjs message (holds the file reference)
  const thumbs = new Map();    // id -> Buffer

  async function connect() {
    if (client) return;
    if (!connecting) {
      connecting = (async function () {
        const c = new TelegramClient(new StringSession(opts.session), Number(opts.apiId), opts.apiHash, { connectionRetries: 5 });
        await c.connect();
        entity = await c.getEntity(opts.channel);
        client = c;
      })();
    }
    await connecting;
  }

  function fmt(sec) {
    sec = Math.round(Number(sec) || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function describe(m) {
    const doc = m && m.document;
    if (!doc || !doc.attributes) return null;
    const va = doc.attributes.find(function (a) { return a instanceof Api.DocumentAttributeVideo; });
    if (!va) return null;
    const text = String(m.message || '').trim();
    const title = (text.split('\n').find(function (l) { return l.trim(); }) || '').trim().slice(0, 90);
    return {
      id: m.id,
      date: m.date ? new Date(m.date * 1000).toISOString() : null,
      title: title,
      text: text.slice(0, 500),
      size: Number(doc.size.toString()),
      mime: doc.mimeType || 'video/mp4',
      duration: fmt(va.duration),
      round: !!va.roundMessage,
      hasThumb: !!(doc.thumbs && doc.thumbs.length)
    };
  }

  async function list(full) {
    await connect();
    const out = [];
    const it = client.iterMessages(entity, { filter: new Api.InputMessagesFilterVideo(), limit: full ? 100000 : 60 });
    for await (const m of it) {
      const d = describe(m);
      if (d) { msgs.set(m.id, m); out.push(d); }
    }
    return out;
  }

  async function getMsg(id, fresh) {
    await connect();
    let m = fresh ? null : msgs.get(id);
    if (!m) {
      const r = await client.getMessages(entity, { ids: [id] });
      m = r && r[0];
      if (m) msgs.set(id, m);
    }
    return m || null;
  }

  async function info(id) { return describe(await getMsg(id)); }

  async function* download(id, start, end) {
    let attempt = 0;
    let pos = start - (start % REQUEST);           // Telegram wants aligned offsets
    for (;;) {
      const m = await getMsg(id, attempt > 0);
      if (!m || !m.document || !m.media) throw new Error('video not found');
      const size = Number(m.document.size.toString());
      const chunks = Math.ceil((end - pos + 1) / REQUEST);
      try {
        for await (const chunk of client.iterDownload({
          file: m.media, offset: bigInt(pos), requestSize: REQUEST, limit: chunks, fileSize: bigInt(size)
        })) {
          const buf = Buffer.from(chunk);
          const from = Math.max(0, start - pos);
          const to = Math.min(buf.length, end + 1 - pos);
          pos += buf.length;
          if (to > from) yield buf.subarray(from, to);
          if (pos > end) return;
        }
        return;
      } catch (e) {
        // File references expire after a while: fetch the message again and resume once.
        if (attempt === 0 && /FILE_REFERENCE/i.test(String(e && e.message))) { attempt++; start = Math.max(start, pos); continue; }
        throw e;
      }
    }
  }

  async function thumb(id) {
    if (thumbs.has(id)) return thumbs.get(id);
    const m = await getMsg(id);
    const all = m && m.document && m.document.thumbs;
    const t = (all || []).filter(function (x) { return !(Api.PhotoPathSize && x instanceof Api.PhotoPathSize); });
    if (!t.length) return null;                       // no usable thumbnail: do NOT ask for the media itself
    const buf = await client.downloadMedia(m, { thumb: Math.min(1, t.length - 1) }); // explicit index: never the whole video
    if (!Buffer.isBuffer(buf) || buf.length > 300 * 1024) return null;
    if (thumbs.size > 500) thumbs.delete(thumbs.keys().next().value);
    thumbs.set(id, buf);
    return buf;
  }

  return { list: list, info: info, download: download, thumb: thumb };
};
