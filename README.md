# 🔔 Token Bell

**Out of Claude tokens? Go play. Token Bell rings when they're back.**

![Token Bell open over Valheim](assets/token-bell-valheim.png)

You hit your limit mid-flow. The reset is three hours away. You could stare at a countdown, or
you could go build a longhouse, sail into a storm and get chased by a troll.

Token Bell is a [Decky Loader](https://decky.xyz) plugin for the Steam Deck that keeps an eye on
your Claude limits while you play. The moment your tokens refill, a notification drops in right
over your game. Finish the fight, put the controller down, get back to shipping.

## What you get

- **Your limits at a glance.** Session, weekly and per-model weekly, each with a bar and a
  countdown, one button press away in the Quick Access Menu. No alt-tabbing, no browser.
- **A bell on every limit.** Press A to arm it. When that limit resets, you hear it and see it,
  in whatever game you're in.
- **Your whole account.** Burned your session on the laptop? The Deck knows.
- **Sign in once.** Already use Claude Code on your Deck? It just works. If not, one button
  signs you in.

## Install

```sh
npm install
tools/package.sh          # builds out/token-bell.zip
node tools/install.mjs    # asks Decky to install it; confirm on the Deck
```

Or install the zip by hand from Decky's settings: Developer > Install plugin from ZIP.

## Under the hood

`main.py` runs a Claude usage counter every five minutes and whenever a reset is due, and the
panel (`src/index.tsx`) draws what it reports. Reset times are known ahead, so the bell rings on
time even if the Deck is offline at that moment.

## Credit

The numbers come from [`omarchy-agent-usage-claude`](https://github.com/basecamp/omarchy/blob/master/bin/omarchy-agent-usage-claude),
the Claude usage counter Token Bell was forked from, included unchanged under its MIT licence
(`vendor/claude-usage`).
