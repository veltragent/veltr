/**
 * Which delegate implementations are stateless?
 *
 * EIP-7702 delegation and initialization are separate transactions unless
 * bundled atomically. An implementation that REQUIRES initialize() leaves a
 * window in which anyone can initialize the freshly-delegated account and take
 * ownership. A stateless implementation derives its owner from the account
 * address itself, so there is no window and nothing to race.
 */
import { createPublicClient, http, toFunctionSelector } from "viem";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const client = createPublicClient({ transport: http(env.VELTR_RPC_URL, { timeout: 40_000 }) });

const TARGETS = {
  "Simple7702Account": "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
  "MetaMask StatelessDeleGator": "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
  "ZeroDev Kernel": "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28",
  "Alchemy ModularAccountV2": "0x00000000000017c61b5bEe81050EC8eFc9c6fecd",
};

// Presence of a selector in runtime bytecode is strong evidence the function exists.
const SIGS = [
  "function initialize(bytes21,address,bytes,bytes,bytes[])",
  "function initialize(address)",
  "function initialize(bytes)",
  "function initializeAccount(bytes)",
  "function owner() view returns (address)",
  "function entryPoint() view returns (address)",
  "function execute(address,uint256,bytes)",
  "function execute(bytes32,bytes)",
  "function executeBatch((address,uint256,bytes)[])",
  "function redeemDelegations(bytes[],uint8[],bytes[][])",
  "function isValidSignature(bytes32,bytes) view returns (bytes4)",
];

for (const [name, address] of Object.entries(TARGETS)) {
  const code = await client.getCode({ address });
  console.log(`\n=== ${name} (${(code.length - 2) / 2} bytes) ===`);
  for (const sig of SIGS) {
    const sel = toFunctionSelector(sig).slice(2);
    if (code.includes(sel)) console.log(`   has  ${sig}`);
  }
}
