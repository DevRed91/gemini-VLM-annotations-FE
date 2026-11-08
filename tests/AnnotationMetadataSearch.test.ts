import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseAnnotationMetadata, type AnnotationMetadata } from "../src/spatial/AnnotationMetadata.ts";
import { searchObjects } from "../src/spatial/ObjectMatcher.ts";
import type { SearchableObject } from "../src/spatial/types.ts";
import { parseLocalQuery } from "../src/chat/LocalQueryParser.ts";

function tableMetadata(overrides: Record<string, unknown> = {}): AnnotationMetadata {
  return parseAnnotationMetadata({
    schemaVersion: 1,
    category: "table",
    description: "Round dining table with a white marble top.",
    attributes: {
      shape: "round",
      material: "marble",
      color: "white",
      usage: "dining",
    },
    synonyms: ["round table", "marble dining table"],
    provenance: { source: "gemini", confidence: 0.9 },
    ...overrides,
  })!;
}

function searchable(id: string, label: string, metadata?: AnnotationMetadata, obb = "cluster") {
  return { objectId: id, semanticLabel: label, attributes: { obb }, metadata } satisfies SearchableObject;
}

const TABLE = searchable("annotation-1", "Dining Table", tableMetadata());
const WOOD_TABLE = searchable(
  "annotation-2",
  "Wooden Table",
  tableMetadata({ attributes: { material: "wood" } }),
);
const PIN_TABLE = searchable("annotation-3", "Table", tableMetadata({ attributes: { material: "marble" } }), "point");

describe("structured metadata search", () => {
  test("searches by display label and metadata category", () => {
    assert.deepEqual(searchObjects([TABLE], { label: "dining table" }).annotationIds, ["annotation-1"]);
    assert.deepEqual(searchObjects([TABLE], { label: "table" }).annotationIds, ["annotation-1"]);
    const categoryOnly = searchable("annotation-4", "Item", tableMetadata());
    assert.deepEqual(searchObjects([categoryOnly], { label: "table" }).annotationIds, ["annotation-4"]);
  });

  test("searches by description and metadata synonyms without partial words", () => {
    assert.deepEqual(
      searchObjects([TABLE], { label: "white marble top" }).annotationIds,
      ["annotation-1"],
    );
    assert.deepEqual(searchObjects([TABLE], { label: "round table" }).annotationIds, ["annotation-1"]);
    assert.equal(searchObjects([TABLE], { label: "tab" }).status, "no-match");
    assert.equal(searchObjects([TABLE], { label: "marble tabletop" }).status, "no-match");
  });

  test("metadata attributes participate in AND filtering", () => {
    assert.deepEqual(
      searchObjects([TABLE, WOOD_TABLE], {
        label: "table",
        attributes: { material: "marble" },
      }).annotationIds,
      ["annotation-1"],
    );
    assert.deepEqual(
      searchObjects([TABLE], {
        label: "table",
        attributes: { shape: "round", material: "marble", color: "white" },
      }).annotationIds,
      ["annotation-1"],
    );
    assert.equal(
      searchObjects([TABLE], { label: "table", attributes: { material: "wood" } }).status,
      "no-match",
    );
    assert.equal(
      searchObjects([TABLE], { label: "table", attributes: { material: "bamboo" } }).status,
      "no-match",
    );
  });

  test("metadata attributes override conflicting legacy derived attributes", () => {
    const object: SearchableObject = {
      objectId: "annotation-1",
      semanticLabel: "Dining Table",
      attributes: { material: "wood", obb: "cluster" },
      metadata: tableMetadata(),
    };
    assert.deepEqual(
      searchObjects([object], { label: "table", attributes: { material: "marble" } })
        .annotationIds,
      ["annotation-1"],
    );
  });

  test("pin-only annotations are searchable by metadata and remain separate from fitted objects", () => {
    assert.deepEqual(
      searchObjects([TABLE, PIN_TABLE], { label: "table", attributes: { material: "marble" } })
        .annotationIds,
      ["annotation-1", "annotation-3"],
    );
  });

  test("unsupported metadata and no-match queries preserve deterministic behavior", () => {
    const legacy = searchable("annotation-1", "Round Marble Table");
    assert.deepEqual(searchObjects([legacy], { label: "table" }).annotationIds, ["annotation-1"]);
    assert.equal(searchObjects([TABLE], { label: "bed" }).status, "no-match");
    assert.equal(searchObjects([TABLE], { label: "wooden table" }).status, "no-match");
  });

  test("local parser extracts round as a shape constraint without an LLM", () => {
    const parsed = parseLocalQuery("find the round table");
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.query, {
        label: "table",
        attributes: { shape: "round" },
        quantifier: "one",
      });
    }
  });
});
