# Highline Finder

Finds candidate [highline](https://en.wikipedia.org/wiki/Slacklining#Highlining) locations
automatically from open LiDAR elevation data, instead of scanning maps by eye.

Give it one or more bounding boxes. It downloads the terrain and surface models, works out which
points could serve as anchors and in which directions, tests the spans between them against a
sagging-line model, and produces a ranked, browsable set of candidate lines with elevation profiles.

The MVP covers **Brandenburg and Berlin**, where the state survey office publishes 1 m LiDAR
terrain and 20 cm surface models as open data. The default areas of interest are **Tropical** south
of Berlin (38 m of relief in 1.2 km²), **Niederfinow** to the north-east (141 km², 151 m of relief),
**Müggelberge** in south-east Berlin (23 km²), and **Linthe** and **Vehlen** to the west (4.9 and
11.5 km²).

## Quickstart

```bash
npm install
npm run pipeline      # downloads rasters, computes candidates.json
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

Rasters are cached in `data/cache/`, so re-runs after a parameter change skip all downloads. The
0.2 m surface model is also reduced to 1 m once per tile and kept, since decoding it was 43 % of a
full run and always produces the same answer; that step spreads across processes. To fill the cache
for particular tiles ahead of time:

```bash
npm run downsample -- bdom 1 33407-5784 33408-5784
```
Tunables all live in [`src/pipeline/params.ts`](src/pipeline/params.ts).

```bash
npm test              # unit + integration tests
npm run build         # static bundle in dist/, deployable as-is
```

### Where the elevation profiles live

`storeProfiles` in [`params.ts`](src/pipeline/params.ts) decides whether each line ships with its
own elevation profile. Off (the default), `candidates.json` holds 17,848 lines in 11 MB; on, the
same lines would be roughly 100 MB, because profiles were 89 % of the file. The browser rebuilds the
profile for whichever line you open, from the same elevation service and the same code the planner
uses, so the chart and the exact metrics are unchanged — they just arrive a moment later, and one
`maxSagRatio` per line keeps the sag control filtering the whole dataset exactly either way.

Turn it on if you want the dataset self-contained and offline; leave it off if you want it to hold
far more lines.

### Seeing what the pipeline fetched

The `debug layers` button cycles three views of the pipeline itself. Development only, like the
anchor overlay: `mask.json` and `tiles.json` are gitignored and never deployed, since these describe
the pipeline rather than the terrain.

- **coarse drop** — what the 16 m pre-pass concluded, greyed where it fell below the threshold.
- **terrain tiles** — the 1 km tiles the terrain model was fetched for. Green where the exact 1 m
  scan then found anchors, amber where it found none (the filter being too loose), dark where the
  tile was skipped (a dark tile beside a busy one is it being too tight).
- **surface tiles** — the tiles the surface model was fetched for, which is only where a line
  actually crosses. This is the filter that works: 1 of 9 tiles at Vehlen, 66 of 156 at
  Niederfinow.

The gap between the first view and the second is the point: a decision taken at 16 m cannot be
acted on when the data arrives in 1 km units.

### Sharing a view

The URL tracks the map, so any view can be copied out of the address bar and sent:

| Parameter | Meaning |
|---|---|
| `at=s,w,n,e` | Viewport rectangle. A rectangle rather than centre + zoom, so the recipient sees the same ground on a differently sized window. |
| `line=<id>` | Selected candidate. |
| `a=lat,lon` `b=lat,lon` | The planned line's anchors — or, when a candidate is selected and no planned line is placed, that candidate's own coordinates as a fallback. |
| `rig=hA,hB` | Manual rig heights, in metres above ground. Absent means auto. |
| `sag=pct` | Midspan sag, as a percent of span. |
| `map=n` | Basemap blend: `0` ortho, `1` hillshade, `2` OSM, fractions cross-fade. |

Candidate ids are derived from anchor coordinates, so regenerating the dataset with different
parameters can move an anchor and orphan an id. That is why a shared candidate carries its geometry
too: if the id no longer resolves, the same line is rebuilt and measured live as a planned line, so
the link goes stale rather than broken.

### A band, not a ray

A line is not a ray, and measuring it as one lets it thread between two pines three metres apart, or
down a corridor between two buildings, and report clear air. Wind and the walker's own weight push
it sideways, so clearance is measured across a lens: zero half-width at each anchor, where the line
is pinned, widest at midspan.

The half-width is a fraction of span — 4 % by default — because it is the same physics as the sag. A
tensioned line deflects by `F·L/(4·T)` whichever direction the load points, so a side excursion is a
sag turned through ninety degrees and belongs in the same units. 4 % against the 5 % sag asserts a
side load about 80 % of body weight, more than wind alone but about what a walker leaning or falling
sideways puts in. It scales the way the problem does: a 60 m urban line gets ±2.4 m, which is what
stops it threading a gap between buildings, while a 400 m line over a valley gets ±16 m of air it
was never going to touch anything with.

Three things are deliberately *not* measured across the band. Exposure is how high the line is over
what is directly beneath it, so it stays a centreline figure. Canopy stays a centreline figure too:
it is scored rather than enforced, because the surface model carries a 21-month epoch mismatch, and
widening a soft measurement only compounds it — the profile chart draws the band's vegetation
instead, one shade lighter, so a line threading two pines is visible without being rejected for it.
And the cheap terrain gate in the pair search still runs on the centreline, which costs nothing:
a band always contains its centreline, so it can only ever remove candidates.

### What the line passes over

Terrain clearance is a flat 3 m, which is the right number over a field and the wrong one over a
motorway. So every line is measured against the OSM road and rail network, and each crossing raises
the clearance owed at that point:

| | extra | total | OSM |
|---|---|---|---|
| path | +0 m | 3 m | `path` `footway` `bridleway` `steps` `track` `pedestrian` |
| cycle | +3 m | 6 m | `cycleway`, grade1–2 `track`, driveways |
| street | +8 m | 11 m | `residential` `living_street` `unclassified` `service` |
| road | +12 m | 15 m | `tertiary` `secondary` `primary` |
| highway | +20 m | 23 m | `motorway` `trunk` `busway`, and every railway |

The ladder is about what can be closed for a rigging day rather than about size alone: a forest path
gets taped off for an afternoon, a motorway does not, and a railway carries 15 kV on a wire 5.5 m
over the rail. For scale, German law wants 4.50 m of clearance over a road and 4.70 m under new
motorway structures — these run to five times that, because a bridge deck is rigid and surveyed
while a slackline sags under a walker.

A road counts when it comes within the band, not only when the span crosses it — a road two metres
to the side is under the line as soon as the wind gets up, which is the same reason clearance is
measured across a band at all. Crossing is then just the case where that distance is zero. So a road
running *beside* the line for two hundred metres, which a segment-intersection test cannot see at
all, is no longer invisible, and each entry covers the stretch of span the road is under the band
for rather than a single point on it. There is no discount for being off to the side: inside the
band, a road is owed its full clearance.

Vectors rather than a raster, because OSM gives a centreline plus an optional width tag: rasterising
would mean inventing a width, drawing the invention at 1 m and then measuring it back. Working with
the segments gives exact distances along the span, which is also what the profile chart draws. Tunnels are ignored — a road in a tunnel is under the ground the line is already measured
against — and a bridge is measured against its deck, which the terrain model has no idea exists but
the photogrammetric surface model does.

### The OSM data ships with the app

Roads and water used to be fetched from the public Overpass API at run time, by the pipeline and the
browser separately. That was wrong twice over. It is a shared community service, and asking it for a
state's road network got this project's machine refused outright — 112 one-square-kilometre queries
was enough. And the two halves asked it independently, so they could disagree about what a line
passes over, which is the exact thing the project refuses to allow for terrain and roofs.

So `npm run osm` extracts it once from a Geofabrik dump and commits the result:

```
brandenburg-latest.osm.pbf   285 MB   downloaded once, cached, gitignored
  ↓  1.1 M roads, 36 k railways, 29 k water outlines
src/web/public/osm/*.bin      32 MB   702 blocks of 8 km, committed via Git LFS
```

Coordinates are decimetres of EPSG:25833, delta-encoded along each way, gzipped — about four bytes
per point. A tenth of a metre is finer than anything else here measures (the rasters are 1 m), and
it is what keeps a crossing's position along a span exact enough to draw.

The pipeline reads the blocks its region touches; the browser fetches the one to four a line needs
and keeps them in the same IndexedDB store as the elevation windows. **Neither asks anything of a
third party at run time**, and both read the identical bytes, so a planned line and a found one
cannot disagree. A block that is not in `index.json` means there is genuinely nothing in that
square; a block that *is* listed and will not load is a broken deployment, and says so.

The script is deliberately separate from the search pipeline: that one is about one area of interest
and re-runs whenever a parameter changes, this one is about the whole state and changes only when
OpenStreetMap does.

**Working on this repo needs `git lfs install` first**, and the Pages workflow checks out with
`lfs: true`. Without either, the blocks arrive as 130-byte pointer files and every one of them reads
as empty.

### Natural, mixed and urban

Every line is filed by what its two ends stand on — both on the ground is **natural**, both on roofs
is **urban**, one of each is **mixed** — and the three are stored as three lists in
`candidates.json` rather than one list with a label on each line. The hotspot layer is clustered
three times over and split the same way. Three toggles in the filter panel switch them.

The classification is about the *anchors*, not the surroundings. A ground-to-ground line threading
between two houses is still natural, because what makes an urban line urban is having to get onto a
building and be allowed to rig off it: a different approach, a different permission and different
gear from walking into a forest. Classifying by what happens to be nearby would put those two in the
same bucket.

It matters more than it sounds. Extending the search over Eberswalde made roof-to-roof lines the
majority of the dataset — 9,424 urban against 6,593 natural and 1,831 mixed — which drowned the
forest lines the tool was built to find. But the same buildings are where the clean lines are: of
5,573 lines with no canopy blockage at all, 5,147 are urban, because a roof is the one place in
Brandenburg with nothing growing above it. So the answer is a filter rather than a rule against
them.

### Reading it at scale

The `hotspots` layer, on by default, draws a red heatmap of every place where a line worth a trip
was found — at most 20 % canopy blockage *and* scoring at least 55 — with
the endpoints of all of them collapsed at a 50 m radius and weighted by how many collapsed into
each spot. It answers a different question from the candidate list — not "which line should I walk"
but "which valley is worth a trip" — and it is the layer built to survive a much larger search
area: it is a few tens of kilobytes, and its size grows with *terrain* rather than with area
searched, because flat ground contributes nothing at all. Unlike the candidate list it is built
before dedup and before the `maxCandidates` cap, so a place where four hundred near-identical spans
work burns brighter than one where a single line does. It fades out between zoom 14 and 16,
where individual candidates become legible and are the better answer.

Both conditions are needed. Blockage alone marked a pine thicket whose best line scored 39; score
alone would mark ground where nothing is walkable. Score already folds canopy together with
exposure and length, so it separates the cases blockage cannot.

The pipeline also writes `anchors.json`, a dump of every anchor the openness scan kept. It powers a
development-only overlay (bottom right of the map under `npm run dev`) that draws all of them,
coloured by how many directions are open, with per-point detail on hover. It is gitignored and
never deployed — it is diagnostics for the scan, not a feature.

## Everything fetched is cached, on both sides

A standing rule rather than an optimisation. Every external source this project touches is cached
where it is used, so re-running the pipeline or reopening the browser on a line you looked at
yesterday costs no request at all.

| Source | Pipeline | Browser |
|---|---|---|
| `dgm` / `bdom` tiles | `data/cache/*.tif` | — |
| `dgm` / `bdom` WCS windows | `data/cache/coarse*.tif` | IndexedDB |
| `3d_gebaeude` LoD1 | `data/cache/lod1_*.gml` | IndexedDB |
| OSM roads and water | `data/cache/roads_*.json` | IndexedDB |
| Basemap tiles | — | IndexedDB |
| Whole-region results | `data/cache/region_*.json` | — |

Two consequences worth knowing. A 404 is an answer and is cached as one — an empty file — so a tile
with no buildings on it is asked for once and never again. And the cache is what makes a failed run
resumable: the road fetch is fatal by design, and restarting after one picks up where it stopped
rather than starting over.

The granularity is deliberately finer than the request. Roads are *fetched* per 5 km block, because
a hundred one-kilometre queries got the machine refused by Overpass, but they are *cached* per 1 km
tile — so growing an area of interest still only fetches what it added.

## The three height layers

| Layer | Product | Resolution | Role |
|---|---|---|---|
| Ground | `dgm` — LiDAR terrain model | 1 m grid | **Hard constraint.** The line must clear it. |
| Vegetation + structures | `bdom` — photogrammetric surface model | 0.2 m grid | **Scored, not enforced.** How much canopy the line runs through. |
| Buildings | `3d_gebaeude` — LoD1 CityGML | per building | **Hard constraint, and an anchor.** Merged into the ground layer, so a line must clear a roof and may also be rigged off one. |
| Roads and rail | OpenStreetMap, shipped with the app | vector centrelines | **Hard constraint.** Raises the clearance the line owes wherever it passes over traffic. |

Heights are metres above sea level in DHHN2016. Measured agreement between the two models on
open ground is ±0.2 m, which is the practical accuracy ceiling of the whole project.

## How it works

1. **Coarse pre-pass** — fetch a 16 m terrain grid from the survey's WCS (which supports the OGC
   scaling extension, so no coarser product is needed) and mark ground that never falls more than
   `maskMinDrop` within `maskRadius`. At ~15 KB per km² against 1.4 MB for the 1 m tiles, this is
   effectively free. **Measured caveat:** it does not currently save anything. Source data arrives
   in 1 km tiles, and the relief that passes the test is scattered at a finer scale than that, so
   every tile in every area is still needed — Vehlen rejects 90 % of cells and skips 0 of 9 tiles.
   No threshold fixes it: at 12 m Niederfinow needs 79 % of its tiles and keeps 90 % of its lines.
   It is kept as diagnostics, not as an optimisation. The `debug layers` toggle draws it, alongside
   what was actually fetched per tile.
2. **Ingest** — resolve each area to EPSG:25833, download the 1 km terrain tiles it touches and
   assemble a 1 m grid. The surface model is *not* fetched yet: it is 33 MB per km² against the
   terrain model's 1.4 MB, and canopy is only ever scored, never enforced, so it is fetched in
   step 5 for the corridors that survive (the 0.2 m data is downsampled by *max*, because for
   clearance the tallest obstacle in a cell is the one that matters).
3. **Openness scan** — for every point on a 5 m grid, cast a ray in each of 64 directions and
   record a bitmask of the sectors where a line could actually leave: nothing in the way, and the
   ground falls away far enough. This stage is *linear* in area and independent per tile.
4. **Pairing** — anchors are bucketed on a `maxLength` lattice so only the nine buckets around one
   anchor can hold a partner in range, which makes the enumeration output-sensitive rather than
   quadratic. Surviving pairs must also be open *towards each other*: two array lookups per pair,
   no raster access.
5. **Heights and offlevel** — a ground anchor has a *range* of usable attachment heights (ground
   level at a clean edge, up to a 1.5 m A-frame), so the search picks the pair of heights that is as
   level as possible and then as high as possible. A roof anchor has no range at all: the line goes
   on the parapet or the structure, both of which sit at roof level, so it attaches exactly where
   the roof is and the pair has to be level enough on its own. Height difference is hard-capped at 3 % of span — 1.5 m
   over 50 m, 15 m over 500 m. This is what stops the finder proposing badly tilted lines.
6. **Profile** — sample the span, apply parabolic sag, measure clearance to terrain across the band
   and to canopy on the centreline.
7. **Score and dedup** — filter, rank, then collapse near-duplicates: two lines are the same when
   *both* endpoints are within `dedupRadius`, so lines sharing one anchor survive as the different
   lines they are.
8. **Refine** — hill-climb both anchors of each surviving candidate to a local score maximum,
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
