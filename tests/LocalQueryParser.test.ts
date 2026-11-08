import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deriveSearchAttributes, parseLocalQuery } from "../src/chat/LocalQueryParser.ts";

describe("local query parser", () => {
  test("accepts bare labels and simple search commands", () => {
    assert.deepEqual(parseLocalQuery("sofa"), { ok: true, query: { label: "sofa", quantifier: "all" } });
    assert.deepEqual(parseLocalQuery("find sofa"), { ok: true, query: { label: "sofa", quantifier: "all" } });
    assert.deepEqual(parseLocalQuery("show chairs"), { ok: true, query: { label: "chair", quantifier: "all" } });
  });

  test("extracts all/one quantifiers and the couch synonym target", () => {
    assert.deepEqual(parseLocalQuery("find all sofas"), { ok: true, query: { label: "sofa", quantifier: "all" } });
    assert.deepEqual(parseLocalQuery("the couch"), { ok: true, query: { label: "couch", quantifier: "one" } });
    assert.deepEqual(parseLocalQuery("find one chair"), { ok: true, query: { label: "chair", quantifier: "one" } });
  });

  test("extracts explicit color and material filters", () => {
    assert.deepEqual(parseLocalQuery("wooden table"), {
      ok: true,
      query: { label: "table", attributes: { material: "wood" }, quantifier: "all" },
    });
    assert.deepEqual(parseLocalQuery("find the red sofas"), {
      ok: true,
      query: { label: "sofa", attributes: { color: "red" }, quantifier: "one" },
    });
    assert.deepEqual(parseLocalQuery("marble"), {
      ok: true,
      query: { attributes: { material: "marble" }, quantifier: "all" },
    });
  });

  test("rejects empty, unsupported, or conflicting attribute input", () => {
    assert.equal(parseLocalQuery("").ok, false);
    assert.equal(parseLocalQuery("annotated objects").ok, false);
    assert.equal(parseLocalQuery("red blue sofa").ok, false);
  });
});

describe("annotation search attribute derivation", () => {
  test("derives unambiguous explicit color and material terms", () => {
    assert.deepEqual(deriveSearchAttributes("Round Marble Table", "A white stone table"), {
      material: "marble",
      color: "white",
    });
    assert.deepEqual(deriveSearchAttributes("Wooden Dining Table"), { material: "wood" });
  });

  test("omits conflicting descriptions instead of guessing", () => {
    assert.deepEqual(deriveSearchAttributes("Red Sofa", "A blue upholstered sofa"), {});
  });
});
