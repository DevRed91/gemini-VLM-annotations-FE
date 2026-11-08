# Investigation — Gemini Conversational Object Search in the Gaussian Splat Viewer

**Date:** 2026-11-08 · **Status:** Investigation complete; no product code changed
**Repos:** `gemini-VLM-annotations-FE` (branch `experiment/gaussian-id-probe`, uncommitted working-tree changes included) · `gemini-VLM-annotations-BE` (branch `master`, uncommitted Netlify-function migration included)
**Companion page:** `/Users/devrajreddy/Semantic_Uplifiting/object-search-investigation.html` (same content, styled)

Markers used throughout: **[existing]** = verified in the current working tree today · **[proposed]** = new work required by this feature · **[caveat]** = risk or drift.

## Verdict

- **Split the work.** Gemini answers language only: given `message + history + text-only inventory`, it returns a structured *search intent* (labels, attributes, relation, quantifier) via `responseSchema`. The frontend resolves that intent deterministically against the in-memory object registry, applies OBB spatial math, and drives selection. Gemini never sees Gaussian indices, never receives geometry, and never returns object IDs to execute.
- **Scene geometry never leaves the browser.** `SpatialObjectRegistry` snapshots already hold label + attributes + world OBB; only short text descriptions go on the wire. This keeps payloads, cost, and prompt-injection surface small, and it diverges deliberately from the brief's sketch (which sent `center`/`halfExtents` and received matched `objectId`s — evaluated and rejected, §5).
- **The registry is the missing piece.** Annotation labels today live only in DOM text; nothing persistent exists. Wiring `SpatialObjectRegistry` at annotation creation/removal is Phase 0 and unblocks everything.
- **Backend path:** Express (`server.ts`) is the de-facto production target — FE env, dev proxy, and built dist bundle all point at `localhost:3000`. The Netlify function is configured but its committed code is one migration behind (an uncommitted working-tree edit brings it to parity). Add `POST /api/chat/search` to Express first; finalize hosting as decision D1 (§13).
- **Smallest viable milestone = Phase 0 + Phase 1** (~3–5 days): registry wiring plus a chat panel with label-only search, follow-up phrasing via session history, clarify/no-match handling, and programmatic selection reusing the existing highlight pipeline. All acceptance criteria are testable through the existing `__sl` dev seam.

## 1. Existing architecture [existing]

### Frontend pipeline (click → detection → annotation → highlight)

Singleton viewer: `export const viewer = new SplatViewer()` (`src/script.ts:809`, imported by `src/main.ts`); initial world `/Apartment.sog` (`src/script.ts:817`).

1. Arm tool `setupAnnotationUI()` (`src/script.ts:245`) → canvas click `setupClickInteraction()` (`src/script.ts:217`).
2. Depth pick by raycast against the splat: `getAnnotationPosition()` (`src/script.ts:448`).
3. JPEG snapshot + `POST /api/annotate` with `{ image, clickX, clickY }`: `requestAnnotationFromGemini()` (`src/script.ts:762`).
4. Per detection `{ label, description?, box }` (box normalized `[ymin, xmin, ymax, xmax]`): `sanitizeDetectionBox` → grid ray-sampling (6–25 points) → DBSCAN clustering (`GeometricContextManager.registerAndMeasureObject`, eps 0.3, minPts 10/4) → OBB fit (`fitOBB`) → `annotateFromDetection()` (`src/script.ts:627`).
5. Gaussian lift + mask label when enabled: `objectHighlighter.select(fit.obb, { minOpacity: 0.05 })` (`src/script.ts:666`) → numeric mask id 1–255 via `GaussianObjectHighlighter`/`GaussianMaskManager` (4096-wide R8UI mask + 256-entry palette, shader tint).
6. `createAnnotationElement()` (`src/script.ts:484`) builds DOM pin/label/card + OBB wireframe `LineSegments` appended to the splat.

Annotation record (verbatim, `src/script.ts:60`):

```ts
interface ViewerAnnotation {
  element: HTMLElement;
  position: THREE.Vector3;      // cluster centroid, world space
  apartmentId: string;          // `annotation-${++annotationSequence}`
  worldObb?: OBB;               // fitted OBB in world frame
  helper?: THREE.LineSegments;  // wireframe added to splat
  fallbackTint?: HoverTint;     // OBB tint when no highlighter
  selectionOwner?: GaussianObjectHighlighter;
  selectionId?: number;         // mask label == numeric id
  worldGeneration: number;      // staleness guard on scene switch
}
```

Facts that shape the design:

- **IDs:** `annotation-1, annotation-2, …` from a counter that never resets across worlds (`src/script.ts:90`); session-scoped only, nothing persisted. The Gaussian mask id (1–255) is a separate namespace; they join via `selectionId`.
- **Labels exist only in the DOM** (pin/button/card text = Gemini's `label`) and transiently in `GeometricContextManager` clusters. No attribute store, no color/material tags.
- **No programmatic select/highlight-by-id exists** on `SplatViewer`. Removal paths: `removeAnnotation` (`src/script.ts:399`), `clearAllSelections` (`src/script.ts:392`). Dev console seam `window.__sl` (`src/script.ts:822`) offers `inject(label, box)`, `clearOne(selectionId)`, `clearAll()`, `selections`, `mode` — the natural deterministic test hook.
- **Highlight primitives reusable for selection:** `GaussianMaskManager.getLabelColor/setLabelColor/setStrength` (`gaussianMaskManager.ts:250–273`; `setStrength` is global, recolor-per-label is per-label), wireframe material color, DOM pin/card classes, and `HoverTint` (`setColor()`/`setHovered()` with owned cleanup, `hoverTint.ts:141–150` — verified) as the OBB-tint fallback when highlighting is off or the splat is LOD.
- **OBB fitter internals (verified):** `fitOBB` (`src/utils/obbFit.ts:72`) is a PCA eigen-fit (Jacobi), axes sorted by eigenvalue (longest axis first), with an AABB fallback below 4 points or degenerate covariance (`obbFit.ts:61,79,106`). Consequence for spatial math: an anchor's local axes are PCA artifacts, not semantic sides — thresholds must be generous and fixtures must include rotated-PCA cases.
- **Uncommitted working-tree changes (FE):** hover-pick experiment removed; all Gaussian tinting now opt-in behind `VITE_ENABLE_GAUSSIAN_HIGHLIGHTING=true` (default off → pins/labels/wireframes only, `mode = "obb-fallback"`); debug logs in `annotateFromDetection`. This leaves the `apartments` array write-only (`src/script.ts:93,235,556`) — its only reader was deleted.
- **Scene lifecycle:** `loadWorld(url)` (`src/script.ts:409`) bumps `worldGeneration` → `clearWorldResources()` (annotations, highlighter dispose, splat dispose) → new splat → new highlighter if allowed and non-LOD. Any new per-world state must init after `splat.initialized`, guard on generation, and be torn down in `clearWorldResources`.
- **Environment:** `VITE_API_BASE_URL` (default `/api`), `VITE_BYPASS_TUNNEL_REMINDER`, `VITE_ENABLE_GAUSSIAN_HIGHLIGHTING`. Dev proxy `/api → http://localhost:3000` (`vite.config.js`). Registry class facts: `clear()` keeps used IDs non-reusable (`spatialObjectRegistry.ts:146`) → fresh registry per world is the correct reset.

### Backend [caveat: two diverging implementations]

| | Express `server.ts` | Netlify `netlify/functions/annotate.ts` |
|---|---|---|
| Routes | `GET /health`, `POST /api/annotate` | `OPTIONS/POST` via `/api/* → /.netlify/functions/:splat` redirect; no health route |
| SDK / model | `@google/genai` 2.8.0, `gemini-2.5-flash` (`GEMINI_MODEL` override) | Committed HEAD: old `@google/generative-ai`, `gemini-3-pro-image`, buildings prompt, no schema. Uncommitted working-tree edit migrates it to match Express (verified via git: 114-line diff) |
| Structured output | `responseMimeType + responseSchema` = `{objects:[{label,description,box}]}`, 60 s AbortController | Same schema in the uncommitted version; committed one hand-scrubs JSON |
| CORS | Allowlist = `CORS_ALLOWED_ORIGINS` + default `https://auto-annotate.netlify.app` + dev `localhost:5173` (non-prod only); no-Origin allowed | Self-built headers; explicit 403 on disallowed origin; dev origins not allowed |
| Validation | `userBox` fully validated | Committed version does not validate `userBox`; no timeout |
| Client | one `GoogleGenAI` at module load | per-request `GoogleGenAI` |

Both accept `{ image, userBox?, clickX, clickY }` and return `{ objects: [{label, description, box}] }`. No chat, session, GET, or inventory endpoint exists anywhere. LangChain/LangGraph/multer deps are installed but unused (legacy). `BE/test.ts:9` prints the API key inside a URL when run — hygiene flag.

## 2. Gaps and integration requirements

| # | Gap | Consequence for chat search |
|---|---|---|
| G1 | No persistent semantic store — labels live only in DOM text; `SpatialObjectRegistry` is compiled but has exactly one reference in the repo: its own definition. | Search has no inventory to resolve against. Phase 0 = wire registry into annotation creation/removal. `GeometricContextManager.ts:12` already comments that "semantic identity is owned by the registry" — the wiring was designed, never made. |
| G2 | No programmatic select/highlight-by-id on `SplatViewer`. | Add a small public API (`setChatSelection(ids)`/`clearChatSelection()`) composing existing primitives — no new render path. |
| G3 | Three ID namespaces (`apartmentId`, mask id 1–255, registry ids) with no canonical join. | Declare `apartmentId` the single application-level object id; chat uses only that; mask ids stay internal. |
| G4 | Labels carry no attributes (color/material); no synonym knowledge. | "The brown pillow" needs attribute data; short-term = synonyms + description fallback; long-term = optional attributes on the annotate schema (Phase 3, decision D3). |
| G5 | Backend drift: Netlify function one migration behind Express at HEAD; no shared Gemini module; no chat endpoint. | Add `/api/chat/search` to Express first; extract a shared Gemini client; commit the Netlify migration for parity or retire the function (decision D1). |
| G6 | Hosted deployment unconfirmed: FE has no deploy config; `.env.production` points at `localhost:3000`. | Nothing blocks development (dev proxy + tunnel), but any public URL needs a real backend base URL + CORS entry (Appendix A, decision D2). |

## 3. Recommended architecture and data flow [proposed]

```text
User chat message
      |
      v
chat panel → session store (last N turns, in memory)
      |
      v
POST /api/chat/search      { message, history, inventory: text-only {objectId, label, attributes} }
      |
      v
Gemini 2.5 Flash — intent extraction only
(responseSchema JSON: action, reply, structured search intent; no IDs executed, no geometry, no rendering)
      |
      v
Frontend spatialResolver (pure, testable): label+synonym matching → registry lookup → OBB relation math → quantifier logic
      |
      v
Application object ids (apartmentId) — results verified against the registry
      |
      v
viewer.setChatSelection(ids): DOM pin highlight + card + wireframe recolor
+ mask label recolor (where owner exists) / HoverTint fallback
      |
      v
Existing rendering only: annotation wireframes / pins / mask tint
```

Why the model resolves language, not objects: geometry stays deterministic and testable with no API round-trips to fix a bad match; Gemini cannot control Gaussian indices or rendering (hard constraint); hallucination can only produce unmatched labels, never wrong GPU state. Responsibility split:

- **Gemini layer (backend):** pronoun/follow-up resolution ("the brown one") using history; label + attribute vocabulary ("couch"→"sofa"); ambiguity → structured `clarify` action; reply phrasing.
- **Frontend layer:** registry lookup + exact/synonym/fuzzy match; OBB spatial predicates (near, nextTo, left/right, above/below); quantifiers (`all`/`one`) and tie-breaking; ID → annotation mapping, selection, clear.

## 4. SpatialObjectRegistry integration strategy [implemented 2026-11-08]

> Implemented as proposed; deviations: (a) registration lives in
> `createAnnotationElement()` (the only creation funnel) rather than
> `annotateFromDetection()`, so pin-only fallback annotations register too —
> with a zero-size point OBB tagged `attributes.obb: "point"`; (b) `update()`
> is unused so far. Contract, results and validation:
> `docs/chat-object-search-phase-0-registry.md`.

- **Fresh registry per world.** `registry.clear()` deliberately keeps used IDs non-reusable; re-registering `annotation-N` after a switch would throw. Mirror the highlighter's pattern: construct in `loadWorld` after `splat.initialized` (~`src/script.ts:426`), drop in `clearWorldResources` (~`src/script.ts:382`). `annotationSequence` never resets, so per-world uniqueness is guaranteed.
- **Register at annotation creation**, in `annotateFromDetection()` (~`src/script.ts:682`), success path only: `registry.register({ objectId: annotation.apartmentId, semanticLabel: detection.label, attributes: { description: detection.description }, worldObb: fit.obb })`. Unregister in `removeAnnotationVisual()` (`src/script.ts:361`).
- **One canonical id:** registry `objectId = apartmentId` everywhere; mask id (1–255) never appears in chat payloads.
- **Inventory projection for the wire:** `list()` → `{ objectId, label, attributes }` only (no OBB) — used for the API payload and prompt context lines.
- **Bookkeeping cleanup (optional, flagged):** the hover removal left `apartments` write-only; the registry can subsume it. Fold into Phase 0 or leave as-is — not required for the feature.
- **Staleness:** selections requested across a scene switch are generation-guarded the same way annotation code checks `worldGeneration` (`src/script.ts:631,678`).

## 5. Chat API contract [proposed]

Endpoint: `POST /api/chat/search`. The brief's original sketch (backend returns objectIds; request carries OBB centers/half-extents) was evaluated and rejected: an LLM doing arithmetic over box coordinates is unreliable for near/next-to/left-of; geometry in prompts costs tokens and widens the privacy surface; hallucinated/stale IDs must be defended against anyway. Keep geometry local; the backend sees a text-only inventory.

**Request** (limits in §10):

```json
{
  "message": "find the brown pillow next to the patterned pillow",
  "history": [
    { "role": "user", "text": "find the red sofa" },
    { "role": "assistant", "text": "Selected 1 sofa." }
  ],
  "inventory": [
    { "objectId": "annotation-7", "label": "pillow", "attributes": { "color": "brown" } },
    { "objectId": "annotation-8", "label": "pillow", "attributes": { "color": "patterned" } }
  ]
}
```

**Response** — language + intent, not object ids (the brief's `unresolved[]` moves frontend-side, where resolution runs):

```json
{
  "action": "search",
  "reply": "Looking for the brown pillow next to the patterned pillow.",
  "search": {
    "targets":   [ { "label": "pillow", "attributes": { "color": "brown" } } ],
    "anchors":   [ { "label": "pillow", "attributes": { "color": "patterned" } } ],
    "relation":  { "type": "nextTo" },
    "quantifier": "one"
  },
  "clarify": null
}
```

`action` ∈ `search | clarify | summary | smalltalk`. The frontend resolves, then composes the final outcome line locally (template) — no second API call. Gemini's `reply` reads naturally in clarify/no-match/multi-match cases because the model saw the inventory labels.

**Function calling vs structured output:** structured JSON output via `responseMimeType + responseSchema` (matching the annotate path, `server.ts:124`) is recommended. Function calling adds an execution loop and a second round-trip for zero benefit — there is exactly one "tool" (extract intent) and no side effect to invoke. Structured output also gives schema-level guarantees the committed Netlify code's hand-scrubbed JSON lacked.

**Errors** mirror annotate: 400 invalid body · 500 no `GEMINI_API_KEY` · 429 rate limit → 429 · upstream 4xx → 502 · 504 timeout (20 s Abort; annotate keeps 60 s).

## 6. Gemini model and structured-output strategy [proposed]

- **Model:** `gemini-2.5-flash` via the existing `GEMINI_MODEL` override pattern (`server.ts:10`). Intent extraction is a small task; flash is the right cost/latency class. `gemini-2.5-flash-lite` is a downgrade candidate for latency but adds a second model to operate; not recommended day one.
- **Schema:** object with required `action`/`reply`; `action` as STRING enum; nested `search` object (`targets`/`anchors` arrays of `{label, attributes}`, `relation.type` enum `near|nextTo|leftOf|rightOf|above|below`, `quantifier` enum `all|one`). Keep `attributes` to an explicit property list (e.g. `{color?: string}`) — responseSchema's free-form map support is limited; flat `color` covers Phases 1–3.
- **Prompt skeleton:** role = intent extractor for a 3D scene search; inventory one line per object (`annotation-7: pillow (brown)`); rules: use only inventory vocabulary, never invent IDs or labels for search targets, resolve pronouns via history, choose `clarify` when one requested object matches multiple entries, prefer an empty-targets search reply over guessing; output only JSON (responseMimeType enforces it anyway).
- **Config:** `temperature ≈ 0.2` (existing code sets none; classification wants determinism), no thinking budget needed, no safety settings or retries — same posture as annotate plus the AbortController pattern.
- **Trust boundary:** user text and inventory are model input; output is schema-constrained intent; the resolver only matches registry labels — a steered model can at worst cause a wrong or empty match, never GPU/mask state.

## 7. Session history [proposed]

- **In-memory only** (hard constraint, no DB): `Array<{role, text}>` in a small `chatSession` module; each request sends the last 8 turns (bounds cost and drift).
- **Follow-ups** are resolved by rewriting each message into a self-contained intent given history ("now the brown one" → color=brown restricted to the previous target). The FE never interprets history.
- **Scene switch:** on `loadWorld`, reset session, empty inventory projection (fresh registry), one-line "scene reloaded" note in the panel.
- **Not persisted** across page reloads — consistent with annotations themselves being session-scoped today.

## 8. Relative spatial search (OBB math) [proposed]

**Frame:** the three.js world frame of the loaded splat — `OBB.position/quaternion/size` (`src/utils/obb.ts:9`) are world-space (fitted from world points; splat offset baked in). Up = +Y. No real-world units are assumed anywhere: every threshold is normalized by object dimensions. Left/right are **anchor-relative** (the reference object's own right vector from its quaternion), not world-X and not camera-relative; camera-relative is a deliberate Phase 4 extension.

| Predicate | Computation (t = target, a = anchor; r = half-extent radius) | Default threshold |
|---|---|---|
| near | normalized gap `g = (‖Δ‖ − r_a − r_t) / max(r_a, r_t) ≤ τ` | τ = 0.6 |
| nextTo | near-ish (τ = 0.35) and `|Δ·up| ≤ 0.5·min(h_a, h_t)` and contact side: smallest OBB–OBB face gap ≤ 0.3·max(r) | see left |
| leftOf / rightOf | Δ in anchor basis: `sRight = Δ·right_a`, `sFwd = Δ·fwd_a`; `|sRight| ≥ w_a/2 + w_t/2` plus angular side-dominance (below); sign decides side | see left |
| above / below | `Δ·up` beyond vertical overlap: `Δ_y − verticalOverlap ≥ 0.5·max(r_a, r_t)` | as stated |

Implementation notes (all thresholds in one exported constants table, tuned once in the fixture harness):

- All math via quaternion basis vectors; never assume axis-aligned OBBs.
- Candidate set = label-matched targets; spatial predicates filter against the best-matching anchor group; anchor ambiguity → minimal relation distance tie-break → clarify.
- Resolver is pure (depends only on `obb.ts` + snapshot types) → runs under `node --test` and in a Playwright harness page.

**Numeric probe findings (verification pass, same day — first-draft thresholds refined before any implementation):** a scratch script ran synthetic OBBs (sofa/chair/pillow/lamp, yawed-anchor variants; no repo code touched).

- *Validated:* anchor-local basis flips sides correctly under yaw rotation (a world-`+x` chair reads as "in front of" a yawed sofa, not right of it); `above`/`below` and `near` behave, including overlap cases (pillow on seat → above with negative normalized gap).
- *Weakness found — radius normalization:* a single max-half-extent radius lets object height leak into horizontal predicates (a 0.45-tall chair got radius 0.45 although its half-width is 0.3), flipping a true `nextTo` at the boundary. **Refinement:** use horizontal (xz) radii for near/nextTo/contact; reserve the vertical radius for above/below.
- *Weakness found — side dominance:* a diagonally placed chair (+x, −z) satisfied `rightOf` under `|sFwd| < |sRight|`. **Refinement:** angular dominance — `atan2(|sFwd|, |sRight|)` below ~40°, tuned in the Phase 2 harness.
- *PCA reality check:* `fitOBB`'s axes are eigenvalue-sorted with an AABB fallback (`obbFit.ts:52,103,79`) — an anchor's local "right" is data-dependent, not semantic. The Phase 2 harness must include yawed-PCA fixtures, and generous thresholds matter more than exact ones.

## 9. Frontend chat UI and selection integration [proposed]

**UI:** collapsible panel (bottom-left), started from a toolbar button beside `#annotationToolButton`; input + scrolling message list + scene status line; styling extends existing `.annotation-card` conventions in `src/style.css`. During `loadWorld`, show "loading scene…" and briefly disable input.

**New viewer-level selection API** — composition of existing primitives, no new render path:

```text
setChatSelection(ids: string[])    // highlight mode
  1. clear previous chat selection
  2. per id: annotation = annotations.find(a => a.apartmentId === id); skip stale (worldGeneration)
  3. DOM: pin/label element gets .chat-selected (CSS pulse); single result also opens its card
  4. wireframe helper: material color → accent (dispose-safe swap)
  5. gaussian tint: if selectionOwner?.mask — mask.setLabelColor(selectionId, accentColor)
     (per-label recolor confirmed at gaussianMaskManager.ts:259; restore via defaultGaussianMaskColor on clear)
  6. fallback (no owner / flag off / LOD): annotation.fallbackTint recolor — HoverTint exposes
     setColor()/setHovered() with owned cleanup (hoverTint.ts:141–150, verified), created on demand
clearChatSelection()               // restore colors, remove pin pulse, close cards
```

Rules: never call `highlighter.select()` again from search (that re-lifts clusters and races the highlighter's generation guards); chat never creates, moves, or deletes annotations; the annotation tool and chat are mutually exclusive armed states.

## 10. Error handling, security, API cost [proposed]

| Area | Decision |
|---|---|
| Validation (backend) | message ≤ 2000 chars; history ≤ 20 entries × 800 chars; inventory ≤ 255 entries (matches the highlighter's 255/world cap) × 64-char label, flat attributes; reject unknown fields; body limit 1 MB for this route |
| Error map | 400 malformed/oversized fields; 500 no `GEMINI_API_KEY`; 429 Gemini limit → 429; timeout 20 s → 504; upstream 4xx → 502. FE renders inline error bubbles + retry; reuse annotate's global error middleware pattern |
| CORS | Reuse the same allowlist middleware and env knobs as annotate |
| Prompt-injection boundary | Model output is schema-constrained intent; resolver only matches registry labels; worst case = wrong or empty selection, never GPU/mask state |
| Secrets | `GEMINI_API_KEY` stays server-side. Flag: `BE/test.ts:9` prints the key in a URL when run — fix worth folding into Phase 4 |
| Rate limiting | None exists today on annotate; optional per-IP in-memory token bucket (~20 req/min) on the chat route in Phase 4 — in-memory only, consistent with "no database" |
| Cost | One flash call per message: prompt ≈ inventory (255 × ~6 tokens worst case) + 8 history turns + system ≈ 1–2.5 k tokens in, ≤ 300 out — well under $0.002/message at flash list pricing (verify current pricing before commit) |
| Stale UX | Selections triggered across a scene switch are generation-guarded; late responses are dropped like annotation requests already are (`src/script.ts:796–803`) |

## 11. File-by-file proposed changes [proposed]

### Frontend (gemini-VLM-annotations-FE)

| File | Change | Purpose |
|---|---|---|
| `src/utils/spatialResolver.ts` **new** | ~300 lines, pure | Synonym map, label matcher (exact → substring → fuzzy), OBB relation math + constants table, quantifier logic, `resolveIntent(intent, inventory)` → `{results: {objectId, label, reason}[], unresolved, clarify?}` |
| `src/chat/chatContracts.ts` **new** | ~60 lines | Wire types: `ChatMessage`, `ChatSearchRequest/Response`, `SearchIntent` |
| `src/chat/chatSession.ts` **new** | ~50 lines | History store, cap, reset, wire serialization |
| `src/chat/chatSearchClient.ts` **new** | ~60 lines | `buildChatSearchEndpoint(base)` (same normalization style as `buildAnnotateEndpoint`, `src/script.ts:33`), fetch + 20 s Abort, typed parse |
| `src/chat/chatPanel.ts` **new** | ~200 lines | Panel DOM, toolbar toggle, message rendering, client → resolver → viewer callbacks; owns session; local outcome-line templates |
| `src/script.ts` **modify** | +~80 / −~10 lines | Per-world registry (create in `loadWorld` ~426, drop in `clearWorldResources` ~382); register/unregister in `annotateFromDetection` / `removeAnnotationVisual`; public `getChatInventory()`, `setChatSelection(ids)`, `clearChatSelection()`; wire panel |
| `index.html` **modify** | +2 nodes | Toolbar chat button, panel container |
| `src/style.css` **modify** | +~120 lines | Panel, messages, `.chat-selected` pin pulse |
| `src/experiment/chatHarness.ts` + `chatharness.html` **new** | harness page | Fixture OBBs + registry + panel for scripted query validation (probe/phase2/phase3 convention) |
| `scripts/chat-resolver.test.mjs` **new** | unit tests | `node --test` over resolver with fixture snapshots |
| `scripts/chat-validate.mjs` **new** | Playwright | Drives dev server + harness: annotate fixtures via `__sl.inject`, type queries, assert selection sets (phase3-validate.mjs pattern, incl. the `VITE_ENABLE_GAUSSIAN_HIGHLIGHTING` env pass-through) |

### Backend (gemini-VLM-annotations-BE)

| File | Change | Purpose |
|---|---|---|
| `lib/geminiClient.ts` **new** | refactor | Shared single `GoogleGenAI` + call helper (kills the server.ts / netlify duplication flagged as drift) |
| `lib/chatIntent.ts` **new** | ~150 lines | `chatIntentSchema`, prompt builder (inventory lines + history), call + 20 s Abort + validation |
| `server.ts` **modify** | +~15 lines | Route `POST /api/chat/search` → `lib/chatIntent`; body limit untouched for chat (small JSON) |
| `netlify/functions/chat-search.ts` **new** | only if D1 keeps Netlify | Mirror of the Express handler |
| `netlify/functions/annotate.ts` **existing diff** | commit working-tree migration | Bring committed code to parity (schema, model, validation, timeout) regardless of D1's outcome |
| README.md (both repos) **modify** | docs | Chat architecture, contract, env, phase notes |

## 12. Implementation phases and acceptance criteria [proposed]

**Smallest viable milestone = Phase 0 + Phase 1** — registry wiring plus a label-only chat search over existing annotations. No spatial relations yet; the contract stays stable while relations iterate behind the same `resolveIntent` signature.

| Phase | Scope | Acceptance criteria | Est. |
|---|---|---|---|
| **0 · Registry** | Wire registry as §4; inventory projection; no UI | After N annotations, inventory lists N snapshots with labels + OBBs; removing one shrinks it; scene switch empties it; zero behavior change otherwise (checkable via `__sl`) | 0.5–1 d |
| **1 · Chat MVP** | Panel, session (8 turns), Express endpoint, label-only resolver (all/one, clarify, no-match), selection API + highlight, scene-switch reset, validation scripts | ① two sofas + chair fixtures: "find the sofa" → both selected, reply counts 2 ② "select all annotated chairs" → only chair ③ unknown label → no-match reply, unchanged selection ④ ambiguous "the sofa" with 2 → clarify question ⑤ "now the chair instead" follow-up works via history ⑥ backend down → inline error, UI recovers ⑦ `__sl.load(other world)` → session + inventory + selection reset | 2–3 d |
| **2 · Relations** | OBB predicates + anchor logic + threshold tuning in harness | Scripted harness queries over 5 known fixtures resolve to expected ids, including a yawed-PCA anchor case; thresholds documented in one table; "the pillow next to the patterned pillow" passes | 3–4 d |
| **3 · Attributes & synonyms** | Color/material attributes (annotate schema gains optional `attributes` — decision D3), richer synonyms, `count` quantifier, multi-anchor relations | "the brown pillow next to the patterned one" resolves correctly; "select both tables" → 2; legacy annotations without attributes still match by label | 2–3 d |
| **4 · Hardening & deploy** | Rate limit, timeout/error audit, camera-relative left/right (optional), BE hygiene (test.ts key leak), deploy story: real FE URL + CORS; D1 resolution (commit Netlify parity or retire function) | Public https deployment passes end-to-end chat search through the chosen backend; error paths covered by validation | 2–4 d |

## 13. Technical risks and unresolved decisions

### Decisions needed

- **D1 · Production backend.** Evidence (Appendix A) says the FE effectively targets Express (localhost:3000 via tunnel), while Netlify is configured but stale at HEAD. Recommendation: declare Express the chat path now, commit the Netlify annotate migration for parity, then either add a chat function or formally park Netlify. Needs a deployment-truth answer only the repo owner has.
- **D2 · FE hosting URL.** `.env.production` → `http://localhost:3000/` breaks on https (mixed content + CORS). A real public URL + `CORS_ALLOWED_ORIGINS` entry is required for anything user-facing. Blocks Phase 4 only.
- **D3 · Attributes in the annotate schema.** Storing color/material cleanly means an additive optional field on the existing annotate response — cheap and backward-compatible but touches the existing feature's contract. Phases 1–2 can ship on labels alone.
- **D4 · Camera-relative left/right.** Deferred by design (anchor-relative needs no runtime camera state). If users expect "my left", Phase 4 adds camera heading to resolution input.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Fitted OBBs are noisy (DBSCAN ε=0.3, grid sampling) and PCA-aligned (axes eigenvalue-sorted; AABB fallback below 4 points) | Spatial predicates misjudge neighbours and sides | Normalized thresholds with generous margins; horizontal radii for contact + angular side-dominance (both weaknesses found by the numeric probe, §8); harness-tuned constants with mandatory yawed-PCA fixtures; relation results carry a `reason` string |
| Labels are single Gemini nouns with casing variation | Label misses | Trim/lowercase normalization + synonym map + substring/fuzzy tiers; clarification over guessing |
| `VITE_ENABLE_GAUSSIAN_HIGHLIGHTING` default-off (uncommitted state) | Mask-based chat highlight unavailable in default builds | Selection API ships the DOM/wireframe/HoverTint fallback path by design (§9) |
| Rewriting "the brown one" needs attributes that don't exist yet | Follow-up quality dips in Phases 1–2 | History rewrite limited to previously-mentioned labels until D3; reply stays honest (no fake attribute matches) |
| 255 mask-id ceiling / LOD splats (no highlighter) | Large sessions or LOD worlds lose tint | IDs stay internal to highlighting; chat matches on strings; HoverTint fallback |
| Netlify drift (committed function: old SDK/model, no `userBox` validation, no timeout) | Latent production surprise if that path goes live | Commit the migration (already in working tree) before any Netlify involvement; never implement chat twice while drift exists |
| Write-only `apartments` + orphaned `pickNearestOBB` after hover removal | Confusing dead bookkeeping | Optional cleanup folded into Phase 0 or left untouched — not required for chat |
| Intent-model nondeterminism | Occasionally odd reply/intent | temperature ≈ 0.2, schema-enum actions, resolver is deterministic regardless of phrasing |

## Appendix A — deployment evidence

| Evidence | Points to | Source |
|---|---|---|
| `.env.production` active value `http://localhost:3000/` (ngrok URL only commented) | Express (locally or via tunnel) | FE `.env.production` |
| Built `dist/assets/index-*.js` inlines `http://localhost:3000/` | Express | FE `dist/` (built 2026-11-08) |
| Vite dev proxy `/api → localhost:3000` | Express | FE `vite.config.js` |
| `buildAnnotateEndpoint()` defaults to `/api` | same-origin/proxied (dev Express) | FE `src/script.ts:24–46` |
| FE docs call out `server.ts` as the backend and flag Netlify as drift risk | Express | FE `docs/VLSPLAT_INVESTIGATION.md:46,182` |
| `netlify.toml` redirect + functions dir configured | Netlify wired but code stale at HEAD | BE `netlify.toml`; `git log` (netlify latest `7e69434`; server migrated in `fba6c6d`) |
| CORS default origin `https://auto-annotate.netlify.app` | Only in BE allowlists — zero corroboration inside the FE repo | BE `server.ts:41`, `annotate.ts:21`, README |
| **Verified by git directly (verification pass):** BE working tree carries `M netlify/functions/annotate.ts` (114-line parity migration, uncommitted) + `package-lock.json`; last `netlify/` commit `7e69434` vs `server.ts` migration `fba6c6d`; no ngrok/deploy notes anywhere in BE README (only the origin at :351); FE/BE remotes are GitHub `DevRed91` mirrors — deployment truth lives outside both repos | Netlify wired but stale; Express actively maintained | BE/FE `git status · git log · diff` |

**Conclusion:** Express is what the frontend actually calls today (possibly exposed via ngrok); no artifact proves a hosted FE deployment or a Netlify production site in use. Treat "production backend" as an open deployment decision (D1), not an architectural one.

## Appendix B — capability map (brief §5 checklist)

| Capability | Status | Phase |
|---|---|---|
| Label and synonym matching | resolved FE-side **[proposed]** | 1 (synonyms enriched 3) |
| Multiple matching objects | quantifier `all` + multi-select highlight **[proposed]** | 1 |
| Follow-ups via session history | history list + intent rewrite **[proposed]** | 1 (attribute-dependent ones 3) |
| near / nextTo / leftOf / rightOf / above / below | OBB math, §8 **[proposed]** | 2 |
| Ambiguity → clarification | `action: "clarify"` + FE candidates **[proposed]** | 1 |
| No-match responses | empty targets → honest reply **[proposed]** | 1 |
| Scene switch / inventory reset | fresh registry + session reset **[proposed]** (lifecycle hooks exist **[existing]**) | 0/1 |
| Search results → annotation ids | `apartmentId` as canonical id **[proposed]** | 0/1 |
| Manual-annotation-only inventory | registry populated by the existing click-to-annotate flow **[existing]** | 0 |
| Relative sizing, not metres | normalized thresholds only **[proposed]** | 2 |
| No auto scene-wide detection / no segmentation work / no DB | respected **[by design]** | — |

---

*Verification note: investigation was read-only across both repos — no files modified, uncommitted changes untouched (FE: `README.md`, `scripts/phase3-validate.mjs`, `src/script.ts`, untracked `TokenEconomizer/`; BE: `netlify/functions/annotate.ts`, `package-lock.json`). A post-report verification pass (2026-11-08) independently confirmed the OBB-fitter internals (`obbFit.ts` PCA eigen-fit with AABB fallback), the `HoverTint` recolor API, and the backend-drift claim via `git status/log/diff`; a numeric probe of the §8 formulas produced the threshold refinements folded into §8. `docs/phase-3-multi-object-integration-plan.md` was read in full: it scopes multi-object mask work and explicitly excludes Gemini/VLM changes, so chat search is the natural next phase, not a scope collision. File:line references are from the working tree on 2026-11-08 and may shift with edits.*
