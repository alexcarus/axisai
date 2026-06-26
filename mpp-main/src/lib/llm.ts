// ---------------------------------------------------------------------------
// AXIS AI — in-browser inference provider.
//
// To mine the `inference_text` work type with *real* AI computation (rather than
// a canned sample), the miner calls a model provider the user connects: OpenAI
// (ChatGPT) or Anthropic (Claude). The user supplies their own API key; it is
// stored only in this browser (localStorage) and sent directly to the provider —
// AXIS never sees it. The generated text becomes the Proof-of-AI-Work output the
// gateway verifies and rewards.
// ---------------------------------------------------------------------------

export type LlmProvider = "openai" | "anthropic";

export type LlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  model: string;
};

export const PROVIDER_LABEL: Record<LlmProvider, string> = {
  openai: "ChatGPT (OpenAI)",
  anthropic: "Claude (Anthropic)",
};

// Sensible defaults. Anthropic defaults to the latest Opus; OpenAI to a fast,
// low-cost model well-suited to a high-frequency miner. Both are editable.
export const DEFAULT_MODEL: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-opus-4-8",
};

const STORAGE_KEY = "axis-llm-config";

export function loadLlmConfig(): LlmConfig | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<LlmConfig>;
    if (
      (c.provider === "openai" || c.provider === "anthropic") &&
      typeof c.apiKey === "string" &&
      c.apiKey.trim()
    ) {
      return {
        provider: c.provider,
        apiKey: c.apiKey.trim(),
        model: (c.model && c.model.trim()) || DEFAULT_MODEL[c.provider],
      };
    }
  } catch {
    /* ignore malformed config */
  }
  return null;
}

export function saveLlmConfig(config: LlmConfig | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (config) localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage may be unavailable (private mode) */
  }
}

// Topic seeds keep successive submissions distinct (so outputs aren't identical)
// while staying on-topic for the text-inference scorer.
const TOPICS = [
  "verifiable AI computation",
  "neural network inference",
  "language model reasoning",
  "machine learning training",
  "proof-of-AI-work mining",
  "model evaluation and quality",
  "deterministic on-chain rewards",
  "semantic coherence in text generation",
];

/** Builds a prompt whose completion scores well as coherent text inference. */
export function buildMiningPrompt(): string {
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  return (
    "You are performing an AI text-inference benchmark for a Proof-of-AI-Work " +
    "miner. Write two to three clear, coherent, grammatically correct English " +
    `sentences (at least 30 words total) about ${topic}. The response must be ` +
    "accurate, well structured, semantically consistent, and directly relevant. " +
    "Output only the sentences — no preamble, labels, or quotation marks."
  );
}

async function runOpenAI(
  cfg: LlmConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 160,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 140)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new Error("OpenAI: empty completion");
  return text.trim();
}

async function runAnthropic(
  cfg: LlmConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      // Required for direct browser calls (enables CORS for the Messages API).
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 160,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 140)}`);
  }
  const data = await res.json();
  // content is an array of blocks; concatenate the text blocks.
  const text: string = Array.isArray(data?.content)
    ? data.content
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b.text ?? "")
        .join(" ")
        .trim()
    : "";
  if (!text) throw new Error("Anthropic: empty completion");
  return text;
}

/** Runs one real inference and returns the generated text. */
export async function runInference(
  cfg: LlmConfig,
  prompt: string,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    return cfg.provider === "openai"
      ? await runOpenAI(cfg, prompt, ctrl.signal)
      : await runAnthropic(cfg, prompt, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}
