import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { parseAnnotationMetadata } from "../src/spatial/AnnotationMetadata.ts";
import {
  createSceneAnnotationMetadataStore,
  createSceneAnnotationRecord,
  normalizeWorldKey,
  type SceneAnnotationStorage,
} from "../src/spatial/AnnotationMetadataStore.ts";
import { searchObjects } from "../src/spatial/ObjectMatcher.ts";
import { OBB } from "../src/utils/obb.ts";
import { SpatialObjectRegistry } from "../src/utils/spatialObjectRegistry.ts";

class MemoryStorage implements SceneAnnotationStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function metadata() {
  return parseAnnotationMetadata({
    schemaVersion: 1,
    category: "table",
    description: "Round dining table with a white marble top.",
    attributes: { shape: "round", material: "marble", color: "white" },
    synonyms: ["round table", "marble dining table"],
  });
}

function record(annotationId: string, label = "Dining Table") {
  return createSceneAnnotationRecord({
    annotationId,
    label,
    description: "Round dining table with a white marble top.",
    metadata: metadata(),
    position: new THREE.Vector3(1, 2, 3),
    worldObb: new OBB({ position: new THREE.Vector3(1, 2, 3), size: new THREE.Vector3(1, 1, 1) }),
    dimensions: { width: 1, height: 1, depth: 1 },
  });
}

describe("scene annotation metadata persistence", () => {
  test("normalizes the scene key and isolates records by world", () => {
    assert.equal(normalizeWorldKey("/Apartment.sog"), "http://local.scene/Apartment.sog");
    const storage = new MemoryStorage();
    const apartment = createSceneAnnotationMetadataStore("/Apartment.sog", storage);
    const other = createSceneAnnotationMetadataStore("/BiltmoreGaussianSplat.sog", storage);

    apartment.save(record("annotation-1"));
    assert.equal(apartment.get("annotation-1")?.annotationId, "annotation-1");
    assert.equal(other.get("annotation-1"), undefined);
    assert.equal(apartment.list().length, 1);
    assert.equal(other.list().length, 0);
  });

  test("saves, retrieves, and updates metadata by annotation ID", () => {
    const store = createSceneAnnotationMetadataStore("/scene.sog", new MemoryStorage());
    const first = record("annotation-1", "Table");
    store.save(first);
    assert.deepEqual(store.get("annotation-1"), first);

    const updated = store.update("annotation-1", {
      label: "Dining Table",
      metadata: parseAnnotationMetadata({
        schemaVersion: 1,
        category: "table",
        attributes: { material: "marble", shape: "round" },
      }),
    });
    assert.deepEqual(store.get("annotation-1"), updated);
    assert.equal(updated.label, "Dining Table");
  });

  test("individual removal and clear-all remove stored metadata", () => {
    const store = createSceneAnnotationMetadataStore("/scene.sog", new MemoryStorage());
    store.save(record("annotation-1"));
    store.save(record("annotation-2"));
    assert.equal(store.remove("annotation-1"), true);
    assert.equal(store.remove("annotation-1"), false);
    assert.deepEqual(store.list().map((item) => item.annotationId), ["annotation-2"]);
    store.clear();
    assert.deepEqual(store.list(), []);
  });

  test("corrupt or invalid records are ignored without exposing them", () => {
    const storage = new MemoryStorage();
    const store = createSceneAnnotationMetadataStore("/scene.sog", storage);
    store.save(record("annotation-1"));
    const key = [...storage.values.keys()][0]!;
    const parsed = JSON.parse(storage.getItem(key)!);
    parsed.annotations.push({ annotationId: "bad", label: "No geometry" });
    storage.setItem(key, JSON.stringify(parsed));
    assert.deepEqual(store.list().map((item) => item.annotationId), ["annotation-1"]);
  });

  test("persisted records seed stable annotation IDs", () => {
    const store = createSceneAnnotationMetadataStore("/scene.sog", new MemoryStorage());
    store.save(record("annotation-7"));
    assert.equal(store.maxAnnotationSequence(), 7);
    assert.equal(store.list()[0]?.annotationId, "annotation-7");
  });

  test("stored JSON can hydrate the runtime registry and remain locally searchable", () => {
    const store = createSceneAnnotationMetadataStore("/scene.sog", new MemoryStorage());
    const saved = record("annotation-3");
    store.save(saved);
    const restored = store.get("annotation-3")!;

    const registry = new SpatialObjectRegistry();
    registry.register({
      objectId: restored.annotationId,
      semanticLabel: restored.label,
      metadata: restored.metadata,
      attributes: {
        ...(restored.description ? { description: restored.description } : {}),
        obb: restored.geometry.kind,
      },
      worldObb: new OBB({
        position: new THREE.Vector3(restored.position.x, restored.position.y, restored.position.z),
        size: new THREE.Vector3(1, 1, 1),
      }),
    });

    assert.deepEqual(
      searchObjects(registry.list(), { label: "table", attributes: { material: "marble", shape: "round" } })
        .annotationIds,
      ["annotation-3"],
    );
  });
});
