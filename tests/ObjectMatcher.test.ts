/**
 * Phase 1 object-matcher unit tests plus a registry-integration suite that
 * exercises the real `SpatialObjectRegistry` (cluster-fitted and pin-only
 * registrations) through the matcher's structural inventory contract.
 *
 * Run: `npm test` (equivalent to `node --test tests/`).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { normalizeLabel, searchObjects } from "../src/spatial/ObjectMatcher.ts";
import { DEFAULT_SYNONYMS, foldSynonyms } from "../src/spatial/synonyms.ts";
import {
  hasFittedGeometry,
  spatialGeometryKind,
  type SearchableObject,
} from "../src/spatial/types.ts";
import { OBB } from "../src/utils/obb.ts";
import { SpatialObjectRegistry } from "../src/utils/spatialObjectRegistry.ts";

function obj(
  objectId: string,
  semanticLabel: string,
  attributes: SearchableObject["attributes"] = {},
): SearchableObject {
  return { objectId, semanticLabel, attributes };
}

const SOFA = obj("annotation-1", "Sofa", { obb: "cluster" });
const WOODEN_TABLE = obj("annotation-2", "Dining Table", {
  material: "wood",
  obb: "cluster",
});
const LAMP = obj("annotation-3", "Floor Lamp", { material: "brass", obb: "point" });

/** A standard three-object scene: sofa, wooden dining table, point-only lamp. */
function scene(): SearchableObject[] {
  return [SOFA, WOODEN_TABLE, LAMP];
}

describe("label normalization", () => {
  test("exact, case, and whitespace handling", () => {
    assert.equal(normalizeLabel("sofa"), "sofa");
    assert.equal(normalizeLabel("SOFA"), "sofa");
    assert.equal(normalizeLabel("Sofa"), "sofa");
    assert.equal(normalizeLabel(" sofa "), "sofa");
    assert.equal(normalizeLabel("\tSofa\n"), "sofa");
    assert.equal(normalizeLabel("Dining  Table"), "dining table");
    assert.equal(normalizeLabel("   "), "");
  });

  test("punctuation normalization", () => {
    assert.equal(normalizeLabel("dining-table"), "dining table");
    assert.equal(normalizeLabel("Dining Table."), "dining table");
    assert.equal(normalizeLabel("Sofa!"), "sofa");
    assert.equal(normalizeLabel("Dining_Table"), "dining table");
    assert.equal(normalizeLabel("///"), "");
  });

  test("apostrophe folding preserves possessives", () => {
    assert.equal(normalizeLabel("CHILD’S chair"), "child's chair");
    assert.equal(normalizeLabel("child's chair"), "child's chair");
  });

  test("non-string input is absent, not an error", () => {
    assert.equal(normalizeLabel(undefined), "");
    assert.equal(normalizeLabel(42), "");
    assert.equal(normalizeLabel(null), "");
  });
});

describe("label matching", () => {
  test("exact match after normalization only", () => {
    const result = searchObjects(scene(), { label: "sofa" });
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-1"]);
  });

  test("case-insensitive match", () => {
    assert.deepEqual(
      searchObjects(scene(), { label: "SOFA" }).annotationIds,
      ["annotation-1"],
    );
  });

  test("leading/trailing and repeated whitespace match", () => {
    assert.deepEqual(
      searchObjects(scene(), { label: "  Sofa  " }).annotationIds,
      ["annotation-1"],
    );
    assert.deepEqual(
      searchObjects(scene(), { label: "Dining  Table" }).annotationIds,
      ["annotation-2"],
    );
  });

  test("punctuation-only differences match", () => {
    assert.deepEqual(
      searchObjects(scene(), { label: "dining-table." }).annotationIds,
      ["annotation-2"],
    );
  });

  test("unrelated labels do not match", () => {
    const result = searchObjects(scene(), { label: "bed" });
    assert.equal(result.status, "no-match");
    assert.deepEqual(result.annotationIds, []);
    assert.equal(result.matchCount, 0);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  });
});

describe("synonyms", () => {
  test("couch finds sofa", () => {
    assert.deepEqual(
      searchObjects(scene(), { label: "couch" }).annotationIds,
      ["annotation-1"],
    );
  });

  test("registered variant labels fold the same way", () => {
    // Both sides fold through the dictionary, so a Sofa query also returns
    // records explicitly labeled "Couch" (documented symmetric-fold choice).
    const result = searchObjects(
      [obj("annotation-1", "Couch"), obj("annotation-2", "Sofa")],
      { label: "sofa" },
    );
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-1", "annotation-2"]);
  });

  test("custom synonyms replace the built-in dictionary and support chains", () => {
    const custom = { couch: "sofa", loveseat: "couch" };
    const inventory = [obj("annotation-1", "Sofa"), LAMP];
    // "loveseat" chains loveseat -> couch -> sofa.
    assert.deepEqual(
      searchObjects(inventory, { label: "loveseat" }, { synonyms: custom })
        .annotationIds,
      ["annotation-1"],
    );
    // Replacing defaults removes built-in entries that were not re-listed.
    assert.equal(
      searchObjects(inventory, { label: "couch" }, { synonyms: { loveseat: "couch" } })
        .status,
      "no-match",
    );
  });

  test("synonym folding applies to labels, never attribute values", () => {
    const inventory = [obj("annotation-1", "Sofa", { material: "fabric" })];
    const result = searchObjects(
      inventory,
      { attributes: { material: "textile" } },
      { synonyms: { textile: "fabric" } },
    );
    assert.equal(result.status, "no-match");
  });

  test("DEFAULT_SYNONYMS is a frozen minimal dictionary", () => {
    assert.deepEqual({ ...DEFAULT_SYNONYMS }, { couch: "sofa" });
    assert.throws(() => {
      (DEFAULT_SYNONYMS as Record<string, string>).couch = "bed";
    }, TypeError);
  });

  test("cycle guard and self-mapping cannot loop", () => {
    const lookup = new Map([
      ["couch", "sofa"],
      ["sofa", "couch"],
      ["sessel", "sessel"],
    ]);
    assert.equal(foldSynonyms("couch", lookup), "couch");
    assert.equal(foldSynonyms("sessel", lookup), "sessel");
    assert.equal(foldSynonyms("table", lookup), "table");
  });
});

describe("attributes", () => {
  test("single attribute match", () => {
    const result = searchObjects(scene(), {
      attributes: { material: "wood" },
    });
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-2"]);
  });

  test("multiple attributes use AND semantics", () => {
    // The dining table has no `finish` at all: AND fails on the missing key.
    assert.equal(
      searchObjects(scene(), {
        attributes: { material: "wood", finish: "oak" },
      }).status,
      "no-match",
    );

    const inventory = [
      obj("annotation-1", "Table", { material: "wood", finish: "oak" }),
      obj("annotation-2", "Table", { material: "wood", finish: "walnut" }),
    ];
    assert.deepEqual(
      searchObjects(inventory, {
        attributes: { material: "wood", finish: "oak" },
      }).annotationIds,
      ["annotation-1"],
    );
    assert.deepEqual(
      searchObjects(inventory, {
        attributes: { material: "wood", finish: "walnut" },
      }).annotationIds,
      ["annotation-2"],
    );
  });

  test("missing attributes are not successful matches", () => {
    const result = searchObjects(scene(), {
      attributes: { material: "steel" },
    });
    assert.equal(result.status, "no-match");

    // The lamp registers no material key at all.
    assert.deepEqual(
      searchObjects(scene(), { attributes: { fabric: "linen" } }).annotationIds,
      [],
    );
  });

  test("case and whitespace normalization of keys and values", () => {
    assert.deepEqual(
      searchObjects(scene(), {
        attributes: { " Material ": "  wood " },
      }).annotationIds,
      ["annotation-2"],
    );
  });

  test("numeric and boolean stored values match string queries", () => {
    const inventory = [
      obj("annotation-1", "Shelf", { shelves: 2 }),
      obj("annotation-2", "Door", { locked: true }),
    ];
    assert.deepEqual(
      searchObjects(inventory, { attributes: { shelves: "2" } }).annotationIds,
      ["annotation-1"],
    );
    assert.deepEqual(
      searchObjects(inventory, { attributes: { locked: "true" } }).annotationIds,
      ["annotation-2"],
    );
  });

  test("null stored values never match and unknown keys are ignored", () => {
    const inventory = [
      obj("annotation-1", "Table", { material: null, obb: "cluster" }),
    ];
    assert.equal(
      searchObjects(inventory, { attributes: { material: "null" } }).status,
      "no-match",
    );
    // Unrelated stored attributes never break label matching.
    assert.deepEqual(
      searchObjects(inventory, { label: "table" }).annotationIds,
      ["annotation-1"],
    );
  });

  test("empty label with valid attributes is an attribute-only search", () => {
    const result = searchObjects(scene(), {
      label: "",
      attributes: { material: "brass" },
    });
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-3"]);
  });
});

describe("multiple results", () => {
  test("all matching annotations are returned", () => {
    const inventory = [
      obj("annotation-1", "Sofa"),
      obj("annotation-2", "Sofa"),
      obj("annotation-3", "Bed"),
    ];
    const result = searchObjects(inventory, { label: "sofa" });
    assert.deepEqual(result.annotationIds, ["annotation-1", "annotation-2"]);
    assert.equal(result.matchCount, 2);
  });

  test("duplicate physical-object annotations remain separate", () => {
    // Same apparent couch annotated twice: both stay distinct results.
    const inventory = [obj("annotation-7", "Couch"), obj("annotation-8", "Couch")];
    const result = searchObjects(inventory, { label: "sofa" });
    assert.deepEqual(result.annotationIds, ["annotation-7", "annotation-8"]);
  });

  test("ordering follows inventory order, never ID sorting", () => {
    const inventory = [
      obj("annotation-9", "Sofa"),
      WOODEN_TABLE,
      obj("annotation-1", "Sofa"),
    ];
    assert.deepEqual(
      searchObjects(inventory, { label: "sofa" }).annotationIds,
      ["annotation-9", "annotation-1"],
    );
  });
});

describe("quantifiers", () => {
  test("all with zero matches: no-match", () => {
    const result = searchObjects(scene(), { label: "bed", quantifier: "all" });
    assert.equal(result.status, "no-match");
    assert.deepEqual(result.annotationIds, []);
    assert.equal(result.matchCount, 0);
  });

  test("all with one and with multiple matches", () => {
    const single = searchObjects(scene(), { label: "floor lamp", quantifier: "all" });
    assert.equal(single.status, "matched");
    assert.deepEqual(single.annotationIds, ["annotation-3"]);

    const both = searchObjects(
      [obj("annotation-4", "Sofa"), obj("annotation-5", "Sofa")],
      { label: "sofa", quantifier: "all" },
    );
    assert.equal(both.status, "matched");
    assert.deepEqual(both.annotationIds, ["annotation-4", "annotation-5"]);
    assert.equal(both.matchCount, 2);
  });

  test("quantifier defaults to all", () => {
    const result = searchObjects(
      [obj("annotation-1", "Sofa"), obj("annotation-2", "Sofa")],
      { label: "sofa" },
    );
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-1", "annotation-2"]);
  });

  test("one with zero matches: no-match", () => {
    const result = searchObjects(scene(), { label: "bed", quantifier: "one" });
    assert.equal(result.status, "no-match");
    assert.deepEqual(result.annotationIds, []);
  });

  test("one with exactly one match", () => {
    const result = searchObjects(scene(), { label: "dining table", quantifier: "one" });
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-2"]);
    assert.equal(result.matchCount, 1);
  });

  test("one with multiple matches: ambiguous with every candidate returned", () => {
    const result = searchObjects(
      [obj("annotation-1", "Sofa"), obj("annotation-2", "Sofa"), LAMP],
      { label: "sofa", quantifier: "one" },
    );
    assert.equal(result.status, "ambiguous");
    assert.deepEqual(result.annotationIds, ["annotation-1", "annotation-2"]);
    assert.equal(result.matchCount, 2);
    assert.ok(
      typeof result.reason === "string" && result.reason.includes("2"),
      `reason should mention the count: ${result.reason}`,
    );
  });
});

describe("invalid and empty query input", () => {
  test("empty query and missing label plus attributes are rejected", () => {
    assert.throws(() => searchObjects(scene(), {}), TypeError);
    assert.throws(() => searchObjects(scene(), { label: "   " }), TypeError);
    assert.throws(() => searchObjects(scene(), { attributes: {} }), TypeError);
    assert.throws(() => searchObjects(scene(), { quantifier: "all" }), TypeError);
  });

  test("non-object queries and wrong field types are rejected", () => {
    assert.throws(() => searchObjects(scene(), null as never), TypeError);
    assert.throws(() => searchObjects(scene(), [] as never), TypeError);
    assert.throws(() => searchObjects(scene(), { label: 42 as never }), TypeError);
  });

  test("unsupported quantifier values are rejected", () => {
    assert.throws(
      () => searchObjects(scene(), { label: "sofa", quantifier: "some" as never }),
      TypeError,
    );
    assert.throws(
      () => searchObjects(scene(), { label: "sofa", quantifier: "ALL" as never }),
      TypeError,
    );
  });

  test("invalid attribute structures are rejected", () => {
    assert.throws(
      () => searchObjects(scene(), { attributes: { material: 3 } as never }),
      TypeError,
    );
    assert.throws(
      () => searchObjects(scene(), { attributes: ["wood"] as never }),
      TypeError,
    );
    assert.throws(
      () => searchObjects(scene(), { attributes: { "   ": "wood" } }),
      TypeError,
    );
    assert.throws(
      () => searchObjects(scene(), { attributes: { material: "///" } }),
      TypeError,
    );
    // Conflicting keys that normalize to the same name.
    assert.throws(
      () =>
        searchObjects(scene(), {
          attributes: { material: "wood", Material: "oak" },
        }),
      TypeError,
    );
  });

  test("invalid synonyms options are rejected", () => {
    assert.throws(
      () => searchObjects(scene(), { label: "sofa" }, { synonyms: { couch: 5 } as never }),
      TypeError,
    );
    assert.throws(
      () => searchObjects(scene(), { label: "sofa" }, { synonyms: "sofa" as never }),
      TypeError,
    );
  });
});

describe("registry compatibility", () => {
  function newRegistry(): SpatialObjectRegistry {
    const registry = new SpatialObjectRegistry();
    // Cluster-fitted annotation with VLM description and fitted OBB.
    registry.register({
      objectId: "annotation-1",
      semanticLabel: "Sofa",
      attributes: {
        description: "a grey two-seater sofa",
        obb: "cluster",
      },
      worldObb: new OBB({
        position: new THREE.Vector3(1, 0.6, 2),
        size: new THREE.Vector3(2, 0.9, 1),
      }),
    });
    // Pin-only fallback: zero-size point OBB tagged obb: "point".
    registry.register({
      objectId: "annotation-2",
      semanticLabel: "Reading Chair",
      attributes: { obb: "point" },
      worldObb: new OBB({
        position: new THREE.Vector3(-2, 0.3, 1),
        size: new THREE.Vector3(0, 0, 0),
      }),
    });
    return registry;
  }

  test("cluster-fitted annotation is searchable by label", () => {
    const registry = newRegistry();
    const result = searchObjects(registry.list(), { label: " sofa " });
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-1"]);
  });

  test("pin-only annotation is searchable by label", () => {
    const registry = newRegistry();
    const result = searchObjects(registry.list(), { label: "reading chair" });
    assert.equal(result.status, "matched");
    assert.deepEqual(result.annotationIds, ["annotation-2"]);
  });

  test("VLM description attribute is searchable through the registry contract", () => {
    const registry = newRegistry();
    assert.deepEqual(
      searchObjects(registry.list(), {
        attributes: { description: "a grey two-seater sofa" },
      }).annotationIds,
      ["annotation-1"],
    );
  });

  test("search results preserve registry insertion order", () => {
    const registry = newRegistry();
    registry.register({
      objectId: "annotation-3",
      semanticLabel: "Coffee Table",
      attributes: { obb: "cluster" },
      worldObb: new OBB({
        position: new THREE.Vector3(0, 0.4, 0),
        size: new THREE.Vector3(1, 0.4, 1),
      }),
    });
    // The cluster tag hits annotations 1 and 3, in registration order.
    assert.deepEqual(
      searchObjects(registry.list(), { attributes: { obb: "cluster" } })
        .annotationIds,
      ["annotation-1", "annotation-3"],
    );
  });

  test("removal unregisters and the annotation stops matching", () => {
    const registry = newRegistry();
    assert.equal(registry.remove("annotation-1"), true);
    assert.equal(searchObjects(registry.list(), { label: "sofa" }).status, "no-match");
  });

  test("geometry qualification seams match the Phase 0 tags", () => {
    const registry = newRegistry();
    const [fitted, pinOnly] = registry.list();
    assert.equal(hasFittedGeometry(fitted), true);
    assert.equal(spatialGeometryKind(fitted), "cluster");
    assert.equal(hasFittedGeometry(pinOnly), false);
    assert.equal(spatialGeometryKind(pinOnly), "point");
  });

  test("malformed and missing metadata never throw", () => {
    const inventory = [
      obj("annotation-1", "Sofa"),
      null,
      7,
      "wrong",
      { attributes: {} },
      { objectId: "", semanticLabel: "Sofa" },
      { objectId: "annotation-3", semanticLabel: 42, attributes: {} },
      { objectId: "annotation-4", semanticLabel: 42, attributes: { obb: "cluster" } },
    ] as unknown as SearchableObject[];

    assert.deepEqual(searchObjects(inventory, { label: "sofa" }).annotationIds, [
      "annotation-1",
    ]);
    // Attribute-only queries can still reach entries with unusable labels:
    // usable IDs, malformed labels, and missing-attribute entries are all safe.
    assert.deepEqual(
      searchObjects(inventory, { attributes: { obb: "cluster" } }).annotationIds,
      ["annotation-4"],
    );
  });

  test("empty inventory is a valid no-match", () => {
    const result = searchObjects([], { label: "sofa" });
    assert.equal(result.status, "no-match");
    assert.deepEqual(result.annotationIds, []);
  });

  test("non-array inventory is rejected", () => {
    assert.throws(
      () => searchObjects({} as unknown as SearchableObject[], { label: "sofa" }),
      TypeError,
    );
  });
});
