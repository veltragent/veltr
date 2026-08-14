import { createPublicClient, http, toFunctionSelector } from "viem";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const client = createPublicClient({ transport: http(env.VELTR_RPC_URL, { batch: true, timeout: 40_000 }) });

const V4_POSM = "0x58daec3116aae6D93017bAAea7749052E8a04fA7";
const V3_POSM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";

const SIGS = [
  // v3
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
  "function collect((uint256,address,uint128,uint128))",
  "function burn(uint256)",
  // v4
  "function getPoolAndPositionInfo(uint256) view returns ((address,address,uint24,int24,address),uint256)",
  "function getPositionLiquidity(uint256) view returns (uint128)",
  "function modifyLiquidities(bytes,uint256)",
  "function modifyLiquiditiesWithoutUnlock(bytes,bytes[])",
  "function poolManager() view returns (address)",
  // shared
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function nextTokenId() view returns (uint256)",
];

for (const [name, addr] of [["Uniswap V4 PositionManager", V4_POSM], ["Uniswap V3 PositionManager", V3_POSM]]) {
  const code = await client.getCode({ address: addr });
  console.log(`\n=== ${name} (${(code.length - 2) / 2} bytes) ===`);
  console.log(`    ${addr}`);
  for (const sig of SIGS) {
    const sel = toFunctionSelector(sig).slice(2);
    if (code.includes(sel)) console.log(`   has  ${sig.slice(0, 88)}`);
  }
}

// Confirm the v4 PositionManager points at the PoolManager we already identified.
try {
  const pm = await client.readContract({
    address: V4_POSM,
    abi: [{ type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "poolManager",
  });
  console.log("\nv4 PositionManager.poolManager() =", pm);
  console.log("  matches known PoolManager:", pm.toLowerCase() === "0x8366a39cc670b4001a1121b8f6a443a643e40951");
} catch (e) {
  console.log("\npoolManager() read failed:", e.shortMessage ?? e.message);
}
