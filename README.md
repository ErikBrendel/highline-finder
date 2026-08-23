# Highline Finder

Finds candidate [highline](https://en.wikipedia.org/wiki/Slacklining#Highlining) locations
automatically from open LiDAR elevation data, instead of scanning maps by eye.

Give it a bounding box. It downloads the terrain and surface models, works out which points could
serve as anchors and in which directions, tests the spans between them against a sagging-line
model, and produces a ranked, browsable set of candidate lines with elevation profiles.

The MVP covers **Brandenburg and Berlin**, where the state survey office publishes 1 m LiDAR
terrain and 20 cm surface models as open data. Default area of interest is the Sperenberg gypsum
pits south of Berlin (38 m of relief in 1 km²).

## Quickstart

```bash
npm install
npm run pipeline      # downloads rasters, computes candidates.json  (~30 s, ~70 MB cached)
npm run dev           # browse the results
```

Custom area of interest:

```bash
npm run pipeline -- <south> <west> <north> <east>
```

Rasters are cached in `data/cache/`, so re-runs after a parameter change skip all downloads.
Tunables all live in [`src/pipeline/params.ts`](src/pipeline/params.ts).

```bash
npm test              # unit + integration tests
npm run build         # static bundle in dist/, deployable as-is
```

## The three height layers

| Layer | Product | Resolution | Role |
|---|---|---|---|
| Ground | `dgm` — LiDAR terrain model | 1 m grid | **Hard constraint.** The line must clear it. |
| Vegetation + structures | `bdom` — photogrammetric surface model | 0.2 m grid | **Scored, not enforced.** How much canopy the line runs through. |
| Buildings | `3d_gebaeude` — LoD1/LoD2 CityGML | per building | Not used yet, see ROADMAP. |

Heights are metres above sea level in DHHN2016. Measured agreement between the two models on
open ground is ±0.2 m, which is the practical accuracy ceiling of the whole project.

## How it works

1. **Ingest** — resolve the AOI to EPSG:25833, download the 1 km tiles it touches, assemble a 1 m
   terrain grid and a 1 m surface grid (the 0.2 m surface model is downsampled by *max*, because
   for clearance the tallest obstacle in a cell is the one that matters).
2. **Openness scan** — for every point on a 5 m grid, cast a ray in each of 64 directions and
   record a bitmask of the sectors where a line could actually leave: nothing in the way, and the
   ground falls away far enough. This stage is *linear* in area and independent per tile.
3. **Pairing** — only test pairs that are open *towards each other*. Two array lookups per pair,
   no raster access, which is what keeps the quadratic part affordable.
4. **Heights and offlevel** — each anchor has a *range* of usable attachment heights (ground level
   at a clean edge, up to a 2 m A-frame), so the search picks the pair of heights that is as level
   as possible and then as high as possible. Height difference is hard-capped at 2 % of span — 1 m
   over 50 m, 10 m over 500 m. This is what stops the finder proposing badly tilted lines.
5. **Profile** — sample the span, apply parabolic sag, measure clearance to terrain and to canopy.
6. **Score and dedup** — filter, rank, then collapse near-duplicates: two lines are the same when
   *both* endpoints are within `dedupRadius`, so lines sharing one anchor survive as the different
   lines they are.
7. **Refine** — hill-climb both anchors of each surviving candidate to a local score maximum,
   moving each end up to `refineRadius` from where the lattice put it. This is what stops the 5 m
   anchor grid being the limiting factor on where an anchor is reported, and it mostly pays off by
   finding a position where the two ends level out exactly.

The naive search is every pair of cells: ~3.7 × 10¹¹ for 1 km². Stages 2–4 bring that to
something that runs in half a minute. Each stage logs how many pairs it eliminated, so the
trade-off is measurable rather than assumed.

Details, parameters and known limitations are documented in the module that owns them:
[`params.ts`](src/pipeline/params.ts) (every tunable),
[`cache.ts`](src/pipeline/cache.ts) (data sources and their caveats),
[`raster.ts`](src/pipeline/raster.ts),
[`openness.ts`](src/pipeline/openness.ts) (algorithm and its completeness bound),
[`lines.ts`](src/pipeline/lines.ts) (sag model, clearance rules, scoring),
[`types.ts`](src/shared/types.ts) (output schema).

## Reading the results

**Terrain clearance is enforced; canopy is only scored.** In closed forest most candidates will
have a high "canopy blocked" figure and are not walkable as they stand. That column is the real
filter, not the score. Sort by it.

A candidate is a geometric possibility, nothing more. The sag model is a flat 4 % of span, not a
tension calculation. There is no check for anchor strength, land ownership, access, nature
protection status, or — relevant for the default AOI — former military land. Rigging a highline
requires real anchor engineering and the landowner's permission; this tool has no opinion on
either.

## Licence and attribution

Elevation data © GeoBasis-DE/LGB, [dl-de/by-2.0](https://www.govdata.de/dl-de/by-2-0). The
attribution is a licence condition and is displayed on the map.
