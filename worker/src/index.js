/**
 * Batgasm chat feed.
 *
 * A single Durable Object ("Collector") logs into Twitch chat ANONYMOUSLY
 * (justinfanNNNN), joins #batgasm and stores only gambling-related lines:
 * every message from the Streamlabs bot plus !gamble-style commands.
 *
 * READ-ONLY BY DESIGN: anonymous Twitch logins cannot post, and sendIrc()
 * below refuses anything except the handful of protocol lines needed to
 * connect (CAP, PASS, NICK, JOIN, PONG). There is no code path that sends
 * PRIVMSG or any other chat message.
 *
 * Free-plan friendly: while chat is busy it stays connected; when chat has been
 * silent for a while it disconnects and only peeks in for a minute every few
 * minutes, so it is not held in memory around the clock.
 *
 * Routes (public, CORS *):
 *   GET  /status
 *   GET  /events?since=<ms>&limit=<n>   events with ts > since, oldest first
 *   POST /import  {token, events:[{id,ts,author,text}]}   (backfill, needs IMPORT_TOKEN)
 */

const CHANNEL = 'batgasm';
const IRC_URL = 'https://irc-ws.chat.twitch.tv';
const BOTS = /^(streamlabs|streamelements|nightbot)$/i;
const COMMANDS = /^!(gamble|duel|accept|heist|slots?|coins|top)\b/i;
const ALLOWED_IRC = /^(CAP REQ|PASS|NICK|JOIN|PONG)\b/; // never PRIVMSG
const QUIET_AFTER_MS = 20 * 60 * 1000;   // no chat for this long -> go quiet
const PEEK_MS = 70 * 1000;               // how long a quiet-mode peek listens
const QUIET_INTERVAL_MS = 4 * 60 * 1000; // quiet mode: peek this often
const ACTIVE_CHECK_MS = 60 * 1000;       // active mode: health check this often
const KEEP_DAYS = 120;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
});

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });
    }
    const url = new URL(req.url);
    if (!['/status', '/events', '/import', '/'].includes(url.pathname)) return json({ error: 'not found' }, 404);
    if (url.pathname === '/') return json({ name: 'batgasm-feed', routes: ['/status', '/events?since=0'] });
    const stub = env.COLLECTOR.get(env.COLLECTOR.idFromName('batgasm'));
    return stub.fetch(req);
  },
  async scheduled(_evt, env) {
    const stub = env.COLLECTOR.get(env.COLLECTOR.idFromName('batgasm'));
    await stub.fetch('https://internal/ensure');
  },
};

export class Collector {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.ws = null;
    this.connectedAt = 0;
    this.lastLineAt = 0;     // any IRC line (incl. PING)
    this.lastChatAt = 0;     // any chat message from anyone
    this.peekUntil = 0;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS events_ts ON events(ts)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ensure') { await this.ensure(); return json({ ok: true }); }
    if (url.pathname === '/status') {
      await this.ensure();
      const c = this.sql.exec('SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM events').one();
      return json({
        connected: this.isOpen(), mode: this.mode(), connectedAt: this.connectedAt || null,
        lastChatAt: this.lastChatAt || Number(this.getMeta('lastChatAt') || 0) || null,
        events: c.n, firstEventAt: c.first, lastEventAt: c.last, channel: CHANNEL, now: Date.now(),
      });
    }
    if (url.pathname === '/events') {
      this.ensure(); // do not wait: answering reads must stay fast
      const since = Number(url.searchParams.get('since') || 0) || 0;
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') || 2000) || 2000));
      const rows = this.sql.exec('SELECT id, ts, author, text FROM events WHERE ts > ? ORDER BY ts, id LIMIT ?', since, limit).toArray();
      return json({ events: rows, more: rows.length === limit, last: rows.length ? rows[rows.length - 1].ts : since, now: Date.now() });
    }
    if (url.pathname === '/import' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!this.env.IMPORT_TOKEN || body.token !== this.env.IMPORT_TOKEN) return json({ error: 'forbidden' }, 403);
      let added = 0;
      for (const e of Array.isArray(body.events) ? body.events : []) {
        if (!e || typeof e.text !== 'string' || !Number.isFinite(+e.ts) || !e.id) continue;
        const before = this.sql.exec('SELECT 1 FROM events WHERE id = ?', String(e.id)).toArray().length;
        if (!before) { this.sql.exec('INSERT OR IGNORE INTO events (id, ts, author, text) VALUES (?, ?, ?, ?)', String(e.id), Math.round(+e.ts), String(e.author || 'Streamlabs').slice(0, 40), e.text.slice(0, 600)); added++; }
      }
      return json({ ok: true, added });
    }
    return json({ error: 'not found' }, 404);
  }

  getMeta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray(); return r.length ? r[0].v : null; }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); }

  isOpen() { return !!this.ws && this.ws.readyState === 1; }
  mode() {
    const lastChat = this.lastChatAt || Number(this.getMeta('lastChatAt') || 0);
    return Date.now() - lastChat < QUIET_AFTER_MS ? 'active' : 'quiet';
  }

  /** Make sure we are connected (or peeking) and that the next alarm is set. */
  async ensure() {
    const now = Date.now();
    if (this.isOpen() && now - this.lastLineAt > 6 * 60 * 1000) this.drop('stale');
    if (!this.isOpen()) {
      if (this.mode() === 'quiet') this.peekUntil = now + PEEK_MS;
      await this.connect();
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm < now) await this.ctx.storage.setAlarm(now + (this.mode() === 'active' ? ACTIVE_CHECK_MS : PEEK_MS));
  }

  async alarm() {
    const now = Date.now();
    if (this.mode() === 'quiet') {
      // Quiet: if a peek just ended with no chat, disconnect until the next peek.
      if (this.isOpen() && now >= this.peekUntil) this.drop('quiet');
      if (!this.isOpen() && now >= this.peekUntil) {
        const nextPeek = Number(this.getMeta('nextPeek') || 0);
        if (now >= nextPeek) {
          this.setMeta('nextPeek', now + QUIET_INTERVAL_MS);
          this.peekUntil = now + PEEK_MS;
          await this.connect();
          await this.ctx.storage.setAlarm(now + PEEK_MS);
          return;
        }
        await this.ctx.storage.setAlarm(Math.max(nextPeek, now + 30 * 1000));
        return;
      }
      await this.ctx.storage.setAlarm(now + PEEK_MS);
      return;
    }
    // Active: stay connected; reconnect if needed.
    if (!this.isOpen() || now - this.lastLineAt > 6 * 60 * 1000) { this.drop('health'); await this.connect(); }
    if (now % (6 * 60 * 60 * 1000) < ACTIVE_CHECK_MS) this.prune();
    await this.ctx.storage.setAlarm(now + ACTIVE_CHECK_MS);
  }

  prune() { this.sql.exec('DELETE FROM events WHERE ts < ?', Date.now() - KEEP_DAYS * 86400000); }

  drop(_why) {
    try { this.ws && this.ws.close(1000, 'bye'); } catch {}
    this.ws = null;
  }

  /** The ONLY way anything is sent to Twitch. Chat messages are impossible by construction. */
  sendIrc(line) {
    if (!ALLOWED_IRC.test(line) || /PRIVMSG/i.test(line)) throw new Error('blocked outgoing IRC line');
    this.ws.send(line);
  }

  async connect() {
    if (this.isOpen()) return;
    let resp;
    try { resp = await fetch(IRC_URL, { headers: { Upgrade: 'websocket' } }); } catch { return; }
    const ws = resp.webSocket;
    if (!ws) return;
    ws.accept();
    this.ws = ws;
    this.connectedAt = Date.now();
    this.lastLineAt = Date.now();
    ws.addEventListener('message', (e) => this.onData(typeof e.data === 'string' ? e.data : ''));
    ws.addEventListener('close', () => { if (this.ws === ws) this.ws = null; });
    ws.addEventListener('error', () => { if (this.ws === ws) this.ws = null; });
    this.sendIrc('CAP REQ :twitch.tv/tags twitch.tv/commands');
    this.sendIrc('PASS SCHMOOPIIE');
    this.sendIrc('NICK justinfan' + (10000 + Math.floor(Math.random() * 80000)));
    this.sendIrc('JOIN #' + CHANNEL);
  }

  onData(data) {
    this.lastLineAt = Date.now();
    for (const line of data.split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { this.sendIrc('PONG :tmi.twitch.tv'); continue; }
      const m = parseIrc(line);
      if (m.command !== 'PRIVMSG') { if (m.command === 'RECONNECT') this.drop('reconnect'); continue; }
      const now = Date.now();
      this.lastChatAt = now;
      if (now - Number(this.getMeta('lastChatAtSaved') || 0) > 30000) { this.setMeta('lastChatAt', now); this.setMeta('lastChatAtSaved', now); }
      const author = m.tags['display-name'] || (m.prefix.split('!')[0] || '');
      let text = m.trailing || '';
      if (text.startsWith('\u0001ACTION ')) text = text.slice(8).replace(/\u0001$/, '');
      text = text.replace(/\s+/g, ' ').trim();
      if (!author || !text) continue;
      if (!BOTS.test(author) && !COMMANDS.test(text)) continue;
      const ts = Number(m.tags['tmi-sent-ts']) || now;
      const id = m.tags.id || `${ts}-${author}-${text.length}`;
      this.sql.exec('INSERT OR IGNORE INTO events (id, ts, author, text) VALUES (?, ?, ?, ?)', id, ts, author.slice(0, 40), text.slice(0, 600));
    }
  }
}

function parseIrc(line) {
  const tags = {};
  let rest = line;
  if (rest[0] === '@') {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest[0] === ':') { const sp = rest.indexOf(' '); prefix = rest.slice(1, sp); rest = rest.slice(sp + 1); }
  const ti = rest.indexOf(' :');
  const params = ti >= 0 ? rest.slice(0, ti) : rest;
  const trailing = ti >= 0 ? rest.slice(ti + 2) : '';
  const [command, ...args] = params.split(' ');
  return { tags, prefix, command, args, trailing };
}
