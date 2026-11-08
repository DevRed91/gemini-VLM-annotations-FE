import { normalizeLabel } from "../spatial/ObjectMatcher.ts";
import type { SearchQuery } from "../spatial/types.ts";

export type LocalQueryParseResult =
  | { readonly ok: true; readonly query: SearchQuery }
  | { readonly ok: false; readonly reason: string };

const ATTRIBUTE_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  red: ["color", "red"], blue: ["color", "blue"], green: ["color", "green"],
  yellow: ["color", "yellow"], orange: ["color", "orange"], purple: ["color", "purple"],
  pink: ["color", "pink"], black: ["color", "black"], white: ["color", "white"],
  brown: ["color", "brown"], gray: ["color", "gray"], grey: ["color", "gray"],
  beige: ["color", "beige"], wood: ["material", "wood"], wooden: ["material", "wood"],
  marble: ["material", "marble"], brass: ["material", "brass"], metal: ["material", "metal"],
  metallic: ["material", "metal"], glass: ["material", "glass"], leather: ["material", "leather"],
  fabric: ["material", "fabric"], plastic: ["material", "plastic"], ceramic: ["material", "ceramic"],
  round: ["shape", "round"], circular: ["shape", "round"], rectangular: ["shape", "rectangular"],
  square: ["shape", "square"], oval: ["shape", "oval"], spherical: ["shape", "spherical"],
};

const COMMAND_PREFIXES = ["look for ", "search for ", "where is ", "find ", "search ", "show ", "locate "];
const NON_TARGET_WORDS = new Set(["in", "scene"]);

function singularize(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Parses a deliberately small local-search vocabulary. Unknown words remain
 * part of the label, so the deterministic matcher can decide whether that
 * complete phrase exists in the current annotation inventory.
 */
export function parseLocalQuery(message: string): LocalQueryParseResult {
  if (typeof message !== "string" || !message.trim()) {
    return { ok: false, reason: "Enter an object to search for, such as “chair”." };
  }

  let normalized = normalizeLabel(message);
  if (!normalized) {
    return { ok: false, reason: "Enter an object name, such as “chair”." };
  }

  for (const prefix of COMMAND_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }

  normalized = normalized
    .replace(/\s+in the scene$/, "")
    .replace(/\s+(?:annotated\s+)?(?:objects?|items?)$/, "");

  let quantifier: SearchQuery["quantifier"] = "all";
  const words = normalized.split(" ").filter(Boolean);
  if (["all", "every"].includes(words[0])) {
    quantifier = "all";
    words.shift();
  } else if (["one", "the", "a", "an"].includes(words[0])) {
    quantifier = "one";
    words.shift();
  }
  if (words[0] === "annotated") words.shift();

  const attributes: Record<string, string> = {};
  const labelWords: string[] = [];
  for (const word of words) {
    const attribute = ATTRIBUTE_WORDS[word];
    if (attribute) {
      const [key, value] = attribute;
      const previous = attributes[key];
      if (previous && previous !== value) {
        return {
          ok: false,
          reason: `I found conflicting ${key} terms. Please describe one ${key} or search by the object name.`,
        };
      }
      attributes[key] = value;
    } else if (!NON_TARGET_WORDS.has(word)) {
      labelWords.push(singularize(word));
    }
  }

  const label = labelWords.join(" ");
  if (!label && Object.keys(attributes).length === 0) {
    return {
      ok: false,
      reason: "I couldn't identify an object name. Try a label such as “chair” or “wooden table”.",
    };
  }

  return {
    ok: true,
    query: {
      ...(label ? { label } : {}),
      ...(Object.keys(attributes).length ? { attributes } : {}),
      quantifier,
    },
  };
}

const SEARCH_ATTRIBUTE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  color: {
    red: "red", blue: "blue", green: "green", yellow: "yellow", orange: "orange",
    purple: "purple", pink: "pink", black: "black", white: "white", brown: "brown",
    gray: "gray", grey: "gray", beige: "beige",
  },
  material: {
    wood: "wood", wooden: "wood", marble: "marble", brass: "brass", metal: "metal",
    metallic: "metal", glass: "glass", leather: "leather", fabric: "fabric",
    plastic: "plastic", ceramic: "ceramic",
  },
  shape: {
    round: "round", circular: "round", rectangular: "rectangular",
    square: "square", oval: "oval", spherical: "spherical",
  },
};

/** Infer only explicit color/material terms from the label and VLM description. */
export function deriveSearchAttributes(label: string, description?: string): Record<string, string> {
  const words = new Set(normalizeLabel(`${label} ${description ?? ""}`).split(" ").filter(Boolean));
  const derived: Record<string, string> = {};
  for (const [key, vocabulary] of Object.entries(SEARCH_ATTRIBUTE_WORDS)) {
    const values = new Set<string>();
    for (const word of words) {
      const value = vocabulary[word];
      if (value) values.add(value);
    }
    // Conflicting mentions are too uncertain to turn into a searchable fact.
    if (values.size === 1) derived[key] = [...values][0];
  }
  return derived;
}
