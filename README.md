# Batgasm Casino Tracker

A personal stats dashboard for `!gamble` in [twitch.tv/batgasm](https://www.twitch.tv/batgasm). It tracks stream points only, not real money.

**Live page:** https://nyte-fyre.github.io/batgasm-tracker/

- **Live tab:** balance, session P/L, latest bets, odds and a chat rich list. It fills itself in while you watch.
- **Auto-capture:** install [`batgasm-capture.user.js`](https://nyte-fyre.github.io/batgasm-tracker/batgasm-capture.user.js) with Tampermonkey. It reads `!gamble` commands and Streamlabs replies from Batgasm's chat and passes them to the tracker tab. It never sends anything to chat.
- **Odds board:** every result in chat (not just yours) feeds the win rate, the roll threshold and the house edge estimate.
- **Strategies:** Monte Carlo sims of flat betting, Kelly, Martingale, Paroli and more, using real chat rolls.

Data stays in your browser (localStorage). Use Settings → Data to export a backup.

Single static `index.html`, no build step.
