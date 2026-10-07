// GM Office relay (Cloudflare Worker + one Durable Object).
// Every open gm-office.html page holds a WebSocket to the one "office" room:
//   /ws            a viewer (the office TV, or anyone's page): only listens
//   /ws?uid=1234   someone driving their own character (gm-user.html): sends hello / step / hb / look, which go to
//                  everyone else. Looks are also saved here, so every page that connects later gets them.
// When a driver's socket closes, everyone hears { t: 'bye', uid } and that character goes back to its routine.
//   POST /count    a laptop in the office posts its headcount estimate ({ n }, Bearer COUNT_TOKEN, a Worker secret).
//                  Before 2 pm the room keeps the day's highest number (n); from 2 pm on, the lowest afternoon number
//                  (pm.n) and the Eastern hour of the latest afternoon post (pm.h, about when that laptop left).
//                  Everyone gets { t: 'count', day, n, pm }; pages use it as today's headcount (and wind the afternoon
//                  down from pm to 6 pm), and fall back to the weekday guess when there's none for today.
// One session per user id: a page connecting with ?uid= while another page (a different ?sid=) already drives that id
// becomes a clone, '<uid>c1', '<uid>c2'..., told so with { t: 'you', uid, clone: true }; clones walk in from the
// entrance, don't save looks, and their trivia scores count for the real id. The same sid reconnecting (a dropped
// phone) takes over its old socket instead. For a real session we ask the leading screen where that character is
// ({ t: 'whereq', uid } -> { t: 'where', uid, x, y, dir, sit, present }) so the page starts there instead of walking in.
// Secret plant trivia (gm-user.html, in the washroom): a driver posts { t: 'score', n } after a 30 s round. We keep
// today's best (Eastern date) and send { t: 'trivia', day, n, uid } to pages that connected with v=2 (older pages
// would misread it), and include it in their 'state'.
// Hibernation API: idle sockets cost nothing, and 'ping' -> 'pong' is answered without waking the object.
// One office on every screen: the first viewer is the leader ({ t: 'role', lead: true }) and runs the office.
// It sends { t: 'snap' } (who's where) while other viewers are watching ({ t: 'peers', n }); we pass it on and keep
// the latest for screens that join. A viewer that hears nothing for a few seconds sends 'claim' and takes over if
// we haven't heard from the leader either. A click on a follower is sent to the leader as 'poke'.
import { DurableObject } from 'cloudflare:workers';

const ORIGINS = [/^https:\/\/timberjones\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^null$/];   // null = a local file
const DIRS = ['up', 'down', 'left', 'right'];
const GX = 48, GY = 28;                   // office grid (gm-office.html)
const MAX_PER_SEC = 40, MAX_LEN = 400;
const VIEW_PER_SEC = 12, SNAP_LEN = 24000, QUIET_MS = 3000;
const DAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function eastern() {   // { day, h }: the same day key as zoneDay() in gm-office.html (e.g. 2026-10-5), and the hour as 15.5
  const o = {}; for (const p of DAY_FMT.formatToParts(new Date())) o[p.type] = p.value;
  return { day: `${o.year}-${o.month}-${o.day}`, h: +o.hour + o.minute / 60 };
}
const PM_FROM = 14;   // posts from 2 pm on are afternoon counts
const HEX = /^#[0-9a-f]{6}$/i, STYLES = ['short', 'spiky', 'long', 'bun'];
const DOG_ID = '101';   // easter egg: this id is a dog (gm-office.html DOG_ID)
function cleanLook(l, uid) {   // only the fields gm-office.html draws, checked; null if it isn't a look
  if (!l || typeof l !== 'object') return null;
  if ((uid === DOG_ID) !== !!l.dog) return null;   // 101 is always a dog, nobody else is
  if (l.dog) return HEX.test(l.coat) ? { dog: true, coat: l.coat.toLowerCase(), collar: HEX.test(l.collar) ? l.collar.toLowerCase() : null } : null;
  if (!HEX.test(l.hair) || !HEX.test(l.shirt) || !HEX.test(l.pants)) return null;
  return {
    hair: l.hair.toLowerCase(), shirt: l.shirt.toLowerCase(), pants: l.pants.toLowerCase(),
    skin: Math.max(0, Math.min(4, l.skin | 0)), style: STYLES.includes(l.style) ? l.style : 'short',
    sex: l.sex === 'f' ? 'f' : 'm', beard: !!l.beard, goatee: !!l.goatee && !l.beard,
    hat: HEX.test(l.hat) ? l.hat.toLowerCase() : null, build: ['tall', 'small'].includes(l.build) ? l.build : null,
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/count') {
      if (req.method !== 'POST') return new Response('POST only', { status: 405 });
      if (!env.COUNT_TOKEN || req.headers.get('Authorization') !== 'Bearer ' + env.COUNT_TOKEN) return new Response('forbidden', { status: 403 });
      return env.OFFICE.get(env.OFFICE.idFromName('office')).fetch(req);
    }
    if (url.pathname !== '/ws') return new Response('gm-office relay\n', { headers: { 'content-type': 'text/plain' } });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const origin = req.headers.get('Origin') || '';
    if (!ORIGINS.some(r => r.test(origin))) return new Response('forbidden', { status: 403 });
    const uid = url.searchParams.get('uid');
    if (uid != null && !/^\d{1,8}$/.test(uid)) return new Response('bad uid', { status: 400 });
    return env.OFFICE.get(env.OFFICE.idFromName('office')).fetch(req);
  },
};

export class Office extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    if (new URL(req.url).pathname === '/count') return this.postCount_(req);
    const q = new URL(req.url).searchParams, base = q.get('uid'), sync = !base && q.get('sync') === '1';   // older pages don't sync
    const sid = (q.get('sid') || '').slice(0, 40), open = w => w.readyState === 1;
    let uid = base, clone = false;
    if (base) {
      for (const w of this.ctx.getWebSockets('u' + base)) {   // the same tab reconnecting: replace its old socket
        const a = w.deserializeAttachment();
        if (sid && a && a.sid === sid) { a.replaced = true; w.serializeAttachment(a); try { w.close(1000, 'replaced'); } catch (e) {} }
      }
      if (this.ctx.getWebSockets('u' + base).some(w => open(w) && !(w.deserializeAttachment() || {}).replaced)) {   // someone else has this id
        clone = true;
        for (let k = 1; k < 50; k++) { const c = base + 'c' + k; if (!this.ctx.getWebSockets('u' + c).some(open)) { uid = c; break; } }
      }
    }
    const [client, server] = Object.values(new WebSocketPair());
    const tags = uid ? ['ctl', 'u' + uid] : sync ? ['view', 'sync'] : ['view'];
    const v2 = (+q.get('v') || 1) >= 2;   // understands newer messages (trivia)
    if (v2) tags.push('v2');
    this.ctx.acceptWebSocket(server, tags);
    let lead = false;
    if (sync) {   // a screen: it leads if nobody does, otherwise the leader starts sending for it
      lead = !this.leader_();
      this.joinAt = Date.now();
    }
    server.serializeAttachment({ uid: uid || null, base: base || null, clone, sid, last: null, n: 0, t0: 0, lead });
    if (uid && v2) {
      server.send(JSON.stringify({ t: 'you', uid, clone }));
      const L = this.leader_();   // where is this character right now? the leading screen answers, we pass it on
      if (!clone && L && (L.deserializeAttachment() || {}).v2 !== false) try { L.send(JSON.stringify({ t: 'whereq', uid })); } catch (e) {}
    }
    const looks = {};
    for (const [k, v] of await this.ctx.storage.list({ prefix: 'look:' })) looks[k.slice(5)] = v;
    if (sync) server.send(JSON.stringify({ t: 'role', lead, peers: this.views_().length - 1 }));
    const snap = this.snap && Date.now() - this.snapAt < 5000 ? JSON.parse(this.snap) : null;
    const state = { t: 'state', online: this.online_(server), looks, count: await this.count_(), snap };
    if (v2) state.trivia = await this.trivia_();
    server.send(JSON.stringify(state));   // who's driving right now and where, and everyone's look
    if (sync && !lead) this.tellPeers_();
    return new Response(null, { status: 101, webSocket: client });
  }

  async trivia_() {   // today's best trivia score, or null
    const t = await this.ctx.storage.get('trivia');
    return t && t.day === eastern().day ? t : null;
  }

  async postScore_(ws, a, n) {
    const now = Date.now();
    if (!Number.isInteger(n) || n < 0 || n > 60 || now - (a.scoreAt || 0) < 20000) return;   // one round = 30 s
    a.scoreAt = now; ws.serializeAttachment(a);
    const old = await this.trivia_();
    if (old && old.n >= n) return;
    const t = { day: eastern().day, n, uid: a.base || a.uid, at: now };   // a clone's score counts for the real id
    await this.ctx.storage.put('trivia', t);
    const s = JSON.stringify({ t: 'trivia', ...t });
    for (const w of this.ctx.getWebSockets('v2')) try { w.send(s); } catch (e) {}
  }

  async count_() {   // today's headcount, or null
    const c = await this.ctx.storage.get('count');
    return c && c.day === eastern().day ? c : null;
  }

  async postCount_(req) {
    let m;
    try { m = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
    const n = Number(m && m.n);
    if (!Number.isInteger(n) || n < 0 || n > 200) return new Response('bad n', { status: 400 });
    const old = await this.count_(), e = eastern();
    const c = { day: e.day, n: old ? old.n : null, pm: old ? old.pm : null, last: n, at: Date.now() };
    if (e.h < PM_FROM) c.n = Math.max(n, c.n || 0);                                         // morning: the day's peak
    else c.pm = { n: c.pm ? Math.min(n, c.pm.n) : n, h: Math.round(e.h * 100) / 100 };      // afternoon: the lowest, and when
    await this.ctx.storage.put('count', c);
    this.broadcast_(null, { t: 'count', ...c });
    return Response.json(c);
  }

  views_() { return this.ctx.getWebSockets('sync').filter(w => w.readyState === 1); }   // screens that take part in syncing
  leader_() { return this.views_().find(w => { const a = w.deserializeAttachment(); return a && a.lead; }) || null; }
  tellPeers_() {   // the leader sends snapshots only while someone else is watching
    const L = this.leader_();
    if (L) try { L.send(JSON.stringify({ t: 'peers', n: this.views_().length - 1 })); } catch (e) {}
  }
  makeLeader_(ws) {
    for (const w of this.views_()) {
      const a = w.deserializeAttachment();
      if (!a || a.lead === (w === ws)) continue;
      a.lead = w === ws; w.serializeAttachment(a);
      if (!a.lead) try { w.send(JSON.stringify({ t: 'role', lead: false })); } catch (e) {}
    }
    try { ws.send(JSON.stringify({ t: 'role', lead: true, peers: this.views_().length - 1 })); } catch (e) {}
  }

  viewerMessage_(ws, a, raw) {
    if (typeof raw !== 'string' || raw.length > SNAP_LEN) return;
    const now = Date.now();
    if (now - a.t0 > 1000) { a.t0 = now; a.n = 0; }
    a.n++; ws.serializeAttachment(a);
    if (a.n > VIEW_PER_SEC) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m) return;
    if (m.t === 'snap') {
      if (!a.lead) return;
      this.snap = raw; this.snapAt = now;
      for (const w of this.views_()) if (w !== ws) try { w.send(raw); } catch (e) {}
    } else if (m.t === 'claim') {
      if (a.lead) return;
      const L = this.leader_();
      if (!L || now - Math.max(this.snapAt || 0, this.joinAt || 0) > QUIET_MS) this.makeLeader_(ws);
    } else if (m.t === 'where') {   // the leader's answer to whereq: pass it to that id's page
      if (!a.lead || typeof m.uid !== 'string' || !/^\d{1,8}$/.test(m.uid)) return;
      const out = JSON.stringify({ t: 'where', x: m.x | 0, y: m.y | 0, dir: DIRS.includes(m.dir) ? m.dir : 'down', sit: !!m.sit, present: !!m.present });
      for (const w of this.ctx.getWebSockets('u' + m.uid)) try { w.send(out); } catch (e) {}
    } else if (m.t === 'poke') {
      const i = m.i | 0, L = this.leader_();   // -1 courier, -2 water delivery, -3 / -4 the dogs
      if (L && L !== ws && i >= -4 && i < 200) try { L.send(JSON.stringify({ t: 'poke', i })); } catch (e) {}
    }
  }

  online_(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets('ctl')) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a && a.uid && a.last) out.push({ uid: a.uid, ...a.last });
    }
    return out;
  }

  broadcast_(from, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) if (ws !== from) { try { ws.send(s); } catch (e) {} }
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment();
    if (a && !a.uid) return this.viewerMessage_(ws, a, raw);
    if (!a || typeof raw !== 'string' || raw.length > MAX_LEN) return;
    const now = Date.now();
    if (now - a.t0 > 1000) { a.t0 = now; a.n = 0; }
    if (++a.n > MAX_PER_SEC) { ws.serializeAttachment(a); return; }
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || !['hello', 'step', 'hb', 'look', 'bark', 'score', 'hide', 'talk'].includes(m.t)) return;   // bark: the dog's Woof button
    if (m.t === 'score') { ws.serializeAttachment(a); return this.postScore_(ws, a, m.n); }   // trivia: not passed on as-is
    if (m.t === 'talk') {   // the Talk button: the leading screen picks one of their lines and says it for everyone
      const L = this.leader_();
      if (L) try { L.send(JSON.stringify({ t: 'talk', uid: a.uid })); } catch (e) {}
      ws.serializeAttachment(a); return;
    }
    if (m.t === 'hide') {   // gone into the washroom (trivia) or back out: only pages that understand it (v2) hear it
      a.last = Object.assign({}, a.last || {}, { hidden: !!m.on }); ws.serializeAttachment(a);
      const s = JSON.stringify({ t: 'hide', uid: a.uid, on: !!m.on });
      for (const w of this.ctx.getWebSockets('v2')) if (w !== ws) try { w.send(s); } catch (e) {}
      return;
    }
    const out = { t: m.t, uid: a.uid };
    if (m.t === 'look') {
      const look = cleanLook(m.look, a.base || a.uid);
      if (!look) return;
      if (!a.clone) await this.ctx.storage.put('look:' + a.uid, look);   // a clone's look is just for now
      out.look = look;
    } else if (m.t !== 'hb' && m.t !== 'bark') {
      const x = m.x | 0, y = m.y | 0;
      if (x < 0 || y < 0 || x >= GX || y >= GY) return;
      Object.assign(out, { x, y, dir: DIRS.includes(m.dir) ? m.dir : 'down', sit: !!m.sit });
      a.last = { x, y, dir: out.dir, sit: out.sit, hidden: !!(a.last && a.last.hidden) };
    }
    ws.serializeAttachment(a);
    this.broadcast_(ws, out);
  }

  webSocketClose(ws, code) { this.gone_(ws); try { ws.close(1000); } catch (e) {} }
  webSocketError(ws) { this.gone_(ws); }

  gone_(ws) {
    const a = ws.deserializeAttachment();
    if (a && !a.uid) {   // a screen left: if it was leading, the next one takes over
      if (a.lead) { a.lead = false; try { ws.serializeAttachment(a); } catch (e) {} const next = this.views_().find(w => w !== ws); if (next) this.makeLeader_(next); }
      else this.tellPeers_();
      return;
    }
    if (!a || !a.uid || a.replaced) return;   // replaced by the same tab reconnecting: they never left
    const still = this.ctx.getWebSockets('u' + a.uid).some(o => o !== ws && o.readyState === 1);   // another tab of theirs is still open
    if (!still) this.broadcast_(ws, { t: 'bye', uid: a.uid });
  }
}
