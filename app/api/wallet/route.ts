import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { buildRadarSnapshot } from "@/lib/tokens";
import { readHolderBalances, WAD } from "@/lib/chain";
import { findLpPositions } from "@/lib/lp-positions";

export const revalidate = 30;

/**
 * Exposure audit for one holder.
 *
 * The point of this endpoint is the gap between `raw` and `effective`: it is the
 * exact quantity of underlying exposure that a wallet UI, a portfolio tracker or
 * a tax report reading plain `balanceOf` is failing to account for.
 */
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address")?.trim();

  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "Provide a valid EVM address." }, { status: 400 });
  }

  try {
    const snapshot = await buildRadarSnapshot();
    const tokenByAddress = new Map(snapshot.tokens.map((t) => [t.address.toLowerCase(), t]));

    const balances = await readHolderBalances(
      address as Address,
      snapshot.tokens.map((t) => t.address)
    );

    const positions = balances
      .filter((b) => b.raw > 0n)
      .map((b) => {
        const token = tokenByAddress.get(b.address.toLowerCase())!;
        const scale = 10 ** token.decimals;
        const raw = Number(b.raw) / scale;
        // Fall back to the local multiplier if balanceOfUI is unavailable.
        const effective =
          b.effective > 0n ? Number(b.effective) / scale : raw * token.multiplier;
        const unreported = effective - raw;

        return {
          symbol: token.symbol,
          name: token.name,
          address: token.address,
          iconUrl: token.iconUrl,
          priceUsd: token.priceUsd,
          multiplier: token.multiplier,
          severity: token.severity,
          rawBalance: raw,
          effectiveBalance: effective,
          unreportedShares: unreported,
          unreportedUsd: token.priceUsd ? unreported * token.priceUsd : null,
          valueUsd: token.priceUsd ? effective * token.priceUsd : null,
          pendingMultiplier: token.pendingMultiplier,
          effectiveAt: token.effectiveAt,
          actionDeltaPct: token.actionDeltaPct,
        };
      })
      .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

    const misreported = positions.filter((p) => Math.abs(p.unreportedShares) > 1e-12);

    // Liquidity positions are the only place a corporate action can actively
    // take value from a holder, so they are reported alongside the balances.
    const stockTokenMap = new Map(
      snapshot.tokens.map((t) => [t.address.toLowerCase(), t.symbol])
    );
    const lpPositions = await findLpPositions(address as Address, stockTokenMap).catch(() => []);

    return NextResponse.json({
      address,
      positions,
      lpPositions,
      summary: {
        positionCount: positions.length,
        portfolioUsd: positions.reduce((s, p) => s + (p.valueUsd ?? 0), 0),
        misreportedCount: misreported.length,
        unreportedUsd: misreported.reduce((s, p) => s + (p.unreportedUsd ?? 0), 0),
        pendingActions: positions.filter((p) => p.pendingMultiplier !== null && p.actionDeltaPct !== null).length,
        lpPositionCount: lpPositions.length,
      },
      wad: WAD.toString(),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[veltr] wallet audit failed:", error);
    return NextResponse.json({ error: "Chain read failed." }, { status: 502 });
  }
}
