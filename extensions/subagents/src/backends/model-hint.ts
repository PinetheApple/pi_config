/**
 * pi model-hint resolution and its self-correcting error text.
 *
 * A spawn whose `model` hint misses is only useful to the parent model if the
 * rejection names what it could have said instead, so every failure carries
 * the concrete `provider/id` values the registry would accept.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/** The slice of `ModelRegistry` model resolution actually needs. */
export interface ModelLookup {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
}

/** Enough for the model to choose well; short enough to not swamp the result. */
const MAX_LISTED_MODELS = 24;

const qualify = (model: Model<Api>) => `${model.provider}/${model.id}`;

/**
 * Every id a hint could name, preferring the models this session can actually
 * authenticate against and falling back to the full registry when none are.
 */
export function availablePiModelIds(registry: ModelLookup) {
  const usable = registry.getAvailable();
  const source = usable.length > 0 ? usable : registry.getAll();
  return [...new Set(source.map(qualify))].sort();
}

/** `a/x, b/y (+3 more)` — deduped, sorted, capped. */
function formatChoices(ids: readonly string[]) {
  const shown = ids.slice(0, MAX_LISTED_MODELS);
  const hidden = ids.length - shown.length;
  return `${shown.join(", ")}${hidden > 0 ? ` (+${hidden} more)` : ""}`;
}

function unknownModelError(registry: ModelLookup, hint: string) {
  const ids = availablePiModelIds(registry);
  if (ids.length === 0) {
    return new Error(
      `Unknown model "${hint}". No models are configured in this session's registry.`,
    );
  }
  return new Error(
    `Unknown model "${hint}". Available models: ${formatChoices(ids)}.`,
  );
}

function ambiguousModelError(hint: string, matches: readonly Model<Api>[]) {
  const ids = [...new Set(matches.map(qualify))].sort();
  return new Error(
    `Model "${hint}" exists in multiple providers. Use one of: ${formatChoices(ids)}.`,
  );
}

/**
 * Resolve the generic model hint against the parent registry (v1 semantics):
 * "provider/model-id" is exact; a bare id prefers the inherited provider,
 * then must be unambiguous across providers. No hint inherits the parent
 * model; with nothing to inherit, the SDK default applies.
 */
export function resolvePiModel(
  registry: ModelLookup,
  hint: string | undefined,
  inherited: { provider: string; id: string } | undefined,
) {
  if (!hint) {
    if (!inherited) return undefined;
    return registry.find(inherited.provider, inherited.id) ?? undefined;
  }
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw unknownModelError(registry, hint);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((m) => m.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw ambiguousModelError(hint, matches);
  throw unknownModelError(registry, hint);
}
