import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow } from "@/components/primitives";

export const metadata = {
  title: "Method — Veltr",
  description:
    "How Veltr discovers stock tokens, reads ERC-8056 multiplier state, and scopes autonomous execution under EIP-7702.",
};

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line py-14 first:border-t-0 first:pt-0">
      <Eyebrow>{eyebrow}</Eyebrow>
      <Display className="mt-4 max-w-2xl text-[clamp(1.6rem,3vw,2.15rem)]">{title}</Display>
      <div className="mt-6 max-w-3xl space-y-4 text-[15px] leading-relaxed text-ink-soft">
        {children}
      </div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-paper p-5 text-[13px] leading-relaxed text-ink">
      <code className="tnum">{children}</code>
    </pre>
  );
}

export default function MethodPage() {
  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14">
        <div className="max-w-2xl pb-6">
          <Eyebrow>Technical method</Eyebrow>
          <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
            How Veltr reads the chain
          </Display>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            Every figure on this site is derived from Robinhood Chain mainnet state. Nothing is
            estimated, sampled, or backfilled from a third-party index.
          </p>
        </div>

        <Section eyebrow="01 · Discovery" title="Tokens are found by interface, not by list">
          <p>
            Robinhood publishes stock tokens continuously, so a hardcoded address list goes stale.
            Veltr enumerates ERC-20 contracts on the chain and probes each one for the ERC-8056
            interface. A contract that answers{" "}
            <code className="tnum text-accent-deep">uiMultiplier()</code> is a stock token. The
            coverage set therefore extends itself as Robinhood lists new symbols.
          </p>
          <Code>{`function uiMultiplier()    view returns (uint256)
function newUIMultiplier() view returns (uint256)
function effectiveAt()     view returns (uint256)
function balanceOfUI(address) view returns (uint256)

event UIMultiplierUpdated(
    uint256 oldMultiplier,
    uint256 newMultiplier,
    uint256 effectiveAtTimestamp
)`}</Code>
        </Section>

        <Section eyebrow="02 · The mechanism" title="Corporate actions move a multiplier, never a balance">
          <p>
            Stock tokens do not rebase. A split or reinvested dividend updates an on-chain
            multiplier while every holder&apos;s raw balance stays byte-for-byte identical. True
            exposure is a derived quantity:
          </p>
          <Code>{`underlyingShares = rawBalance × uiMultiplier ÷ 1e18`}</Code>
          <p>
            This design is excellent for contracts — no balance rewrites, no unbounded loops — and
            hazardous for anything that displays a number to a person. An interface calling plain{" "}
            <code className="tnum text-accent-deep">balanceOf</code> is correct only while the
            multiplier is exactly 1.0.
          </p>
        </Section>

        <Section eyebrow="03 · Early warning" title="A scheduled action is readable before it lands">
          <p>
            The pair <code className="tnum text-accent-deep">newUIMultiplier()</code> and{" "}
            <code className="tnum text-accent-deep">effectiveAt()</code> expose an action that is
            committed on-chain but not yet in force. This is the entire basis for acting in advance:
            the window between commitment and effect is the only period in which a position can be
            adjusted with full knowledge of what is coming.
          </p>
          <p>
            Because these actions are scheduled rather than adversarial, detection does not require
            low-latency infrastructure. A polling interval measured in seconds is sufficient, and
            there is no ordering race to lose.
          </p>
        </Section>

        <Section eyebrow="04 · Execution" title="EIP-7702, scoped so that compromise is survivable">
          <p>
            Autonomous execution uses EIP-7702 delegation rather than an ERC-4337 smart account.
            The distinction is practical: a 4337 account has a new address, which would require
            users to migrate existing lending and liquidity positions before Veltr could protect
            them. EIP-7702 lets an existing externally-owned account delegate to contract logic
            while keeping its address, so Veltr can act on positions a user already holds.
          </p>
          <p>
            The delegation is signed and its caveats are enforced by contracts already deployed on
            this chain. Scope as it actually stands:
          </p>
          <Code>{`allowed target     Uniswap V3 PositionManager (only)
allowed selectors  decreaseLiquidity, collect, burn
recipient          pinned to the delegating account
native value       0 wei
expiry             30 days
redemptions        50 maximum`}</Code>
          <p>
            Uniswap V4 is deliberately excluded. Argument-level enforcement pins a value at a fixed
            byte offset, which reaches V3&apos;s <code className="tnum text-accent-deep">collect</code>{" "}
            recipient but not V4&apos;s, where the recipient sits inside a variable-length action
            blob. Including it would leave a path where funds could be sent elsewhere, so one fully
            constrained venue is used rather than two with a gap.
          </p>
          <p>
            The key cannot open a position, cannot increase leverage, cannot approve a spender, and
            cannot name a recipient other than the owner. This is demonstrated rather than asserted:
            a simulated call to an unlisted contract is refused by name —{" "}
            <code className="tnum text-accent-deep">AllowedTargetsEnforcer:target-address-not-allowed</code>{" "}
            — while a permitted call passes every caveat and reaches Uniswap.
          </p>
        </Section>

        <Section eyebrow="05 · Sources" title="What each figure comes from">
          <ul className="space-y-3">
            {[
              ["Multiplier state, effective timestamps, balances", "Direct eth_call against Robinhood Chain mainnet, batched through Multicall3"],
              ["Token discovery, holder counts, USD price, 24h volume, logos", "Blockscout public API — no key required"],
              ["Chain identity", "Robinhood Chain · Arbitrum Orbit L2 · Ethereum blob data availability"],
              ["Agent narration", "Free-tier Groq or Gemini, constrained to the chain read above; falls back to deterministic output when no key is present"],
            ].map(([label, source]) => (
              <li key={label} className="grid gap-1 border-b border-line-soft pb-3 sm:grid-cols-[1fr_1.2fr] sm:gap-6">
                <span className="text-ink">{label}</span>
                <span className="text-[14px] text-ink-muted">{source}</span>
              </li>
            ))}
          </ul>
          <p className="text-[14px] text-ink-muted">
            The public RPC endpoint is rate-limited and documented as unsuitable for production
            traffic. Set <code className="tnum text-accent-deep">VELTR_RPC_URL</code> to a dedicated
            provider before deploying.
          </p>
        </Section>

        <Section eyebrow="06 · Limits" title="What this tool does not claim">
          <p>
            Veltr reports chain state and the arithmetic that follows from it. It does not forecast
            prices, evaluate securities, or recommend positions. Stock tokens on Robinhood Chain are
            debt securities rather than equity, and holders receive no shareholder rights — a legal
            distinction this tool surfaces but does not interpret.
          </p>
          <p>
            Corporate-action timing is coordinated by Robinhood as issuer. Chainlink does not publish
            a corporate-action calendar for these assets, so any action not yet committed to{" "}
            <code className="tnum text-accent-deep">newUIMultiplier</code> is not visible on-chain to
            Veltr or to anyone else.
          </p>
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}
