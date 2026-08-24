# Highline Finder

Finds candidate [highline](https://en.wikipedia.org/wiki/Slacklining#Highlining) locations
automatically from open LiDAR elevation data, instead of scanning maps by eye.

Give it one or more bounding boxes. It downloads the terrain and surface models, works out which
points could serve as anchors and in which directions, tests the spans between them against a
sagging-line model, and produces a ranked, browsable set of candidate lines with elevation profiles.

The MVP covers **Brandenburg and Berlin**, where the state survey office publishes 1 m LiDAR
terrain and 20 cm surface models as open data. The default areas of interest are the Sperenberg
gypsum pits south of Berlin (38 m of relief in 1.2 km²) and the Chorin area to the north-east
(18.6 km²).

## Quickstart

```bash
npm install
npm run pipeline      # downloads rasters, computes candidates.json  (~30 s, ~70 MB cached)
npm run dev           # browse the results
```

Custom areas of interest — one rectangle, or several:

```bash
npm run pipeline -- <south> <west> <north> <east> [<south> <west> <north> <east> ...]
```

Areas that come within `maxLength` of each other are rasterised as a single grid, so lines can be
found crossing between them; further apart they are searched independently and the results pooled.
Overlapping areas are allowed — the dedup pass collapses whatever both of them find. See
[`src/pipeline/regions.ts`](src/pipeline/regions.ts).

Rasters are cached in `data/cache/`, so re-runs after a parameter change skip all downloads.
Tunables all live in [`src/pipeline/params.ts`](src/pipeline/params.ts).

```bash
npm test              # unit + integration tests
npm run build         # static bundle in dist/, deployable as-is
```

### Reading it at scale

The `hotspots` toggle draws a red heatmap of every place where *any* feasible line was found, with
the endpoints of all of them collapsed at a 50 m radius and weighted by how many collapsed into
each spot. It answers a different question from the candidate list — not "which line should I walk"
but "which valley is worth a trip" — and it is the layer built to survive a much larger search
area: it is a few tens of kilobytes, and its size grows with *terrain* rather than with area
searched, because flat ground contributes nothing at all. Unlike the candidate list it is built
before dedup and before the `maxCandidates` cap, so a place where four hundred near-identical spans
work burns brighter than one where a single line does.

The pipeline also writes `anchors.json`, a dump of every anchor the openness scan kept. It powers a
development-only overlay (bottom right of the map under `npm run dev`) that draws all of them,
coloured by how many directions are open, with per-point detail on hover. It is gitignored and
never deployed — it is diagnostics for the scan, not a feature.

## The three height layers

| Layer | Product | Resolution | Role |
|---|---|---|---|
| Ground | `dgm` — LiDAR terrain model | 1 m grid | **Hard constraint.** The line must clear it. |
| Vegetation + structures | `bdom` — photogrammetric surface model | 0.2 m grid | **Scored, not enforced.** How much canopy the line runs through. |
| Buildings | `3d_gebaeude` — LoD1/LoD2 CityGML | per building | Not used yet, see ROADMAP. |

Heights are metres above sea level in DHHN2016. Measured agreement between the two models on
open ground is ±0.2 m, which is the practical accuracy ceiling of the whole project.

## How it works

1. **Ingest** — resolve each area to EPSG:25833, download the 1 km tiles it touches, assemble a 1 m
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

**Sag is yours to choose.** The dataset is generated at 5 % of span, the tight end of what people
actually rig, and the sag slider re-derives every clearance and score up to 10 % from the stored
profile. It only tightens: candidates rejected during generation are not in the file, so a looser
setting than 5 % would present an incomplete result as a complete one. Sag is the single most
sensitive parameter in the whole tool — on the default AOI the candidate count runs 124 at 4 %,
65 at 5 %, 31 at 6 % and 16 at 7 %.

**Planning your own line.** Right-click the map to set a custom point A and B, then drag either
anchor to adjust. Dragging an anchor of a *found* line forks it into the planned line, which is the
quick way to try variations on a candidate without losing it. Rig height at each end is a slider
(0-2 m, a little past the 1.5 m an A-frame reaches, so a taller frame can be tried by hand);
`auto` goes back to the level-first choice the search makes. The line is measured live by the same
code the search uses, so its numbers are directly comparable to a found candidate's. It is deliberately exempt from every filter and from
the validity checks — instead of disappearing, an unworkable line tells you *why* it does not
qualify. Terrain comes from the survey's WCS a 256 m window at a time, cached in the browser, so
this works anywhere in Brandenburg rather than only inside the generated AOI.

One caveat: the WCS resamples the 0.2 m surface model server-side, where the pipeline takes the
maximum of each block so the tallest obstacle in a cell wins. Measured against the pipeline's rule
the WCS under-reports canopy by more than a metre on 16 % of cells, so a planned line's canopy
figures are slightly optimistic. Terrain, the hard constraint, matches exactly.

**What the ISA says about height.** The 2015 guidance required a highline be rigged at least
`length/3 + 3 m` above the ground, so that a fall caught by the backup alone would not reach the
ground. Nothing in Brandenburg satisfies that — with 38 m of relief the best candidate here is
short by 22 m — but that rule was **dropped** in the 2017 revision, which instead treats any line
whose height is less than its length as a "low highline" needing a backup tensioned enough that a
mainline failure does not become a ground fall. Every candidate this tool produces is a low
highline in that sense. That is a rigging requirement, and no terrain analysis can discharge it.

- ISA, *Highlining — 10 points*, v3 2015: <https://slackline.us/wp-content/uploads/2015/03/Highlining-10pointsENv3layout.pdf>
- ISA, *Highline — The most important points*, v4 2017: <https://slacklineinternational.org/wp-content/uploads/2017/03/Highline-Important-Points-EN-v4.pdf>

A candidate is a geometric possibility, nothing more. The sag model is a flat 4 % of span, not a
tension calculation. There is no check for anchor strength, land ownership, access, nature
protection status, or — relevant for the default AOI — former military land. Rigging a highline
requires real anchor engineering and the landowner's permission; this tool has no opinion on
either.

## Licence and attribution

Elevation data © GeoBasis-DE/LGB, [dl-de/by-2.0](https://www.govdata.de/dl-de/by-2-0). The
attribution is a licence condition and is displayed on the map.
