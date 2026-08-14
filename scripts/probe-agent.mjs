// The §30 scenarios, against the live model and the live tool registry.
//
//   node --env-file=.env.local --import ./tests/resolve-ts.mjs scripts/probe-agent.mjs [letter]
//
// Spends real credit. chatId is omitted so no message can reach a real chat.

import { runAgentLoop } from "../lib/agent-loop.ts";
import { classifyDepth } from "../lib/agent/orchestration.ts";

const SCENARIOS = {
  A: { name: "Simple", q: "What is 2 + 2?" },
  B: { name: "Repository", q: "Inspect the repository vercel/swr and explain its architecture." },
  C: { name: "Market", q: "What is NVDA trading at right now, and what is the premium?" },
  D: { name: "Complex", q: "Investigate why the premium on tokenised stocks might be negative right now." },
  E: { name: "Multi-tool", q: "Research the AI token on this chain and compare its market data across sources." },
  F: { name: "Unknown", q: "Place a market buy order for 10 NVDA tokens on my behalf." },
};

const only = (process.argv[2] || "").toUpperCase();
const chosen = only ? { [only]: SCENARIOS[only] } : SCENARIOS;

for (const [letter, scenario] of Object.entries(chosen)) {
  if (!scenario) continue;

  const plan = classifyDepth(scenario.q);
  console.log(`\n${"═".repeat(74)}`);
  console.log(`TEST ${letter} — ${scenario.name}`);
  console.log(`  "${scenario.q}"`);
  console.log(`  classified: ${plan.depth} (${plan.maxRounds} rounds, ${plan.toolBudget} tools)`);
  console.log("─".repeat(74));

  const started = Date.now();
  const seen = [];

  const result = await runAgentLoop(scenario.q, {}, null, (tool) => {
    if (tool !== "__thinking__") seen.push(tool);
  }).catch((e) => ({ answer: `THREW: ${e.message}`, toolsUsed: [], rounds: 0, source: "error" }));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n  tools : ${result.toolsUsed.join(", ") || "(none)"}`);
  console.log(`  rounds: ${result.rounds} | ${elapsed}s | ${result.source}`);
  console.log(`\n${result.answer}\n`);
}

console.log("═".repeat(74));
