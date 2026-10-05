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
// Hibernation API: idle sockets cost nothing, and 'ping' -> 'pong' is answered without waking the object.
import { DurableObject } from 'cloudflare:workers';

const ORIGINS = [/^https:\/\/timberjones\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^null$/];   // null = a local file
const DIRS = ['up', 'down', 'left', 'right'];
const GX = 48, GY = 28;                   // office grid (gm-office.html)
const MAX_PER_SEC = 40, MAX_LEN = 400;
const DAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function eastern() {   // { day, h }: the same day key as zoneDay() in gm-office.html (e.g. 2026-10-5), and the hour as 15.5
  const o = {}; for (const p of DAY_FMT.formatToParts(new Date())) o[p.type] = p.value;
  return { day: `${o.year}-${o.month}-${o.day}`, h: +o.hour + o.minute / 60 };
}
const PM_FROM = 14;   // posts from 2 pm on are afternoon counts
const HEX = /^#[0-9a-f]{6}$/i, STYLES = ['short', 'spiky', 'long', 'bun'];
function cleanLook(l) {   // only the fields gm-office.html draws, checked; null if it isn't a look
  if (!l || typeof l !== 'object' || !HEX.test(l.hair) || !HEX.test(l.shirt) || !HEX.test(l.pants)) return null;
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
    const uid = new URL(req.url).searchParams.get('uid');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, uid ? ['ctl', 'u' + uid] : ['view']);
    server.serializeAttachment({ uid: uid || null, last: null, n: 0, t0: 0 });
    const looks = {};
    for (const [k, v] of await this.ctx.storage.list({ prefix: 'look:' })) looks[k.slice(5)] = v;
    server.send(JSON.stringify({ t: 'state', online: this.online_(server), looks, count: await this.count_() }));   // who's driving right now and where, and everyone's look
    return new Response(null, { status: 101, webSocket: client });
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
    if (!a || !a.uid || typeof raw !== 'string' || raw.length > MAX_LEN) return;   // viewers only listen
    const now = Date.now();
    if (now - a.t0 > 1000) { a.t0 = now; a.n = 0; }
    if (++a.n > MAX_PER_SEC) { ws.serializeAttachment(a); return; }
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || !['hello', 'step', 'hb', 'look'].includes(m.t)) return;
    const out = { t: m.t, uid: a.uid };
    if (m.t === 'look') {
      const look = cleanLook(m.look);
      if (!look) return;
      await this.ctx.storage.put('look:' + a.uid, look);
      out.look = look;
    } else if (m.t !== 'hb') {
      const x = m.x | 0, y = m.y | 0;
      if (x < 0 || y < 0 || x >= GX || y >= GY) return;
      Object.assign(out, { x, y, dir: DIRS.includes(m.dir) ? m.dir : 'down', sit: !!m.sit });
      a.last = { x, y, dir: out.dir, sit: out.sit };
    }
    ws.serializeAttachment(a);
    this.broadcast_(ws, out);
  }

  webSocketClose(ws, code) { this.gone_(ws); try { ws.close(1000); } catch (e) {} }
  webSocketError(ws) { this.gone_(ws); }

  gone_(ws) {
    const a = ws.deserializeAttachment();
    if (!a || !a.uid) return;
    const still = this.ctx.getWebSockets('u' + a.uid).some(o => o !== ws && o.readyState === 1);   // another tab of theirs is still open
    if (!still) this.broadcast_(ws, { t: 'bye', uid: a.uid });
  }
}
