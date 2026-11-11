/**
 * Word-form helpers shared by the object matcher and the local query parser:
 * deterministic singularization and guarded compound-word splitting.
 *
 * Compound splitting bridges unspaced wording on both sides of a search. A
 * chat query like "Round Table Marbletop" still intends a label such as
 * "Round marble tabletop", so both the query and the registered label
 * decompose "tabletop" into `table + top` before whole-phrase matching.
 *
 * The split is deliberately vocabulary-guarded to preserve the Phase 1
 * no-false-positives boundary: a token only decomposes when its TAIL is one
 * of the curated part words below. That is what keeps "table" unable to
 * reach the unrelated words it merely contains: "tablet" (tail "t"),
 * "stable" ("ble") and "carpet" ("pet") never decompose. Heads are
 * intentionally NOT vocabulary-checked — that is what lets the query word
 * "table" meet a "tabletop" label without "table" being registered
 * anywhere. Residual false positives are deliberately limited to adjacent
 * readings ("cup"/"teapot"-style heads before a listed tail), which extend
 * the vocabulary by only adding rare, verified part words.
 */

// Explicit `.ts` extensions: these modules must stay runnable under Node
// type stripping (unit tests, no bundler), unlike DOM-bound viewer code.

/** Deterministic singularization, shared with `LocalQueryParser` (moved there). */
export function singularize(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Singularizes each word in an already-normalized phrase. */
export function singularizePhrase(normalized: string): string {
  return normalized.split(" ").map(singularize).join(" ");
}

/** Both halves of a split compound must be at least this long. */
const MIN_COMPOUND_PART_LENGTH = 3;
/** At most this many tokens may come out of one compound word. */
const MAX_COMPOUND_PARTS = 3;

/**
 * Curated compound tail words (part words that close household/object-name
 * compounds, singular). Extend only with rare, verified part words; every
 * listed tail invites reads of the head as a match target (e.g. "table"
 * inside "sidetable").
 */
const COMPOUND_TAILS: ReadonlySet<string> = new Set([
  "base", "box", "chair", "cover", "handle", "lamp", "leg", "light",
  "mat", "pad", "pot", "rest", "seat", "shade", "shelf", "side",
  "stand", "table", "top", "tray",
]);

export type CompoundSplit = readonly [head: string, tail: string];

/**
 * Splits a single token into head + tail when it ends in a known compound
 * tail (longest tail wins), returning `null` for tokens too short to carry
 * two parts of `MIN_COMPOUND_PART_LENGTH`, or with no known tail.
 */
export function splitCompound(token: string): CompoundSplit | null {
  if (token.length < MIN_COMPOUND_PART_LENGTH * 2) return null;
  for (
    let tailLength = token.length - MIN_COMPOUND_PART_LENGTH;
    tailLength >= MIN_COMPOUND_PART_LENGTH;
    tailLength--
  ) {
    const tail = token.slice(-tailLength);
    if (!COMPOUND_TAILS.has(tail)) continue;
    return [token.slice(0, token.length - tailLength), tail];
  }
  return null;
}

/**
 * Fully decomposes one token into part tokens (at most `MAX_COMPOUND_PARTS`).
 * Plain words pass through unchanged, so raw labels are never mutated;
 * registered compound plurals ("tabletops") split through their
 * singular form while plain plurals ("glasses") stay whole.
 */
function explodeCompound(token: string, parts: number): string[] {
  if (parts <= 1) return [token];
  const split = splitCompound(token) ??
    (token.endsWith("s") && !token.endsWith("ss")
      ? splitCompound(token.slice(0, -1))
      : null);
  if (!split) return [token];
  return [...explodeCompound(split[0], parts - 1), split[1]];
}

/**
 * Splits a normalized (single-space) phrase into part tokens, decomposing
 * compound words on both sides of a search: "round marble tabletop"
 * becomes `round, marble, table, top`. Input must already be normalized
 * via `normalizeLabel`.
 */
export function decomposePhrase(normalized: string): string[] {
  const tokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (!token) continue;
    tokens.push(...explodeCompound(token, MAX_COMPOUND_PARTS));
  }
  return tokens;
}
