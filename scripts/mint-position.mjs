/**
 * Opens a minimal single-sided Uniswap V3 position for the delegator.
 *
 * Single-sided is the point: a normal position needs both assets, which would
 * mean acquiring a stock token first. If the range sits entirely above the
 * current tick and WETH is token0, the position is funded with WETH alone — so
 * wrapping a little native ETH is the whole capital requirement.
 *
 * Three transactions: wrap, approve, mint. Run with --execute to broadcast.
 */
import { createWalletClient, createPublicClient, http, defineChain, parseAbi, parseEther, formatEther } from "viem";
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

const POSM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const POOL = "0xa9188730Fe85Be88ad499D7d52B099e800fB0334"; // 0.3% tier, spacing 60
const FEE = 3000;
const SPACING = 60;

/** Small enough to be trivial, large enough that the position is real. */
const WRAP_AMOUNT = parseEther("0.0004");

const EXECUTE = process.argv.includes("--execute");

const account = privateKeyToAccount(env.VELTR_DELEGATOR_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });

const wethAbi = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const poolAbi = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"]);
const posmAbi = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
]);

console.log("SINGLE-SIDED V3 POSITION");
console.log("─".repeat(64));
console.log("  owner    ", account.address);
console.log("  pool     ", POOL, `(WETH/USDG ${FEE / 10000}%)`);

const [balance, slot0, wethBalance] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.readContract({ address: POOL, abi: poolAbi, functionName: "slot0" }),
  publicClient.readContract({ address: WETH, abi: wethAbi, functionName: "balanceOf", args: [account.address] }),
]);

const currentTick = Number(slot0[1]);

/**
 * Range placement decides which asset funds the position. WETH is token0 here,
 * so a range strictly above the current tick is WETH-only — one tick spacing of
 * clearance keeps it out of range even if the price ticks up between
 * simulation and inclusion.
 */
const tickLower = Math.ceil((currentTick + SPACING) / SPACING) * SPACING;
const tickUpper = tickLower + SPACING * 10;

console.log("  ETH      ", formatEther(balance));
console.log("  WETH     ", formatEther(wethBalance));
console.log("  tick     ", currentTick);
console.log("  range    ", tickLower, "→", tickUpper, "(entirely above spot: WETH-only)");
console.log("  wrapping ", formatEther(WRAP_AMOUNT), "ETH");

if (balance < WRAP_AMOUNT * 2n) {
  console.log("\n  Balance too low to wrap and still pay gas.");
  process.exit(1);
}

if (!EXECUTE) {
  console.log("\nDRY RUN — nothing broadcast. Re-run with --execute.");
  process.exit(0);
}

const wait = async (hash, label) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${receipt.status} (block ${receipt.blockNumber})`);
  return receipt;
};

if (wethBalance < WRAP_AMOUNT) {
  console.log("\n[1/3] wrapping ETH…");
  await wait(
    await wallet.writeContract({ address: WETH, abi: wethAbi, functionName: "deposit", value: WRAP_AMOUNT, gas: 100_000n }),
    "wrap"
  );
} else {
  console.log("\n[1/3] already holds enough WETH, skipping wrap");
}

const allowance = await publicClient.readContract({
  address: WETH, abi: wethAbi, functionName: "allowance", args: [account.address, POSM],
});

if (allowance < WRAP_AMOUNT) {
  console.log("[2/3] approving PositionManager…");
  await wait(
    await wallet.writeContract({ address: WETH, abi: wethAbi, functionName: "approve", args: [POSM, WRAP_AMOUNT * 10n], gas: 100_000n }),
    "approve"
  );
} else {
  console.log("[2/3] allowance already sufficient");
}

console.log("[3/3] minting position…");
const mintHash = await wallet.writeContract({
  address: POSM,
  abi: posmAbi,
  functionName: "mint",
  args: [{
    token0: WETH,
    token1: USDG,
    fee: FEE,
    tickLower,
    tickUpper,
    amount0Desired: WRAP_AMOUNT,
    amount1Desired: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: account.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
  }],
  gas: 800_000n,
});
const receipt = await wait(mintHash, "mint");

if (receipt.status !== "success") {
  console.log("\n  Mint reverted. Nothing else to do.");
  process.exit(1);
}

// Read the id back from the NFT rather than parsing logs.
const count = await publicClient.readContract({ address: POSM, abi: posmAbi, functionName: "balanceOf", args: [account.address] });
const tokenId = await publicClient.readContract({
  address: POSM, abi: posmAbi, functionName: "tokenOfOwnerByIndex", args: [account.address, count - 1n],
});

console.log("\n  POSITION OPENED");
console.log("  tokenId  ", tokenId.toString());
console.log("  explorer  https://robinhoodchain.blockscout.com/tx/" + mintHash);
console.log("\n  Next: npx tsx scripts/test-redemption.mjs");
