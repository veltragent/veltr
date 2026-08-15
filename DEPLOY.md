# Deploying Veltr Agent

## What this needs from a host

Two things, and they rule out most of the obvious choices:

**A process that stays alive.** The scheduler is an in-process loop — the
Telegram long-poll, a 60-second corporate-action watcher, a 15-second token
monitor, a 5-minute change tracker, and a daily brief. There is no external cron.
A platform that runs functions per request cannot host this.

**A disk that survives a redeploy.** `data/watcher-state.json` holds every
subscriber, every watchlist and its settings, every mission, every tracked
target, the operator's chat id, and the Telegram long-poll cursor. Lose it and
you lose all of that — and a reset cursor makes the bot reprocess old messages.

So the agent cannot live on Vercel. The **website** can, and the two split
cleanly — see below.

---

## Split deployment: website on Vercel, agent on Railway

This works, and the codebase already separates along the right line. Every page
reads the chain and the market APIs directly and touches no stored state. Only
six API routes need the state file: `telegram/sync`, `subscribe`, `watch`,
`brief`, `mission`, and the Finnhub webhook.

One codebase, deployed twice, with different environments.

### Vercel — the website

```
VELTR_SCHEDULER=off
NEXT_PUBLIC_VELTR_BACKEND_URL=https://your-app.up.railway.app
```

`VELTR_SCHEDULER=off` is **not optional**. Without it this deployment also starts
a Telegram long-poll, and two consumers of `getUpdates` produce
`Conflict: terminated by other getUpdates request` — with messages answered at
random by whichever won the race.

It still needs the read-only credentials the pages use: `VELTR_RPC_URL`,
`FINNHUB_API_KEY`, `CODEX_API_KEY`, `COINGECKO_API_KEY`. It needs **no** bot
token, **no** private key, and **no** volume.

### Railway — the agent

Everything else, plus a volume mounted at `/data`:

```
VELTR_DATA_DIR=/data
VELTR_TELEGRAM_BOT_TOKEN=…
VELTR_OWNER_USERNAME=dimxbt
VELTR_CRON_SECRET=…
VELTR_ALLOWED_ORIGIN=https://your-app.vercel.app
```

`VELTR_ALLOWED_ORIGIN` lets the browser on the Vercel origin call the one
endpoint it needs. An explicit allowlist rather than `*`, because a POST to
`/api/telegram/sync` drains Telegram updates — any page that can call it can
interfere with the bot.

### Is the split worth it?

Railway alone serves both perfectly well, and is simpler: one deploy, one
environment, no CORS. The split buys CDN caching for a site whose pages already
revalidate every 60–300 seconds. Take it if you want the marketing site fast
worldwide; skip it if you would rather have one thing to reason about.

---

## Single host

A container host with a volume — Fly, Railway, Render, or any VPS.

---

## Before the first commit

The repository is initialised but has no commits, deliberately.

A `pre-commit` hook in `.git/hooks/pre-commit` blocks committing until this
repository has its own identity, because the machine has a global one that would
otherwise be used silently, and the first commit is the hardest to correct
afterwards.

```bash
git config --local user.name  "Your Name"
git config --local user.email "you@example.com"
```

The same hook refuses any staged file under `data/`.

### What is deliberately not committed

| Path | Why |
| --- | --- |
| `.env*` | Every credential, including two private keys |
| `/data` | Real Telegram chat ids, and signed EIP-7702 delegations |
| `.next`, `node_modules`, `*.tsbuildinfo` | Build output |

Five scripts previously carried a hardcoded bot token, a keyed Alchemy endpoint
and a real chat id. They now read from the environment and fail loudly when it is
missing. Re-check before publishing:

```bash
git status --short --untracked-files=all   # what would be committed
git check-ignore -v .env.local data/watcher-state.json
```

---

## Environment

Required for the bot to function at all:

```
VELTR_TELEGRAM_BOT_TOKEN     the bot
VELTR_RPC_URL                keyed endpoint; the public one is rate-limited
VELTR_CRON_SECRET            closes POST /api/watch, /api/brief and /api/mission
VELTR_DATA_DIR=/data         the mounted volume — see below
```

Strongly recommended:

```
VELTR_OWNER_USERNAME         restricts every push notification to one person
VELTR_VIRTUALS_API_KEY       the model gateway behind the agent
```

Everything else degrades gracefully. `.env.example` documents each one and what
its ceiling is.

**`VELTR_CRON_SECRET` must be set in production.** Unset, the authorised
endpoints close entirely rather than opening — the safe direction, but the
watcher trigger and the brief then cannot be driven at all.

---

## Container

```bash
docker build -t veltr-agent .
docker run -d \
  --name veltr-agent \
  -p 3000:3000 \
  -v veltr-data:/data \
  --env-file .env.local \
  veltr-agent
```

`VELTR_DATA_DIR=/data` is already set in the image, and `/data` is declared as a
volume. Mount something at it or the state lives inside the container and dies
with it.

Health check: `GET /api/health` → `200 ok` when the state directory is writable,
`503 degraded` when it is not. It reports `scheduler: standby` when another
instance holds the lease, which is a healthy state, not a failure.

---

## Running more than one instance

The background loops are gated on a lease held in the shared state file. Exactly
one instance runs them; the others serve HTTP and stand by, taking over
automatically within about 45 seconds if the holder dies.

This is correct for several processes on **one machine**, which is the failure
that actually occurred here — two instances both long-polling produced
`Conflict: terminated by other getUpdates request`, and messages were answered at
random by one or the other.

Across **machines** it needs shared storage. The interface is the right shape to
sit over Redis, but that has not been built. Until it is, run one instance, or
set `VELTR_SCHEDULER=off` on every replica but one.

---

## After deploying

1. Message the bot once from the account named in `VELTR_OWNER_USERNAME`.
   Telegram will not resolve a private username to a chat id for a bot, so the id
   is learned when the owner speaks. Until then the push gate **fails closed** and
   nobody receives notifications — including you.
2. Check `GET /api/health` returns `storage: writable`. If it says `unwritable`,
   the volume is not mounted and the next deploy will wipe every subscriber.
3. Confirm the logs show `scheduler lease acquired` followed by all four loops.

---

## Deploying a change

Push to `main`. Both hosts build from the connected repository — Vercel the
website, Railway the agent.

`railway up --service veltr-agent` still works and is the way to deploy a
working tree that has not been pushed, but it is no longer required.

Connecting the Railway side is two separate grants, which is easy to miss:
linking a GitHub account to Railway does not bind a repo to a service. The
service-level binding is

```
railway service source connect --repo <owner>/<repo> --branch main --service veltr-agent
```

and until it exists `railway status --json` reports `source.repo: null` however
thoroughly the account is connected.

### Three traps this deployment actually hit

**A Dockerfile `VOLUME` instruction.** Railway rejects it outright — it manages
volumes itself. Removed; plain Docker users mount `-v veltr-data:/data`.

**Volume ownership.** A platform volume is mounted over `/data` *after* the image
is built, arriving owned by root, while the image runs as `node`. The symptom is
not a crash: `/api/health` reports `storage: unwritable`, and the scheduler never
starts, because taking its lease is itself a write. `docker-entrypoint.sh` holds
root for exactly one `chown` and then execs as `node`.

**`export const revalidate` on a route handler.** It prerenders the route as a
static file, and the Vercel build then fails assembling its output with
`Unable to find lambda for route: /api/history`. All three affected routes
already set `Cache-Control` explicitly, so the export was redundant as well as
harmful.

### If a Vercel deployment sits at "Building…" forever

It is probably not building. Check with:

```bash
vercel deploy --prod --yes --debug 2>&1 | grep readyStateReason
```

A deployment can come back `"readyState": "BLOCKED"` with
`"alwaysRefuseToBuild": true` and a reason like *"Git author … must have access
to the team"*. Vercel attributes a CLI deployment to the HEAD commit's author and
refuses it when that address is not on the Vercel account. Neither the CLI
spinner nor `vercel inspect` says so — both report `UNKNOWN` indefinitely.

The repository commits under a GitHub `noreply` address, deliberately, so the
operator's personal email never enters the history. That address therefore has to
be added to the Vercel account, or deployments have to come through the connected
repository rather than the CLI. Both are one-time.

As a last resort, deploy a copy that carries no git metadata:

```bash
git archive HEAD | tar -x -C /tmp/stage
cp .vercel/project.json /tmp/stage/.vercel/
cd /tmp/stage && vercel deploy --prod --yes
```

`git archive` guarantees only committed files are sent — no `.env`, no `data/`.

---

## Known limitations

- **Single machine.** Caches, provider rate-limit budgets and the per-chat request
  lock are in memory, and the lease is file-backed.
- **State is a JSON file.** Fine at this size; it is a full rewrite per change.
- **GeckoTerminal allows 30 calls/minute per IP**, shared by the website and the
  monitor. The batching is sized for that; a much larger watchlist will need a key
  or a second source.
