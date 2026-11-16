# FAL SAM 3 provider (backend adapter) — implementation note

Status: adapter implemented and unit-tested against **mocked** HTTP. **Not yet confirmed by a real FAL inference**: the configured FAL account returned `403 User is locked. Reason: Exhausted balance` (2026-11-13). Auth itself reached FAL (it answered about the account, not the key). Top up at fal.ai/dashboard/billing, then run `node --env-file=.env fal-validate.ts` in the backend repo.

Config (backend `.env` only; the key never reaches the viewer):

```
SEGMENTATION_PROVIDER=fal
FAL_KEY=...
FAL_MASK_HOST_SUFFIXES=   # optional, comma list; extends the mask-URL host allow-list
```

## Verified from official FAL documentation / OpenAPI

| Item | Value |
|---|---|
| Endpoint | `POST https://fal.run/fal-ai/sam-3/image` (sync) |
| Auth | `Authorization: Key $FAL_KEY` |
| Input | `image_url` (required), `prompt` (**default `"wheel"`**), `point_prompts[] {x:int,y:int,label:0\|1,object_id?}`, `box_prompts[] {x_min,y_min,x_max,y_max: int, object_id?}`, `apply_mask` (default true), `output_format` png\|jpeg\|webp (default png), `sync_mode`, `return_multiple_masks`, `max_masks` (1–32, default 3), `include_scores`, `include_boxes` |
| Output | `masks: Image[]` (required; `Image` = `{url, content_type, file_name, file_size, width, height}`), `image`, `scores[]`, `boxes[]` (normalized **cxcywh**), `metadata[] {index, score, box}` |
| `object_id` | "Prompts sharing an object id refine the same object"; with a text prompt a point's `object_id` selects which detected object to refine |
| Errors | 401 bad credentials; 403 key not permitted / locked / spending limit; 422 `detail[] {loc,msg,type}`; 429 concurrency; 5xx; 504 timeouts. Body: `{detail, error_type}` |
| Price | $0.005 / request |

## NOT documented anywhere I could find (assumptions, to be confirmed by `fal-validate.ts`)

1. **Input x/y and box units/origin.** Integers; no unit stated. Assumed: pixels of the image sent, origin top-left. Isolated in `toFalPoint` / `toFalBox` (`fal.ts`).
2. **Whether coordinates refer to original or internally resized size.** Not stated. We send the original and assume coordinates match it. `fal-validate.ts` at `PW=2400 PH=1200` distinguishes.
3. **Mask dimensions.** Docs example shows 1024×1024. Assumed: input size. The adapter accepts an equal size, resamples (nearest) a mask with the same aspect ratio (±1%), and **rejects** anything else (a padded square would be rejected, not silently mis-registered).
4. **`apply_mask=false` appearance.** Assumed a binary mask PNG (luminance > 127 = foreground; or mixed alpha = mask). Guarded: a mask that is not binary-looking (>25% mid-tones) or covers the whole image is rejected.
5. **`prompt: ""` is accepted** for points/boxes-only (needed to dodge the `"wheel"` default).
6. **`data:` URI accepted in `image_url`.**
7. **Mask CDN host.** Allow-list is `fal.media`, `fal.ai`, `fal.run`, `googleapis.com`; a different host gives a clear `untrusted host (<host>)` error; extend with `FAL_MASK_HOST_SUFFIXES`.
8. Behaviour of text+point `object_id` (we send 1) and point+box sharing `object_id` 1.

## Prompt modes

| Contract prompts | Sent to FAL | Status |
|---|---|---|
| text | `prompt` | supported |
| points | `point_prompts`, `prompt:""` | supported |
| text + points | both, `object_id:1` | supported per docs (semantics unverified) |
| boxes | `box_prompts` (floor/ceil outward), `prompt:""` | supported |
| points + boxes | both, shared `object_id:1` | supported per `object_id` docs (unverified) |
| text + boxes (± points) | — | **rejected, HTTP 400** (undocumented) |

## Mask pipeline (all on the backend)

`masks[i].url` → https + host allow-list check → GET **without** `FAL_KEY` (15 s timeout, 20 MB cap, redirects refused) → `png.ts` decode (zlib; colour types 0/2/3/4/6, bit depths 1–16, all filters; interlaced rejected) → binary check → size check/resample → foreground count → background-first RLE (`mask.ts`). Empty masks are dropped together with their own score (so masks/scores stay paired); if none remain the response is `200 {masks: []}`, which the viewer already treats as "no primary mask". FAL URLs are never returned to the viewer. Output `boxes` are not used (the contract has no box field).

## Error mapping (`errors.ts`, mapped in `server.ts`)

| Condition | HTTP |
|---|---|
| bad request body (existing) | 400 |
| unsupported prompt combination | 400 |
| `fal` without `FAL_KEY` / no provider | 501 |
| FAL 401 / 403 (incl. out of balance) | 502 (specific safe message) |
| FAL 422 / 5xx / network / bad mask / bad response | 502 |
| FAL 429 | 503 |
| request timeout / FAL 504 / mask download timeout | 504 |

Messages are client-safe by construction: no key, no payload, no provider body (a 422 reports only the error type and field path), no stack. Server logs carry the same safe message.

## Tests

Backend repo: `node --test fal.test.ts png.test.ts segmentation.test.ts` (44 tests; all HTTP mocked). Real inference: `fal-validate.ts` (not yet runnable, see status).

## Housekeeping

`server.ts` imported `./segmentation` with no extension, which fails under native Node (the backend has no `ts-node` installed and runs on Node 26 type-stripping). It now imports `./segmentation.ts`.
