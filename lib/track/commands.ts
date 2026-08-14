import { parseTarget, readSignal } from "./signals";
import { addTrack, listTracks, removeTrack, type Track } from "./store";

/**
 * Telegram surface for change monitoring.
 *
 * Returns rendered replies rather than sending them, matching the other
 * features so the transport keeps one delivery path.
 */

export type TrackReply = { text: string };

const label = (track: Track) => (track.kind === "repo" ? track.ref : track.ref.replace(/^https?:\/\//, ""));

const USAGE = [
  "Track something for changes and I will tell you only when it actually changes.",
  "",
  "/track vercel/next.js          a repository",
  "/track https://example.com     a page",
  "",
  "/tracks            what you are tracking",
  "/untrack <target>  stop",
].join("\n");

export async function handleTrack(userId: string, argument: string): Promise<TrackReply> {
  const target = parseTarget(argument);
  if (!target) return { text: USAGE };

  const added = await addTrack(userId, target);
  if (!added.ok) return { text: added.error };

  if (added.existed) {
    return {
      text: `Already tracking ${label(added.track)}.\n\nLast checked: ${added.track.lastCheckedAt?.slice(0, 16).replace("T", " ") ?? "not yet"}.`,
    };
  }

  // Read once now, so the reply confirms the target is reachable rather than
  // promising to watch something that does not resolve.
  const reading = await readSignal(target);

  if (!reading.ok) {
    await removeTrack(userId, target.ref);
    return {
      text: [
        `Could not read ${label(added.track)} — ${reading.error}.`,
        "",
        target.kind === "repo"
          ? "Check the owner/repo spelling, and that it is public."
          : "Check the URL is reachable.",
        "",
        "Nothing is being tracked.",
      ].join("\n"),
    };
  }

  console.log(`[veltr][TRACK] added ${target.kind} ${target.ref} for ${userId}`);

  return {
    text: [
      `👁 Tracking ${label(added.track)}`,
      "",
      `Now: ${reading.signal.summary}`,
      "",
      target.kind === "repo"
        ? "You will hear from me when a new commit lands."
        : "You will hear from me when the readable content changes — clocks and timestamps are ignored.",
      "",
      "Checked every 15 minutes. Nothing is sent while it stays the same.",
    ].join("\n"),
  };
}

export async function handleTracks(userId: string): Promise<TrackReply> {
  const tracks = await listTracks(userId);
  if (tracks.length === 0) return { text: USAGE };

  const rows = tracks.map((track, i) => {
    const state = !track.enabled
      ? "paused after repeated failures"
      : track.lastChangedAt
        ? `last changed ${track.lastChangedAt.slice(0, 16).replace("T", " ")}`
        : "no change since you started";

    return [
      `${i + 1}. ${label(track)}${track.kind === "repo" ? "" : "  (page)"}`,
      `   ${state}`,
      track.lastSummary ? `   ${track.lastSummary.slice(0, 90)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return { text: [`👁 Tracking ${tracks.length}`, "", rows.join("\n\n")].join("\n") };
}

export async function handleUntrack(userId: string, argument: string): Promise<TrackReply> {
  const raw = argument.trim();
  if (!raw) {
    const tracks = await listTracks(userId);
    if (tracks.length === 0) return { text: "You are not tracking anything." };
    return {
      text: ["Which one?", "", ...tracks.map((t) => `/untrack ${t.ref}`)].join("\n"),
    };
  }

  // Accept what /tracks displayed, which drops the scheme.
  const target = parseTarget(raw);
  const removed =
    (await removeTrack(userId, target?.ref ?? raw)) ??
    (await removeTrack(userId, `https://${raw}`)) ??
    (await removeTrack(userId, `http://${raw}`));

  if (!removed) return { text: `Not tracking ${raw}. Send /tracks to see what you are.` };
  return { text: `Stopped tracking ${label(removed)}.` };
}
