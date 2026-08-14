// A real mission, end to end: live model, live tools, live chain.
//
// Runs in a temporary working directory so it cannot touch the running
// instance's state file, and in read_only permission mode so nothing can act.
//
//   node --env-file=.env.local --import ./tests/resolve-ts.mjs scripts/probe-mission.mjs
//
// Spends real credit: several model calls and several tool calls.

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "veltr-mission-probe-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);

const { startMission } = await import("../lib/agent/run.ts");
const { renderResult, statusLine } = await import("../lib/agent/format.ts");
const { routeTools, availableTools } = await import("../lib/agent/router.ts");
const { riskOf, requiresApproval } = await import("../lib/agent/policy.ts");

const line = (t) => console.log(`\n${"─".repeat(72)}\n${t}\n`);

const objective =
  process.argv.slice(2).join(" ") ||
  "investigate why NVDA is trading at a premium or discount to its underlying stock right now";

line("1. Tool routing for this objective");
const tools = await availableTools();
const routed = routeTools(objective, tools);
console.log(`  registry: ${tools.length} tools`);
console.log(`  signals:  ${routed.tags.join(", ") || "(none)"}`);
console.log(`  routed:   ${routed.tools.map((t) => t.name).join(", ")}`);
console.log(`  withheld: ${tools.length - routed.tools.length} tools never reach the model`);

line("2. Permission gate, as configured");
for (const name of ["get_price", "web_search", "send_chart", "set_alert_scope", "defend_position", "unknown_future_tool"]) {
  const risk = riskOf(name);
  console.log(
    `  ${name.padEnd(20)} risk=${risk.padEnd(7)} auto_low_risk→${
      requiresApproval(risk, "auto_low_risk") ? "ASKS" : "runs"
    }  read_only→${requiresApproval(risk, "read_only") ? "ASKS" : "runs"}`
  );
}

line("3. Running the mission (read_only: it can observe, it cannot act)");
console.log(`  objective: ${objective}\n`);

const started = Date.now();
const result = await startMission({
  ownerId: "probe",
  objective,
  permissionMode: "read_only",
  onStatus: (status) => console.log(`  [${((Date.now() - started) / 1000).toFixed(1)}s] ${status}`),
});

if (!result.ok) {
  console.log("  refused:", result.error);
  process.exit(1);
}

const mission = result.mission;

line("4. What it observed");
for (const entry of mission.evidence) {
  console.log(`  [${entry.id}] ${entry.tool} ${JSON.stringify(entry.args)} — ${entry.ok ? "ok" : "FAILED"}`);
  console.log(`        ${entry.summary.slice(0, 160).replace(/\s+/g, " ")}…`);
}

line("5. Result as the user receives it");
console.log(renderResult(mission));

line("6. Accounting");
console.log(`  state:       ${mission.state}`);
console.log(`  status:      ${statusLine(mission)}`);
console.log(`  iterations:  ${mission.iterations}`);
console.log(`  tool calls:  ${mission.toolCalls}`);
console.log(`  observations:${mission.evidence.length}`);
console.log(`  elapsed:     ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  cited:       ${mission.result?.evidenceIds.join(", ") || "(none)"}`);
console.log(`  confidence:  ${mission.result?.confidence ?? "not claimed"}`);

// Every cited id must exist. This is the anti-hallucination invariant, checked
// against a real model rather than a scripted one.
const known = new Set(mission.evidence.map((e) => e.id));
const dangling = (mission.result?.evidenceIds ?? []).filter((id) => !known.has(id));
console.log(`  citations:   ${dangling.length === 0 ? "all resolve" : `DANGLING: ${dangling.join(", ")}`}`);

line("Done.");
