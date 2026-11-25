// ==UserScript==
// @name         Batgasm Casino Tracker - chat capture
// @namespace    https://nyte-fyre.github.io/batgasm-tracker/
// @version      1.1.0
// @description  Reads !gamble commands and Streamlabs results from twitch.tv/batgasm chat and hands them to your Batgasm Casino Tracker tab. Read-only: it never sends chat messages.
// @match        https://www.twitch.tv/*
// @match        https://nyte-fyre.github.io/batgasm-tracker/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// @updateURL    https://nyte-fyre.github.io/batgasm-tracker/batgasm-capture.user.js
// @downloadURL  https://nyte-fyre.github.io/batgasm-tracker/batgasm-capture.user.js
// ==/UserScript==

(function () {
  'use strict';
  const VERSION = '1.1.0';
  const CHANNEL = 'batgasm';
  // Accounts whose messages are always captured (bot replies).
  const BOTS = /^(streamlabs|streamelements|nightbot|moobot|fossabot|wizebot)$/i;
  // Commands captured from anyone, so the tracker can pair wagers with results.
  const COMMANDS = /^!(gamble|duel|heist|slots|roulette|coins)\b/i;
  const MAX_QUEUE = 3000;
  // The page's own window (Tampermonkey's `window` can be a sandbox wrapper).
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  if (location.hostname.endsWith('twitch.tv')) twitchSide();
  else trackerSide();

  /* ---------- On Twitch: watch chat, queue matching lines ---------- */
  function twitchSide() {
    const seen = new WeakSet();
    let lastMsg = 0;

    const onChannel = () => {
      const p = location.pathname.toLowerCase().split('/').filter(Boolean);
      return p[0] === CHANNEL || ((p[0] === 'popout' || p[0] === 'embed') && p[1] === CHANNEL) || (p[0] === 'moderator' && p[1] === CHANNEL);
    };

    function readLine(el) {
      const author = (
        el.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')?.textContent ||
        el.getAttribute('data-a-user') || ''
      ).trim();
      const body = el.querySelector('[data-a-target="chat-line-message-body"]') || el.querySelector('.message');
      const text = (body ? body.innerText : '').replace(/\s+/g, ' ').trim();
      return { author, text };
    }

    function handle(el) {
      if (seen.has(el)) return;
      seen.add(el);
      if (!onChannel()) return;
      const { author, text } = readLine(el);
      if (!author || !text) return;
      if (!BOTS.test(author) && !COMMANDS.test(text)) return;
      const ev = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 9), ts: Date.now(), channel: CHANNEL, author, text };
      const q = GM_getValue('queue', []);
      q.push(ev);
      if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
      GM_setValue('queue', q);
      lastMsg = ev.ts;
      count++;
      drawBadge();
      beat();
    }

    // Lines already on screen when the script starts are history: skip them.
    document.querySelectorAll('.chat-line__message').forEach((el) => seen.add(el));

    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches('.chat-line__message')) handle(n);
          if (n.querySelectorAll) n.querySelectorAll('.chat-line__message').forEach(handle);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Small local counter so you can see the script is running. Only drawn in your own browser.
    let count = 0;
    const badge = document.createElement('div');
    badge.title = 'Batgasm tracker capture (read-only)';
    badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:600 11px system-ui,sans-serif;padding:3px 8px;border-radius:999px;background:rgba(145,70,255,.85);color:#fff;pointer-events:none;opacity:.85';
    const drawBadge = () => { badge.textContent = onChannel() ? `● tracker capture · ${count}` : '○ tracker capture (not on batgasm)'; };
    drawBadge();
    (document.body || document.documentElement).appendChild(badge);
    setInterval(drawBadge, 5000);

    function beat() {
      GM_setValue('status', { ts: Date.now(), channel: CHANNEL, onChannel: onChannel(), lastMsg, version: VERSION });
    }
    beat();
    setInterval(beat, 10000);
  }

  /* ---------- On the tracker page: hand queued lines to the page ---------- */
  function trackerSide() {
    document.documentElement.setAttribute('data-batgasm-capture', VERSION);
    const post = (msg) => PAGE.postMessage(JSON.parse(JSON.stringify(Object.assign({ source: 'batgasm-capture', version: VERSION }, msg))), location.origin);
    const sendEvents = () => {
      const q = GM_getValue('queue', []);
      if (q.length) post({ type: 'events', events: q });
    };
    const sendStatus = () => post({ type: 'status', status: GM_getValue('status', null) });

    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || e.data.source !== 'batgasm-tracker') return;
      if (e.data.type === 'hello') { sendStatus(); sendEvents(); }
      if (e.data.type === 'ack' && Array.isArray(e.data.ids)) {
        const ids = new Set(e.data.ids);
        GM_setValue('queue', GM_getValue('queue', []).filter((x) => !ids.has(x.id)));
      }
    });

    GM_addValueChangeListener('queue', (name, oldV, newV, remote) => { if (remote) sendEvents(); });
    GM_addValueChangeListener('status', () => sendStatus());
    sendStatus();
    sendEvents();
    setInterval(sendStatus, 15000);
  }
})();
