import { ImageResponse } from "next/og";

/**
 * The card the homepage renders as when its link is shared.
 *
 * The claim, and no live figures at all.
 *
 * The first version carried a count of tracked tokens. Rendering it showed "44
 * stock tokens tracked" while every other read on the same machine said 95 —
 * because an image like this is prerendered at build time, and that build had
 * caught a partial chain read. A number baked in at build is not live; it is
 * whatever the build machine happened to see, published as fact and frozen
 * there until something revalidates it.
 *
 * The market card can carry live rows because it is about a number that moves
 * and it revalidates every minute. This one is about something that does not
 * move, so there is nothing here to get wrong.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Veltr Agent — your balance is fixed, your ownership is not";
export const revalidate = false;

const INK = "#1f1a14";
const PAPER = "#faf6ee";
const SOFT = "#8b7c68";

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
          background: PAPER,
          color: INK,
          padding: "72px",
          fontFamily: "Georgia, serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 22, letterSpacing: 4, color: SOFT, textTransform: "uppercase" }}>
          Veltr Agent
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 76, lineHeight: 1.05, maxWidth: 900 }}>
            Your balance is fixed. Your ownership is not.
          </div>
          <div style={{ display: "flex", fontSize: 28, color: SOFT, marginTop: 26, maxWidth: 860 }}>
            US equities trade on Robinhood Chain as tokens that never rebase. Veltr Agent reads what
            your wallet cannot.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: SOFT }}>
          <div style={{ display: "flex" }}>veltragent.com</div>
          <div style={{ display: "flex" }}>Every figure fetched, never inferred</div>
        </div>
      </div>
    ),
    size
  );
}
