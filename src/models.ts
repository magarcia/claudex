import * as v from "valibot";

import { AnthropicHttpError } from "./anthropic/errors.ts";
import type { CodexModel } from "./codex/client.ts";

export const CODEX_PREFIX = "codex/";
const LARGE_CONTEXT_SUFFIX = "[1m]";
const LARGE_CONTEXT_TOKENS = 1_000_000;
const descriptions = new Map([
  ["sol", "For coding and everyday work"],
  ["astra", "For your most demanding tasks"],
  ["terra", "For focused coding tasks"],
  ["luna", "Fast and affordable for quick tasks"],
]);
const NativeModel = v.looseObject({
  id: v.string(),
  type: v.literal("model"),
  display_name: v.string(),
  created_at: v.string(),
});
export const NativeCatalogPage = v.object({
  data: v.array(NativeModel),
  has_more: v.boolean(),
  last_id: v.nullable(v.string()),
});
export type Model = v.InferOutput<typeof NativeModel>;

function codingRelease(id: string) {
  const match = /^gpt-?(\d+(?:\.\d+)*)-([a-z]+)$/u.exec(id);
  const versionText = match?.[1];
  const family = match?.[2];
  if (!versionText || !family || !descriptions.has(family)) return;
  const version = versionText.split(".").map(Number);
  if (!version.every(Number.isSafeInteger) || (version[0] ?? 0) < 6) return;
  return { family, version };
}

function newerVersion(candidate: number[], current: number[]): boolean {
  for (let index = 0; index < Math.max(candidate.length, current.length); index++) {
    const difference = (candidate[index] ?? 0) - (current[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function selectCodingModels(models: CodexModel[]): CodexModel[] {
  const latest = new Map<string, { model: CodexModel; version: number[] }>();
  for (const model of models) {
    const release = codingRelease(model.id);
    if (!release) continue;
    const current = latest.get(release.family);
    if (!current || newerVersion(release.version, current.version)) {
      latest.set(release.family, { model, version: release.version });
    }
  }
  return [...latest.values()].map(({ model }) => model);
}

export function codexModelDescription(model: CodexModel): string | undefined {
  const release = codingRelease(model.id);
  return (release && descriptions.get(release.family)) ?? model.description;
}

export function codexModelId(publicModel: string): string {
  return publicModel.slice(CODEX_PREFIX.length).replace(/\[1m\]$/iu, "");
}

export function codexModels(models: CodexModel[]) {
  return selectCodingModels(models).flatMap((model) => {
    const base = codexModel(model);
    return (model.contextWindow ?? 0) >= LARGE_CONTEXT_TOKENS
      ? [
          base,
          {
            ...base,
            id: `${base.id}${LARGE_CONTEXT_SUFFIX}`,
            display_name: `${base.display_name} (1M context)`,
          },
        ]
      : [base];
  });
}

export function requireCodexModel(id: string, models: CodexModel[]) {
  const available = codexModels(models);
  const normalized = id.replace(/\[1m\]$/iu, LARGE_CONTEXT_SUFFIX);
  const model = available.find((model) => model.id === normalized);
  if (model) return model;
  const choices = available.length
    ? `Available models: ${available.map((model) => model.id).join(", ")}.`
    : "No supported coding models are available. Run claudex doctor.";
  throw new AnthropicHttpError(404, `Unknown Codex model ${JSON.stringify(id)}. ${choices}`);
}

function codexModel(model: CodexModel) {
  const description = codexModelDescription(model);
  return {
    id: `${CODEX_PREFIX}${model.id}`,
    type: "model",
    display_name: model.displayName,
    ...(description ? { description } : {}),
    created_at: "1970-01-01T00:00:00.000Z",
  } satisfies Model;
}

export function modelPage(models: Model[], query: URLSearchParams) {
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (
    (rawLimit !== null && !/^\d+$/u.test(rawLimit)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new AnthropicHttpError(400, "`limit` must be an integer from 1 to 1000.");
  }
  const after = query.get("after_id");
  const before = query.get("before_id");
  if (after !== null && before !== null)
    throw new AnthropicHttpError(400, "Use either after_id or before_id.");
  const cursor = after ?? before;
  const index = cursor === null ? -1 : models.findIndex((model) => model.id === cursor);
  if (cursor !== null && index < 0)
    throw new AnthropicHttpError(400, "The model cursor is not in this catalog.");
  const candidates =
    after !== null ? models.slice(index + 1) : before !== null ? models.slice(0, index) : models;
  const data = before === null ? candidates.slice(0, limit) : candidates.slice(-limit);
  return {
    data,
    has_more: candidates.length > limit,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}
