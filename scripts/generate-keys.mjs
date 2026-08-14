/**
 * Generates the two keypairs the autonomous tier needs, locally.
 *
 * Prints addresses only. Private keys are appended to .env.local and never
 * written to stdout — anything printed here could end up pasted into a chat log,
 * which is exactly how keys leak.
 *
 * Run once. Re-running is a no-op if the keys already exist.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const ENV_PATH = new URL("../.env.local", import.meta.url);

const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";

function ensure(name, current) {
  const match = current.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (match) {
    return { key: match[1].trim(), created: false };
  }
  return { key: generatePrivateKey(), created: true };
}

const delegator = ensure("VELTR_DELEGATOR_PRIVATE_KEY", existing);
const sessionKey = ensure("VELTR_SESSION_PRIVATE_KEY", existing);

const delegatorAccount = privateKeyToAccount(delegator.key);
const sessionAccount = privateKeyToAccount(sessionKey.key);

let next = existing;
const additions = [];

if (delegator.created) {
  additions.push(
    "",
    "# ---------------------------------------------------------------------------",
    "# Autonomous tier — generated locally, never transmitted.",
    "# ---------------------------------------------------------------------------",
    "# The test account that delegates via EIP-7702. Fund this one with gas.",
    `VELTR_DELEGATOR_PRIVATE_KEY=${delegator.key}`
  );
}
if (sessionKey.created) {
  additions.push(
    "# The scoped key Veltr signs with. Holds no funds and needs none.",
    `VELTR_SESSION_PRIVATE_KEY=${sessionKey.key}`
  );
}

if (additions.length) {
  next = existing.replace(/\s*$/, "") + "\n" + additions.join("\n") + "\n";
  writeFileSync(ENV_PATH, next, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(ENV_PATH, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

console.log("");
console.log("  DELEGATOR (fund this address with gas)");
console.log(`    ${delegatorAccount.address}`);
console.log(`    ${delegator.created ? "newly generated" : "already existed — reused"}`);
console.log("");
console.log("  SESSION KEY (Veltr signs with this; needs no funds)");
console.log(`    ${sessionAccount.address}`);
console.log(`    ${sessionKey.created ? "newly generated" : "already existed — reused"}`);
console.log("");
console.log("  Private keys written to .env.local only (gitignored, mode 600).");
console.log("  They were not printed and must never be pasted anywhere.");
