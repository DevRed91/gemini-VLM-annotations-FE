/**
 * Configurable synonym dictionary for object search, kept strictly separate
 * from the matching algorithm (`ObjectMatcher.ts`).
 *
 * Entries are directional data — a VARIANT label mapped to its CANONICAL
 * label — and are applied through the same normalization and folding on both
 * the query side and the registered-label side, so searching for `couch`
 * finds `Sofa` (and `Couch`) without folding any categories that are not
 * explicitly listed. Extend the defaults via `SearchOptions.synonyms`
 * (spread `DEFAULT_SYNONYMS` to append entries).
 */

export type SynonymMap = Readonly<Record<string, string>>;

export const DEFAULT_SYNONYMS: SynonymMap = Object.freeze({
  couch: "sofa",
});

/**
 * Folds an already-normalized label to its canonical form by repeatedly
 * following the dictionary (single step per entry, chains allowed:
 * `loveseat -> couch -> sofa`). The lookup maps normalized label ->
 * normalized canonical label (built by the matcher).
 *
 * Fail-safe on malformed dictionaries: if the chain from the label is
 * cyclic (including self-mappings), the label is left unchanged rather
 * than folded into an ambiguous intermediate form.
 */
export function foldSynonyms(
  normalized: string,
  lookup: ReadonlyMap<string, string>,
): string {
  let current = normalized;
  const visited = new Set<string>([current]);
  for (;;) {
    const next = lookup.get(current);
    if (next === undefined) return current;
    if (visited.has(next)) return normalized; // cyclic chain: no folding
    visited.add(next);
    current = next;
  }
}
