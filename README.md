<p align="center">
  <img src=".github/banner.png" alt="Veltr Agent" width="100%">
</p>

<p align="center">
  US equities trade on <b>Robinhood Chain</b> as tokens that never rebase.<br>
  A split moves an on-chain multiplier and your balance does not change at all —<br>
  so every wallet reading <code>balanceOf</code> reports a position that is wrong.
</p>

<p align="center">
  <a href="https://veltragent.com"><b>Website</b></a> ·
  <a href="https://veltragent.com/docs"><b>Documentation</b></a> ·
  <a href="https://t.me/veltragent_bot"><b>Telegram bot</b></a> ·
  <a href="https://veltragent.com/market"><b>Live premiums</b></a>
</p>

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-1f1a14?style=flat-square">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-1f1a14?style=flat-square">
  <img alt="394 tests" src="https://img.shields.io/badge/tests-401%20passing-3f6b4a?style=flat-square">
  <img alt="Zero test dependencies" src="https://img.shields.io/badge/test%20deps-0-8b7c68?style=flat-square">
</p>

---

Two products from one data layer: a website worth linking to, and a Telegram
agent that answers and acts.

---

## The two things nobody else reports

**1. Your balance is not your position.**

Stock tokens never rebase. A split or dividend moves an on-chain `uiMultiplier`
while every holder's raw balance stays byte-for-byte identical:

```
underlyingShares = rawBalance × uiMultiplier ÷ 1e18
```

Any wallet, tracker or tax export reading plain `balanceOf` is wrong the moment a
corporate action lands. CRWD currently carries a multiplier of `4.0` — a 4:1
split already applied — so a raw balance understates real holdings by 300%.

**2. Two prices for the same company.**

Each token has an on-chain price set by pool liquidity and an exchange price set
by NASDAQ or NYSE. The gap is the premium, and it widens every night and weekend
because only one of the two markets ever closes. `/market` prices every one of them
against its real listing.

---

## Running it

```bash
npm install
cp .env.example .env.local     # the app degrades gracefully without keys
npm run dev
npm test                       # node --test, no test framework to install
```

Blockscout, GeckoTerminal, DexScreener, Yahoo Finance and Nasdaq's splits
calendar need no credentials at all.

---

## Website

| Route | Purpose |
| --- | --- |
| `/` | The mechanism, live evidence, and how the agent works |
| `/docs` | Reference: purpose, every command, and what it refuses |
| `/market` | Premium wall — every stock token against its listing |
| `/explorer` | Every asset on the chain, ranked by real activity |
| `/radar` | Multiplier state ranked by reporting error |
| `/history` | Every corporate action the chain has recorded |
| `/exposure` | Per-address reconciliation of `balanceOf` vs `balanceOfUI` |
| `/alerts` | Subscribe to the bot |
| `/autonomous` | How execution would work, and why it is not live |
| `/method` | Technical method, data sources, limits |
| `/token/[address]` | Dual charts: on-chain candles beside the equity |

---

## Telegram agent

The bot is not a command menu with an LLM bolted on. It decides which tools to
call, calls several when a question needs them, and acts — sending a chart,
changing an alert scope — instead of telling the user which command to type.

**33 tools.** Read tools return live data. Act tools change only what the caller
owns — their chat, their subscription — and are all reversible.

```
MARKET     /price  /chart  /premium  /token  /news  /market  /splits
CHAIN      /chain  /flow   /portfolio  /delegation
MISSIONS   /mission  /missions  /every  /schedules  /unschedule
WATCH      /watch  /watches  /unwatch  /settings
TRACKING   /track  /tracks  /untrack
SESSION    /status  /cancel  /help  /stop
```

Or plain language: *"why is NVDA above its stock price?"*, *"show me the AAPL
chart"*, *"what actually trades on this chain?"*

Every figure comes from a tool. The model has no way to invent a price.

---

## Missions

`/mission <objective>` takes a goal rather than a sequence of steps. The agent
decides what to observe, observes it, decides what that means, and asks before
doing anything consequential:

```
OBSERVE → REASON → DECIDE → ACT → VERIFY
```

**Nothing is stated that was not observed.** Every tool result enters an evidence
ledger with an id. A conclusion must cite ids that resolve; one that cites
nothing, or cites an id that does not exist, is downgraded to *"evidence is not
sufficient"* rather than published. URLs are filtered against the set some tool
actually returned, so an invented source cannot survive into an answer.
Confidence is dropped unless at least two observations sit behind it.

**High-risk actions always ask.** Tools are classified by what they can do:
reads, reversible changes the caller owns, and consequential actions. The third
class requires explicit approval in every permission mode, with no override —
and an unclassified tool is treated as consequential, so a tool added later
cannot become autonomously callable by being forgotten.

**An action is not done until it is verified.** After acting, an independent read
confirms the world is in the state the action claimed. A tool with no verifier is
reported as *unverified*, never as success.

**Bounded three ways** — iterations, tool calls, wall clock — because an agent
that decides when to stop can decide not to. Identical calls are deduplicated,
results are truncated, and the whole registry is never offered at once: routing
cuts 33 tools to the handful an objective implies.

A mission waiting for approval is persisted, so the answer can arrive hours later
in a different process.

```
/mission investigate why NVDA is trading above its stock price
/missions          your missions, and anything awaiting approval
```

Also available at `POST /api/mission` (authorised, rate-limited).

---

## Token watch

`/watch <contract address>` monitors any token on this chain — not just the
tokenised stocks — and alerts on moves the user defines in `/settings`:

```
/watch 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18
```

Price up and down as percentages from the price at the moment of watching;
market cap, liquidity and 24h volume as levels. Every threshold takes a preset or
a custom value, per user, through inline buttons.

**One command, two meanings.** `/watch` took a *wallet* address before this
existed, and still does — that scopes corporate-action alerts to the tokens a
wallet holds. The chain is asked which kind of address it is (a wallet has no
bytecode) rather than the user, so neither behaviour needs a second command.
`/watch wallet 0x…` and `/watch token 0x…` force the reading either way.

**One alert per move, not one per poll.** A threshold that fires disarms, and
re-arms only once the metric retreats through a band — half the threshold for a
percentage move, 5% of the level otherwise. A token that reaches +10% and keeps
climbing produces one alert; a token that round-trips and rallies again produces
two. An `alertCooldown` sits behind that as a second limit.

**Missing data is never zero.** A provider outage leaves the reading absent, and
an absent metric evaluates no condition at all — otherwise the first API failure
would fire every "below" alert on every watchlist at once.

**Cost is bounded by tokens, not users.** One centralised cycle serves every
watch. A hundred people watching the same token is one market read; thirty
distinct tokens is one call per provider.

---

## Data sources, and where each one stops

| Source | Used for | Ceiling |
| --- | --- | --- |
| Chain RPC + Multicall3 | Multiplier state, balances | Public endpoint is rate-limited |
| Blockscout | Token discovery, holders, price, logos | — |
| Codex | Aggregate liquidity, flow, OHLCV, full token list | **No ranked holder list on this plan** |
| DexScreener | Price, liquidity, volume, trade counts | 300 req/min, per IP. The batch endpoint takes 30 addresses but caps the reply at 30 *pairs*, so totals must be fetched per token |
| GeckoTerminal | Candles, pool discovery, batched prices, aggregate reserve | 30 calls/min, per IP; 30 addresses per batch; no market cap without a CoinGecko listing |
| Yahoo Finance | Underlying equity price | Unofficial; may return nothing |
| Finnhub | Profiles, analysts, earnings, session state | **`/stock/split` withheld on free tier** |
| Nasdaq | Announced splits calendar | Window-based, not an open range |
| CoinGecko | Global crypto | **Demo tier; Pro endpoints rejected** |
| Tavily / Exa / Firecrawl / Jina | Search, semantic search, JS rendering, fast reads | — |
| GitHub | Repo analysis, code search | 5,000 req/hour, 1,000 results/query |

> Alchemy's free tier caps `eth_getLogs` at a 10-block range, which cannot read a
> full corporate-action history. Log reads therefore use the public endpoint,
> which serves an unbounded range — `VELTR_LOGS_RPC_URL` exists for that split.

---

## Architecture notes

**Discovery is interface-based.** A contract that answers `uiMultiplier()` is a
stock token. No hardcoded address list, so new listings appear automatically.

**Caches reject degenerate results.** A throttled RPC returning an empty token
set would otherwise be cached as truth for thirty minutes, emptying the product
with no error anywhere.

**State is mtime-invalidated.** The scheduler and the HTTP handlers can run in
separate worker processes; a plain memo makes request handlers serve state frozen
at their own first read.

**The scheduler runs in-process.** Telegram long-poll, a 60-second corporate-action
watcher, a 15-second token-watch tick, and a once-daily brief — no external cron.
Single-instance only.

**Watching starts no process.** `/watch` appends a row; the next monitoring cycle
picks it up. So the number of timers never grows with the number of users, and a
restart resumes every watch from disk with nothing lost.

**Market figures are derived, not taken.** Blockscout publishes price, volume and
market cap as precomputed fields, and they do not survive checking: for NVDA it
reported $1.22M of 24h volume against $4.00M actually traded, and a market cap
that disagrees with its own supply times its own price. Price and pool totals
come from the pools themselves, summed across every pair the token is the base
of; market cap is `totalSupplyUI × price`. The raw supply would be wrong by
exactly the multiplier after a corporate action — the misreporting this project
exists to catch, and therefore the one place it must not appear.

**A premium needs a market, not just a price.** Thirty-eight tokens trade in no
indexed pool; their only price is derived from the share, so comparing the two
is nearly circular. Below $10,000 of pool depth a $250 trade moves the price
five percent. Both are excluded, which is the difference between a dislocation
and a rounding artefact with a large number attached.

---

## Not live

**Autonomous execution.** The rail is built and the EIP-7702 authorisation format
verified on mainnet, but no delegation has been broadcast. Veltr watches and
prepares; it does not execute.

EIP-7702 rather than an ERC-4337 smart account is deliberate: a 4337 account has
a *new address*, so users would have to migrate existing positions before
anything could protect them.

The delegate is MetaMask's stateless implementation. Bytecode probing showed
ZeroDev Kernel carries an `initialize()` function, which leaves a window between
delegation and initialisation in which anyone could seize the account. Stateless
removes that window.

The session key, when it exists, can only reduce risk, and funds may only move to
the delegating account. Under compromise the worst reachable outcome is an
unwanted position close — not a drain.

```bash
node scripts/generate-keys.mjs     # writes keys to .env.local, prints addresses
node scripts/delegate.mjs          # dry run
node scripts/delegate.mjs --execute
```

---

## Disclaimer

Informational tooling. Not investment, tax, or legal advice. Stock tokens on
Robinhood Chain are debt securities, not equity — holders receive no shareholder
rights.
