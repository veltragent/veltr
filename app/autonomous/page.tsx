import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, StatTile } from "@/components/primitives";
import {
  DELEGATES,
  DEFENSIVE_POLICY,
  readDelegationStatus,
  verifyDelegateDeployed,
} from "@/lib/autonomous";
import { shortAddress } from "@/lib/format";

export const revalidate = 60;

export const metadata = {
  title: "Autonomous — Veltr",
  description:
    "How Veltr executes on your behalf under EIP-7702: a session key that can only reduce risk, on an implementation that needs no initialization.",
};

function delegatorAddress(): Address | null {
  const key = process.env.VELTR_DELEGATOR_PRIVATE_KEY;
  if (!key) return null;
  try {
    return privateKeyToAccount(key as Address).address;
  } catch {
    return null;
  }
}

export default async function AutonomousPage() {
  const address = delegatorAddress();
  const [implementations, status] = await Promise.all([
    Promise.all(DELEGATES.map(verifyDelegateDeployed)).catch(() => []),
    address ? readDelegationStatus(address).catch(() => null) : Promise.resolve(null),
  ]);

  const scoped = implementations.filter((i) => i.deployed && i.scopedPermissions).length;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14">
        <div className="max-w-2xl">
          <Eyebrow>Autonomous tier · live on mainnet</Eyebrow>
          <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
            A key that can only give things back
          </Display>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            The median warning window on this chain is about ten minutes. No one watches a screen for
            that. Veltr can hold a scoped key and act inside the window — but only in the direction
            of less risk, and only ever returning assets to the account that granted it.
          </p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          <StatTile
            tone="accent"
            label="Contracts Veltr deploys"
            value="0"
            detail="Every delegate below is an audited implementation already live on this chain"
          />
          <StatTile
            label="Scoped implementations live"
            value={String(scoped)}
            detail="Verified deployed on Robinhood Chain"
          />
          <StatTile
            label="Worst case if the key leaks"
            value="Position closed"
            detail="Not drained — funds can only move to the owner"
          />
        </div>

        {/* --------------------------------------------------- The policy */}
        <section className="mt-12 rounded-xl bg-ink p-8 text-paper">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-paper/60">
            Session key authority, as data
          </p>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-paper/85">
            {DEFENSIVE_POLICY.intent}
          </p>

          <div className="mt-7 grid gap-8 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-paper/50">
                Permitted
              </p>
              <ul className="mt-4 space-y-3">
                {DEFENSIVE_POLICY.allowedActions.map((a) => (
                  <li key={a.selector} className="text-[13px] leading-relaxed">
                    <span className="tnum text-paper">{a.selector}</span>
                    <span className="block text-paper/60">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-paper/50">
                Invariants
              </p>
              <ul className="mt-4 space-y-2.5">
                {DEFENSIVE_POLICY.invariants.map((inv) => (
                  <li key={inv} className="flex gap-2.5 text-[13px] leading-relaxed text-paper/80">
                    <span className="text-paper/40">—</span>
                    {inv}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="mt-8 border-t border-paper/15 pt-5 text-[13px] leading-relaxed text-paper/70">
            {DEFENSIVE_POLICY.worstCaseIfCompromised}
          </p>
        </section>

        {/* ------------------------------------------- Why 7702, not 4337 */}
        <section className="mt-12 grid gap-8 lg:grid-cols-2">
          <div>
            <Eyebrow>Why EIP-7702</Eyebrow>
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-[1.45rem] leading-tight tracking-[-0.01em] text-ink">
              Your address does not change
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              An ERC-4337 smart account has a new address. Users would have to migrate existing
              liquidity and lending positions before Veltr could protect any of them — which defeats
              the purpose. EIP-7702 lets the account you already use delegate to contract logic while
              keeping its address, so Veltr acts on positions you hold today.
            </p>
          </div>
          <div>
            <Eyebrow>Why a stateless implementation</Eyebrow>
            <h2 className="mt-3 font-[family-name:var(--font-display)] text-[1.45rem] leading-tight tracking-[-0.01em] text-ink">
              An initializer is a race
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
              Delegation and initialization are separate transactions. An implementation requiring{" "}
              <code className="tnum text-accent-deep">initialize()</code> leaves a window in which
              anyone can initialize the freshly delegated account and seize it. Probing bytecode on
              this chain showed ZeroDev Kernel carries an initializer and the MetaMask stateless
              delegator does not — so the stateless one is used. There is no window to lose.
            </p>
          </div>
        </section>

        {/* --------------------------------------------- Implementations */}
        <section className="mt-12">
          <Eyebrow>Delegate implementations</Eyebrow>
          <div className="mt-5 overflow-hidden rounded-xl border border-line bg-paper">
            <div className="hidden grid-cols-[1.6fr_1fr_1fr_2.4fr] gap-4 border-b border-line bg-paper-edge/60 px-5 py-3 lg:grid">
              {["Implementation", "Deployed", "Scoping", "Note"].map((h) => (
                <p key={h} className="eyebrow">
                  {h}
                </p>
              ))}
            </div>
            {implementations.map((impl, i) => (
              <div
                key={impl.key}
                className={`grid gap-2 px-5 py-4 lg:grid-cols-[1.6fr_1fr_1fr_2.4fr] lg:items-center lg:gap-4 ${
                  i > 0 ? "border-t border-line-soft" : ""
                }`}
              >
                <div>
                  <p className="text-[14px] font-medium text-ink">{impl.name}</p>
                  <p className="tnum text-[11px] text-ink-faint">{shortAddress(impl.address)}</p>
                </div>
                <p className="tnum text-[13px] text-ink-soft">
                  {impl.deployed ? `${impl.codeSize.toLocaleString()} B` : "—"}
                </p>
                <p className="text-[13px] text-ink-soft">
                  {impl.scopedPermissions ? "Scoped keys" : "None"}
                </p>
                <p className="text-[13px] leading-relaxed text-ink-muted">{impl.note}</p>
              </div>
            ))}
          </div>
        </section>

        {/* --------------------------------------------------- Live status */}
        <section className="mt-12 rounded-xl border border-line bg-paper-edge/50 p-7">
          <Eyebrow>Reference account — live</Eyebrow>
          <dl className="mt-5 grid gap-5 sm:grid-cols-4">
            <div>
              <dt className="text-[12px] text-ink-muted">Address</dt>
              <dd className="tnum mt-1 text-[13px] text-ink">
                {status ? shortAddress(status.address) : "not configured"}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-muted">Balance</dt>
              <dd className="tnum mt-1 text-[13px] text-ink">
                {status ? `${status.balanceEth.toFixed(6)} ETH` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-muted">Delegated</dt>
              <dd className="mt-1 text-[13px] text-ink">
                {status ? (status.delegated ? "Yes" : "Not yet") : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-muted">Delegate</dt>
              <dd className="tnum mt-1 text-[13px] text-ink">
                {status?.delegateName ?? (status?.delegateAddress ? shortAddress(status.delegateAddress) : "none")}
              </dd>
            </div>
          </dl>
        </section>

        <p className="mt-10 rounded-lg border border-line bg-paper px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink-soft">Status.</span> Live on mainnet, and
          demonstrated rather than described. The reference account delegates under EIP-7702, two
          scoped delegations are signed, and the session key has executed a real redemption —
          withdrawing all liquidity from a Uniswap V3 position through the DelegationManager while
          the owner signed nothing. A call to any contract outside the allow-list is refused by
          name: <code className="tnum text-accent-deep">AllowedTargetsEnforcer:target-address-not-allowed</code>.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}
