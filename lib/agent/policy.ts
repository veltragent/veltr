import type { PermissionMode, RiskLevel } from "./types";

/**
 * Risk classification and the permission rule.
 *
 * Kept out of the tool registry on purpose. The registry describes what a tool
 * does so a model can choose it; this file decides what a tool is allowed to do
 * unattended, and that decision needs to be readable in one place by someone
 * auditing the agent rather than scattered across six hundred lines of handlers.
 *
 * The registry's own `acts` flag is used as a floor — a tool that declares itself
 * an action can never be classified as a read here, whatever this table says.
 */

/**
 * Everything that only reads.
 *
 * Not consulted for tools that declare `acts`, so a tool that gains a side effect
 * later cannot be quietly demoted by an entry in this list.
 */
const LOW_RISK = new Set([
  "get_price",
  "token_lookup",
  "get_token",
  "search_tokens",
  "get_news",
  "get_market",
  "compare_premiums",
  "get_wallet_exposure",
  "get_corporate_actions",
  "get_announced_splits",
  "get_analyst_view",
  "get_alert_status",
  "get_onchain_detail",
  "list_chain_tokens",
  "get_recent_trades",
  "get_global_crypto",
  "get_crypto_asset",
  "web_search",
  "deep_search",
  "read_url",
  "repo_map",
  "github_repo",
  "github_files",
  "github_read_file",
  "github_search_code",
  "get_delegation_status",
  "read_attached_file",
  "list_owned_positions",
]);

/**
 * Changes something the caller owns, and can be undone by the caller.
 *
 * A chart in their own chat, a file sent to them, the scope of their own alerts.
 * None of these are visible outside the conversation they belong to and none of
 * them touch an asset.
 */
const MEDIUM_RISK = new Set(["send_chart", "set_alert_scope", "create_file", "write_code"]);

/**
 * Consequential: moves funds, is irreversible, or is visible outside this system.
 *
 * `defend_position` withdraws liquidity from a real Uniswap position through the
 * EIP-7702 session key. It is defensive and cannot send funds anywhere but the
 * delegating account, and it is still not something an agent may do because it
 * inferred that it should.
 */
const HIGH_RISK = new Set(["defend_position"]);

/**
 * Classifies a tool.
 *
 * Unknown tools are high risk. This is the single most important line in the
 * file: a tool added next month that nobody remembered to classify must not
 * become autonomously callable by default. Fail closed.
 */
export function riskOf(tool: string, declaresAction = false): RiskLevel {
  if (HIGH_RISK.has(tool)) return "high";
  if (MEDIUM_RISK.has(tool)) return "medium";
  if (LOW_RISK.has(tool)) return declaresAction ? "medium" : "low";
  return "high";
}

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto_low_risk";

/**
 * May this run without asking?
 *
 * High risk always asks, in every mode, with no override anywhere in the
 * codebase. Autonomy is granted over reversible, caller-owned changes only —
 * an agent that can spend or destroy on its own judgement is not more capable,
 * it is unsupervised.
 */
export function requiresApproval(risk: RiskLevel, mode: PermissionMode): boolean {
  if (risk === "high") return true;
  if (risk === "low") return false;
  return mode !== "auto_low_risk";
}

/** Explains the gate in the user's terms, for the approval prompt. */
export function describeRisk(risk: RiskLevel): string {
  switch (risk) {
    case "low":
      return "reads data, changes nothing";
    case "medium":
      return "changes something in your chat, reversible";
    default:
      return "consequential — funds, deletion, or something visible outside this chat";
  }
}
