"use client";

import { useState } from "react";

const PROMPTS = [
  "Summarise every active multiplier on the chain right now.",
  "Which tokens would misreport my balance today, and by how much?",
  "Explain what a 4.0 multiplier means for someone holding that token.",
  "Is any corporate action scheduled but not yet effective?",
];

export function AgentPanel() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask(q: string) {
    if (!q.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Agent unavailable.");
      setAnswer(json.answer);
      setSource(json.source);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-paper p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-[family-name:var(--font-display)] text-[1.35rem] tracking-[-0.01em] text-ink">
          Ask the agent
        </h3>
        <p className="text-[12px] text-ink-faint">Answers are grounded in the live chain read above</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="mt-5 flex gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What changed on-chain, and what does it mean for my position?"
          className="flex-1 rounded-lg border border-line bg-cream px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Reading…" : "Ask"}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => {
              setQuestion(p);
              ask(p);
            }}
            disabled={loading}
            className="rounded-full border border-line px-3 py-1 text-[12px] text-ink-soft transition-colors hover:border-accent-line hover:text-accent-deep disabled:opacity-40"
          >
            {p}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-5 rounded-lg border border-alert/20 bg-alert-tint px-4 py-3 text-[13px] text-alert">
          {error}
        </p>
      )}

      {answer && (
        <div className="mt-5 rounded-lg border border-line-soft bg-cream p-5">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">{answer}</p>
          {source && (
            <p className="mt-4 border-t border-line-soft pt-3 text-[11px] text-ink-faint">
              {source === "deterministic"
                ? "Generated from chain state directly — no model key configured."
                : `Narrated by ${source}, grounded in the chain read.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
