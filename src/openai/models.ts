const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function isEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/**
 * Many apps can pick a model but cannot send `reasoning_effort`, so a suffix
 * like `gpt-5.5-high` selects the effort. An explicit field wins over the suffix.
 */
export function resolveModel(
  requested: string,
  explicitEffort?: unknown,
): { model: string; effort?: string } {
  const dash = requested.lastIndexOf("-");
  const suffix = requested.slice(dash + 1);
  const base = requested.slice(0, dash);
  const fromSuffix = dash > 0 && isEffort(suffix) ? suffix : undefined;
  const model = fromSuffix ? base : requested;
  // Codex supports custom effort strings; the backend validates model-specific values.
  const effort =
    typeof explicitEffort === "string" && explicitEffort.trim() ? explicitEffort : fromSuffix;
  return effort ? { model, effort } : { model };
}
