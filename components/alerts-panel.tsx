"use client";

import { useEffect, useState } from "react";
import { backendUrl } from "@/lib/backend";

type Status = {
  configured: boolean;
  subscribers: number;
  lastUpdateId: number | null;
  schedulerActive?: boolean;
};

export function AlertsPanel({ botUsername }: { botUsername: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch(backendUrl("/api/telegram/sync"));
      setStatus(await res.json());
    } catch {
      /* status stays unknown */
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(backendUrl("/api/telegram/sync"));
        const json = (await res.json()) as Status;
        if (!cancelled) setStatus(json);
      } catch {
        /* status stays unknown */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function sync() {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch(backendUrl("/api/telegram/sync"), { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed.");
      setMessage(
        json.added > 0
          ? `Registered ${json.added} new subscriber${json.added === 1 ? "" : "s"}. Check Telegram for the confirmation.`
          : json.removed > 0
            ? `Removed ${json.removed} subscriber${json.removed === 1 ? "" : "s"}.`
            : "No new messages. Send /start to the bot first, then sync again."
      );
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-paper p-7">
      <ol className="space-y-6">
        <li className="flex gap-4">
          <span className="tnum shrink-0 text-[13px] text-ink-faint">01</span>
          <div>
            <p className="text-[15px] font-medium text-ink">Open the bot</p>
            <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">
              Send <code className="tnum text-ink">/start</code> to{" "}
              <a
                href={`https://t.me/${botUsername}`}
                target="_blank"
                rel="noreferrer"
                className="link-underline text-ink"
              >
                @{botUsername}
              </a>
              . Nothing else is required — no account, no wallet connection.
            </p>
          </div>
        </li>

        <li className="flex gap-4">
          <span className="tnum shrink-0 text-[13px] text-ink-faint">02</span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-medium text-ink">Get confirmed</p>
            <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">
              {status?.schedulerActive === false
                ? "Automatic registration is disabled on this instance — use the button below."
                : "Registration is automatic; the bot replies within seconds. Use the button only if no reply arrives."}
            </p>
            <button
              onClick={sync}
              disabled={syncing || status?.configured === false}
              className="mt-4 rounded-lg border border-line-strong px-5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-cream-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {syncing ? "Checking…" : "Register me manually"}
            </button>
          </div>
        </li>

        <li className="flex gap-4">
          <span className="tnum shrink-0 text-[13px] text-ink-faint">03</span>
          <div>
            <p className="text-[15px] font-medium text-ink">Narrow it to your wallet</p>
            <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">
              Send <code className="tnum text-ink">/watch 0x…</code> and Veltr alerts you only about
              tokens that address actually holds — each message rewritten in terms of your own
              position. Read-only: an address is never asked to sign anything.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              <code className="tnum text-ink-soft">/unwatch</code> returns to chain-wide,{" "}
              <code className="tnum text-ink-soft">/status</code> shows what Veltr sees, and{" "}
              <code className="tnum text-ink-soft">/stop</code> unsubscribes.
            </p>
          </div>
        </li>
      </ol>

      {message && (
        <p className="mt-6 rounded-lg border border-line-soft bg-cream px-4 py-3 text-[13px] text-ink-soft">
          {message}
        </p>
      )}

      <dl className="mt-7 grid grid-cols-2 gap-4 border-t border-line-soft pt-5 text-[13px]">
        <div>
          <dt className="eyebrow">Delivery</dt>
          <dd className="mt-1.5 text-ink">
            {status === null ? "…" : status.configured ? "Active" : "Not configured"}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Subscribers</dt>
          <dd className="tnum mt-1.5 text-ink">{status?.subscribers ?? "…"}</dd>
        </div>
      </dl>
    </div>
  );
}
