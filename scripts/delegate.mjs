/**
 * Performs the EIP-7702 delegation on Robinhood Chain mainnet.
 *
 * Target is the MetaMask EIP7702StatelessDeleGator, chosen because probing its
 * bytecode showed no initialize() — the account's authority derives from its own
 * address. An implementation that requires initialization (ZeroDev Kernel does)
 * leaves a window between delegation and init in which anyone can initialize the
 * account and seize it. Stateless removes that window entirely.
 *
 * Run with --execute to broadcast. Without it, prints the plan and exits.
 */
import { createWalletClient, createPublicClient, http, defineChain, size, slice, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.VELTR_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

const DELEGATE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B"; // EIP7702StatelessDeleGator
const EXECUTE = process.argv.includes("--execute");

const account = privateKeyToAccount(env.VELTR_DELEGATOR_PRIVATE_KEY);
const sessionKey = privateKeyToAccount(env.VELTR_SESSION_PRIVATE_KEY);

const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ account, chain, transport: http() });

const readDelegation = async (address) => {
  const code = await publicClient.getCode({ address });
  if (code && code.startsWith("0xef0100") && size(code) === 23) {
    return getAddress(slice(code, 3));
  }
  return null;
};

console.log("EIP-7702 DELEGATION PLAN");
console.log("─".repeat(64));
console.log("  chain            Robinhood Chain mainnet (4663)");
console.log("  delegating EOA  ", account.address);
console.log("  delegate impl   ", DELEGATE);
console.log("                   MetaMask EIP7702StatelessDeleGator (no initialize)");
console.log("  session key     ", sessionKey.address, "(not installed by this step)");

const [balance, gasPrice, nonce, current] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.getGasPrice(),
  publicClient.getTransactionCount({ address: account.address }),
  readDelegation(account.address),
]);

console.log("  balance         ", (Number(balance) / 1e18).toFixed(8), "ETH");
console.log("  nonce           ", nonce);
console.log("  gas price       ", (Number(gasPrice) / 1e9).toFixed(6), "gwei");
console.log("  current delegate", current ?? "none — plain EOA");
console.log("");
console.log("  effect: the EOA gains the implementation's code. Its private key");
console.log("          retains full control. Delegation is revocable by");
console.log("          re-delegating to the zero address.");
console.log("");

if (current && current.toLowerCase() === DELEGATE.toLowerCase()) {
  console.log("Already delegated to this implementation. Nothing to do.");
  process.exit(0);
}

if (!EXECUTE) {
  console.log("DRY RUN — nothing broadcast. Re-run with --execute to send.");
  process.exit(0);
}

// Self-executing delegation: the authorization nonce must be the account's
// nonce + 1, because the transaction carrying it consumes the current one.
// viem's `executor: "self"` applies that offset.
const authorization = await walletClient.signAuthorization({
  account,
  contractAddress: DELEGATE,
  executor: "self",
});

console.log("authorization signed:");
console.log("   chainId", authorization.chainId, "| nonce", authorization.nonce, "| yParity", authorization.yParity);
console.log("");
console.log("broadcasting…");

// Explicit gas limit: estimation on this node returns the 21,000 base cost and
// ignores EIP-7702's PER_EMPTY_ACCOUNT_COST (25,000 per authorization), so an
// estimated transaction is rejected as "intrinsic gas too low".
const hash = await walletClient.sendTransaction({
  authorizationList: [authorization],
  to: account.address,
  value: 0n,
  data: "0x",
  gas: 200_000n,
});

console.log("  tx", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log("  status:", receipt.status, "| block", receipt.blockNumber, "| gas used", receipt.gasUsed.toString());
console.log("  cost  :", (Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18).toFixed(8), "ETH");
console.log("");

const after = await readDelegation(account.address);
console.log("VERIFICATION");
console.log("  code at EOA now delegates to:", after ?? "nothing");
console.log("  matches intended implementation:", after?.toLowerCase() === DELEGATE.toLowerCase());
console.log("  explorer: https://robinhoodchain.blockscout.com/tx/" + hash);
