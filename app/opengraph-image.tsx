import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * The card the homepage renders as when its link is shared.
 *
 * The claim, the mark, and nothing else — no live figures at all.
 *
 * An earlier version carried a count of tracked tokens. Rendering it showed
 * "44 stock tokens tracked" while three consecutive reads on the same machine
 * said 95, because an image like this is prerendered at build and that build
 * had caught a partial chain read. A number baked in at build time is not live
 * data; it is whatever the build machine happened to see, published as fact and
 * frozen until something revalidates it. The market card can carry live rows
 * because it revalidates every minute and is explicitly a snapshot. This one is
 * about something that does not move.
 *
 * 1200x630 rather than a true 16:9. Every platform this is shared into — X,
 * Telegram, Discord, WhatsApp — crops toward roughly 1.91:1, so 1200x675 loses
 * a band top and bottom. The proportions asked for are what the viewer sees;
 * the file is sized so that stays true.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Veltr Agent — your balance is fixed, your ownership is not";
export const revalidate = false;

/* The site's own palette. Nothing here is a colour the pages do not already use. */
const INK = "#1f1a14";
const CREAM = "#f7f2e7";
const INK_SOFT = "#544838";
const INK_FAINT = "#b3a58f";
const LINE = "#e3d7c1";

/**
 * The mark, inlined.
 *
 * ImageResponse renders in isolation with no origin to resolve a relative path
 * against, so the file is read from disk and embedded. The trimmed copy is used
 * for the same reason the header uses it: the source carries a quarter of its
 * width in empty margin, and laying that out puts the brand where nobody asked
 * for it.
 */
const markDataUri = `data:image/png;base64,${readFileSync(
  join(process.cwd(), "public/logo-mark.png")
).toString("base64")}`;

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: CREAM,
          color: INK,
          padding: "80px 88px",
          fontFamily: "Georgia, serif",
        }}
      >
        {/* Brand lockup, left. The same order and rhythm as the site header. */}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={markDataUri} alt="" width={46} height={50} />
          <span style={{ fontSize: 34, letterSpacing: "-0.02em" }}>Veltr Agent</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 78, lineHeight: 1.04, maxWidth: 880 }}>
            Your balance is fixed. Your ownership is not.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 27,
              color: INK_SOFT,
              marginTop: 28,
              maxWidth: 760,
              lineHeight: 1.4,
            }}
          >
            US equities trade on Robinhood Chain as tokens that never rebase. Veltr Agent reads what
            your wallet cannot.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `1px solid ${LINE}`,
            paddingTop: 26,
            fontSize: 22,
            color: INK_FAINT,
          }}
        >
          <span>veltragent.com</span>
          <span>Every figure fetched, never inferred</span>
        </div>
      </div>
    ),
    size
  );
}
