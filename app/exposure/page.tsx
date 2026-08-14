import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow } from "@/components/primitives";
import { ExposureAudit } from "@/components/exposure-audit";
import { getSnapshot } from "@/lib/snapshot";
import { fetchTokenHolders } from "@/lib/blockscout";

export const revalidate = 300;

export const metadata = {
  title: "Exposure Audit — Veltr",
  description:
    "Compare raw balanceOf against true ERC-8056 exposure for any address holding stock tokens on Robinhood Chain.",
};

/**
 * Picks a live wallet that actually holds a token with a non-unit multiplier,
 * so the demo shows a real discrepancy rather than a contrived one.
 */
async function findExampleHolder(): Promise<string | null> {
  const result = await getSnapshot();
  if (!result.ok) return null;

  const drifted = result.snapshot.tokens
    .filter((t) => t.severity !== "clear" && t.holders > 100)
    .sort((a, b) => Math.abs(b.reportingErrorPct) - Math.abs(a.reportingErrorPct));

  for (const token of drifted.slice(0, 3)) {
    const holders = await fetchTokenHolders(token.address);
    // Prefer an EOA — a pool contract's position is less illustrative.
    const eoa = holders.find((h) => !h.address.is_contract) ?? holders[0];
    if (eoa) return eoa.address.hash;
  }
  return null;
}

export default async function ExposurePage() {
  const exampleAddress = await findExampleHolder().catch(() => null);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14">
        <div className="max-w-2xl">
          <Eyebrow>Holder-level reconciliation</Eyebrow>
          <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
            What your wallet is not telling you
          </Display>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            Veltr reads both values for every stock token an address holds: the raw ERC-20 balance
            that wallets and trackers display, and the ERC-8056 effective balance that represents
            actual underlying exposure. Where they disagree, the difference is real ownership that
            standard tooling omits.
          </p>
        </div>

        <div className="mt-10">
          <ExposureAudit exampleAddress={exampleAddress} />
        </div>

        <section className="mt-16 rounded-xl border border-line bg-paper-edge/50 p-7">
          <h2 className="font-[family-name:var(--font-display)] text-[1.4rem] tracking-[-0.01em] text-ink">
            Where this matters most
          </h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            {[
              {
                title: "Tax preparation",
                body: "Self-custodied stock tokens generate no broker statement. A basis calculation built from transfer history alone will not reconcile once a multiplier has been applied.",
              },
              {
                title: "Collateral sizing",
                body: "If a lending position was sized against a raw balance, the assumed and actual headroom differ. Reconcile before the next action lands, not after.",
              },
              {
                title: "Portfolio accounting",
                body: "Two trackers reading the same wallet can report different holdings depending on whether either implements ERC-8056. Only one of them is right.",
              },
            ].map((item) => (
              <div key={item.title}>
                <h3 className="text-[14px] font-medium text-ink">{item.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{item.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
