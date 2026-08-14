import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const client = createPublicClient({ transport: http(env.VELTR_RPC_URL, { timeout: 40_000 }) });

const delegator = privateKeyToAccount(env.VELTR_DELEGATOR_PRIVATE_KEY);
const session = privateKeyToAccount(env.VELTR_SESSION_PRIVATE_KEY);

console.log("=== funding status ===");
for (const [label, acct] of [["delegator", delegator], ["session key", session]]) {
  const bal = await client.getBalance({ address: acct.address });
  console.log(`  ${label.padEnd(12)} ${acct.address}  ${(Number(bal) / 1e18).toFixed(6)} ETH`);
}

// Candidate EIP-7702 delegate implementations. Using a deployed, audited one
// avoids writing a fund-handling contract for this project.
const CANDIDATES = {
  "Simple7702Account (eth-infinitism, ships with EntryPoint v0.8)":
    "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
  "ZeroDev Kernel v3.1": "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28",
  "ZeroDev Kernel v3.3": "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28",
  "Alchemy ModularAccountV2": "0x00000000000017c61b5bEe81050EC8eFc9c6fecd",
  "Safe 4337 Module": "0xa581c4A4DB7175302464fF3C06380BC3270b4037",
  "Biconomy Nexus": "0x000000004F43C49e93C970E84001853a70923B03",
  "Metamask Delegator (EIP7702StatelessDeleGator)":
    "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
};

console.log("\n=== delegate implementations deployed on chain 4663 ===");
for (const [name, address] of Object.entries(CANDIDATES)) {
  try {
    const code = await client.getCode({ address });
    const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    console.log(`  ${size > 0 ? "YES" : "no "}  ${String(size).padStart(6)}B  ${name}`);
    if (size > 0) console.log(`             ${address}`);
  } catch (e) {
    console.log(`  err       ${name}: ${e.shortMessage ?? e.message}`);
  }
}

console.log("\n=== does the chain accept type-4 (EIP-7702) transactions? ===");
try {
  const auth = await delegator.signAuthorization({
    chainId: 4663,
    address: "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
    nonce: 0,
  });
  console.log("  authorization signed locally OK");
  console.log(`    chainId=${auth.chainId} nonce=${auth.nonce} yParity=${auth.yParity}`);
} catch (e) {
  console.log("  signAuthorization failed:", e.shortMessage ?? e.message);
}
