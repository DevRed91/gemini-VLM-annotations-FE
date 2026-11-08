import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ANNOTATION_METADATA_SCHEMA_VERSION,
  parseAnnotationMetadata,
} from "../src/spatial/AnnotationMetadata.ts";

describe("annotation metadata parsing", () => {
  test("normalizes a valid Gemini metadata object", () => {
    const metadata = parseAnnotationMetadata({
      schemaVersion: 1,
      category: " Table ",
      description: " A round dining table. ",
      attributes: {
        shape: "round",
        material: "marble",
        seats: 4,
        assembled: true,
        finish: "unknown",
      },
      synonyms: ["round table", "round table", ""],
      provenance: { source: "gemini", confidence: 0.82 },
      ignoredTopLevel: "not copied",
    });

    assert.deepEqual(metadata, {
      schemaVersion: 1,
      category: "Table",
      description: "A round dining table.",
      attributes: {
        shape: "round",
        material: "marble",
        seats: 4,
        assembled: true,
      },
      synonyms: ["round table"],
      provenance: { source: "gemini", confidence: 0.82 },
    });
    assert.ok(Object.isFrozen(metadata));
    assert.ok(Object.isFrozen(metadata.attributes));
  });

  test("accepts missing optional fields and defaults schema v1", () => {
    const metadata = parseAnnotationMetadata({ attributes: { material: "marble" } });
    assert.deepEqual(metadata, {
      schemaVersion: ANNOTATION_METADATA_SCHEMA_VERSION,
      attributes: { material: "marble" },
      provenance: { source: "gemini" },
    });
  });

  test("rejects malformed, unsupported, or unsupported-version metadata", () => {
    assert.equal(parseAnnotationMetadata(undefined), undefined);
    assert.equal(parseAnnotationMetadata(null), undefined);
    assert.equal(parseAnnotationMetadata("table"), undefined);
    assert.equal(parseAnnotationMetadata({ schemaVersion: 2, attributes: {} }), undefined);
    assert.equal(parseAnnotationMetadata({ schemaVersion: 0, attributes: {} }), undefined);
    assert.equal(parseAnnotationMetadata({ schemaVersion: "1", attributes: {} }), undefined);
    assert.equal(parseAnnotationMetadata({ attributes: [] }), undefined);
    assert.equal(
      parseAnnotationMetadata({ attributes: {}, provenance: { source: "user" } }),
      undefined,
    );
    assert.equal(
      parseAnnotationMetadata({ attributes: {}, provenance: { source: "gemini", confidence: 2 } }),
      undefined,
    );
  });

  test("keeps unknown attribute keys but drops uncertain or invalid values", () => {
    const metadata = parseAnnotationMetadata({
      schemaVersion: 1,
      attributes: {
        customTrait: "visible value",
        uncertain: "Unknown",
        unavailable: "not visible",
        invalid: null,
        empty: " ",
      },
    });
    assert.deepEqual(metadata?.attributes, { customTrait: "visible value" });
  });

  test("an empty semantic payload is treated as absent metadata", () => {
    assert.equal(parseAnnotationMetadata({ schemaVersion: 1, attributes: {} }), undefined);
    assert.equal(
      parseAnnotationMetadata({ schemaVersion: 1, attributes: {}, synonyms: [] }),
      undefined,
    );
  });
});
