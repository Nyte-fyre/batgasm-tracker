# Batgasm Casino Tracker

`!gamble` stats for anyone in [twitch.tv/batgasm](https://www.twitch.tv/batgasm). It tracks stream points only, not real money.

**Live page:** https://nyte-fyre.github.io/batgasm-tracker/

Type a Twitch username and the page loads every bet that name has made, then keeps updating while the stream runs. Nothing to install.

- **Live tab:** balance, session P/L, latest bets, odds and a chat rich list.
- **Odds board:** every roll in chat feeds the win threshold and the house edge. So far: 1–50 loses, 51–100 wins, ×2 payout.
- **Strategies:** Monte Carlo sims of flat betting, Kelly, Martingale, Paroli and more, using real chat rolls.

## How it works

- `worker/` is a Cloudflare Worker with one Durable Object. It joins Batgasm's chat **anonymously and read-only** (`justinfanNNNN`) and stores only gambling commands and Streamlabs replies. Its send function only allows the protocol lines needed to connect, so it can never post to chat. Deploy with `npx wrangler deploy` from `worker/`.
- `index.html` polls `https://batgasm-feed.nytefyre.workers.dev/events` every 10 seconds and builds the chosen user's stats in the browser. Data stays in that browser (localStorage).
- `batgasm-capture.user.js` is an optional Tampermonkey backup that reads chat in your own browser.
