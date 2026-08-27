# Roadmap

Everything deliberately left out of the MVP. The MVP is: Brandenburg terrain + canopy, ground
anchors only, one AOI, static viewer.

## Anchors

- **Tree-trunk anchors.** The dominant limitation right now. In the default AOI 55 % of the ground
  is under 15–30 m of pine, and a 2 m A-frame on a hilltop does not clear it — so the geometry
  says "line possible" while the canopy column says "unwalkable". Rigging in the trees is what
  people actually do here. Needs trunk detection rather than canopy height: the `als` classified
  LAZ point clouds can distinguish trunk from crown, and OSM `natural=tree` cross-checks isolated
  trees. Usable anchor height is roughly 80 % of trunk height.
- **No-fall-zone allowance.** Canopy intersection is acceptable close to the anchors — the walker
  is not going to fall there and the branches can be cleared — but must be strict through the
  bulk of the span. Model as a tolerance window of `max(5 m, 2 % of length)` at each end, inside
  which canopy is ignored, and enforce canopy clearance as a hard constraint outside it. This is
  what turns the canopy column from a score into a real filter.
- **Buildings in the coarse pre-pass.** The search now stands on roofs — LoD1 CityGML rasterised
  per 1 km tile, see `src/pipeline/buildings.ts` — but the pre-pass that decides which tiles are
  worth loading at all still measures bare terrain. A flat tile with a thirty-metre building on it
  has thirty metres of usable relief and gets skipped anyway. Fixing it means either loading terrain
  for every tile with a building regardless of relief, which in a town is every tile, or folding
  roof height into the coarse drop field. LoD1 already carries the height, and it is cheap enough to
  fetch before the decision rather than after it, so this is a wiring job rather than a data one.
- **Anchoring to the side of a building, not just the top.** A parapet, a balcony, a beam through a
  window: in practice urban lines are rigged off the structure, not off the roof surface, and the
  usable attachment point is often several metres below the roof and horizontally outside the
  footprint. A roof height cannot express that — the model is an extruded footprint with one height.
  `3d_gebaeude` LoD2 CityGML carries per-building wall and roof geometry with eave and ridge
  heights, which is what a real façade anchor model would need, and is also the point of extending
  properly to Berlin.
- **Anchor quality.** Rock vs. sand vs. loose spoil changes whether a ground anchor is riggable at
  all. Partly derivable from `alkis` land cover and geological maps.
- **Terrain-dependent attachment range.** Every ground anchor currently gets the same 0–2 m range.
  In reality a clean cliff edge can be rigged at ground level while a rounded slope needs a taller
  A-frame just to clear the lip, and a spot with no solid ground has no usable range at all. The
  local terrain shape in the line's direction already tells us which case we are in — it is
  computed during the openness scan and then thrown away.

- **Known-good lines as a regression suite.** The pipeline's recall is currently unfalsifiable: we
  can see what it finds, never what it missed. A handful of hand-picked lines that are known to be
  riggable, checked on every run, turns that into a number — and each miss comes with a reason,
  which is a list of the next things to fix. The first entry is a church-tower-to-rooftop line in
  Eberswalde that the search does not currently produce:
  `a=52.8321541,13.8205483` to `b=52.8291945,13.8212374`. Worth stating the suspects up front, since
  they are all existing entries here: a church tower is a small footprint under a LoD1 model that
  flattens each building to one height, and the coarse pre-pass judges a tile on bare earth so a
  flat square with a tower on it is skipped before the city model is consulted. The value of the
  suite is that it would say which.

  Vehlen is the second entry and a different kind of evidence: highlines have been rigged there in
  reality, and the search returns four candidates from 127,000 pairs in range. Somewhere between
  those two numbers is a filter that is too strict, and a suite is what would name it.

## Physics

- **Coupling the band to the sag control.** The band's half-width is `sideClearanceRatio` of the
  span, fixed at generation time. Physically it should follow the sag: both are `F·L/(4·T)` and
  differ only in which way the load points, so loosening the tension widens the band as surely as it
  deepens the sag — and the browser's sag slider does not move it. Invisible for now, because
  `storeProfiles` is off and the browser re-samples the raster for whichever line is opened, but a
  line with a stored profile under-reports its band at a loosened sag. Two ways to fix it, and the
  choice is a UI question rather than a physics one: derive the band from the live sag, or expose
  tension once and let both fall out of it. A third option is worth considering alongside — letting
  the two be set independently, since "how much sag I rig at" and "how much side excursion I want
  cleared" are separate appetites for risk.

- **Real sag.** Replace the flat fraction-of-span constant with a catenary under tension,
  parameterised by webbing, pretension and walker mass, and evaluate the worst load case rather
  than assuming midspan. Balance Community's relation `S = W·L/(4·T)` gives ~7.9 % for 100 m at
  2.5 kN and ~6.5 % for 275 m at 3 kN with an 80 kg walker, so a constant fraction is the wrong
  *shape*, not just the wrong number — a real model would let sag fall with length at constant
  tension, and expose tension rather than sag as the control.
  <https://www.balancecommunity.com/pages/tension-calculator>
- **The "low highline" backup check.** ISA 2017 requires that where height is less than length —
  which is every candidate this tool finds — the backup be tensioned enough that a mainline failure
  does not put the walker on the ground. That is computable from span, height and backup slack, and
  would turn the honest-but-useless "all of these are low highlines" into a per-candidate figure
  for how much backup tension a site demands.
- **Anchor loads.** Report the tension a candidate implies, which is what decides whether the
  anchors are adequate.

## Search quality

- **Better refinement.** The local hill-climb is coordinate descent over a small neighbourhood, so
  it only reaches a local optimum, and it only runs on candidates that survived deduplication.
  Two real improvements: refine before dedup instead of after (roughly a hundred times the work,
  but nothing good gets discarded first), and escape local optima — levelling one end often has to
  make the score temporarily worse before the other end catches up, which coordinate descent
  cannot see past.
- **Tighten the openness prefilter.** It currently only removes ~80 % of in-range pairs in high
  relief terrain, because a 5 m drop within 120 m is easy to satisfy where there is 38 m of relief.
  Scaling `minProbeDrop` to local relief would sharpen it.
- **Coarse pre-pass at tile granularity.** The 16 m mask rejects ~46 % of ground but still needs
  every 1 km tile on a compact area, because tiles are coarse and the accepted set is dilated by one
  so a line cannot run into unloaded terrain. It only pays where relief is sparse relative to the
  tile grid. Fetching terrain from the WCS by window instead of by published tile would let the mask
  work at its own resolution.
- **OSM beyond Brandenburg.** The shipped blocks come from the Brandenburg extract, which includes
  Berlin and stops at the state border. Extending the search into a neighbouring state means adding
  its extract to `osmRefresh.ts` and re-running — the block grid and the format do not care, but
  nothing currently notices when a region reaches past what was extracted, so it would read as
  empty rather than as missing.
- **Bridges we do not measure.** A crossing tagged `bridge=yes` takes its clearance from the surface
  model, on the reasoning that the photogrammetric model sees the deck. It also sees whatever is
  standing on the deck at the moment of capture, and the railings, so the figure runs a metre or two
  conservative. The right source is the bridge's own surveyed height, which OSM does not carry.
- **A cheaper vegetation source for screening.** With the surface model deferred to line corridors,
  it is still the largest single cost of a large run. A coarse canopy height model would let a line
  be rejected on vegetation before any 0.2 m data is fetched, with `bdom` only for final scoring.
- **Validation set.** Import documented real highlines and assert the finder rediscovers them.
  Nothing else distinguishes "found 2000 candidates" from "found 2000 artefacts".

## Context the results need to be useful

- **Legal and access layer.** Nature protection (Naturschutzgebiet, Landschaftsschutzgebiet, FFH,
  Vogelschutzgebiet), forestry ownership, and — specifically for the default AOI — the former
  former military land, which several parts of Brandenburg still are. A candidate you may not rig is noise.
- **Approach.** Distance and walking time from the nearest road or path via OSM.
- **Seasonality.** The surface model is a single epoch, so leaf-on vs leaf-off changes the canopy
  answer for deciduous stands.
- **Wind and sun exposure** from terrain, which is what makes a line pleasant rather than possible.

## Scale

### All of Brandenburg + Berlin: superchunks

**31,291 source tiles carry terrain, and the coarse pre-pass keeps 5,769 of them -- 18.4 %.**
Measured over the whole cached coarse grid by `src/tools/tileCensus.ts`, 64 windows in 47 s. That
lands near the optimistic end of the range this section used to guess at, and it is the number
everything below rests on: scaling region 7 linearly would have predicted a 67 % keep rate and a
~287 GB surface download.

- Surface model **~190 GB** if every kept tile turns out to carry a line, and ~101 GB at the 53 %
  rate the current seven regions show (336 terrain tiles fetched, 179 of them wanted at 0.2 m).
  Against ~1,033 GB for the state unfiltered.
- Terrain model ~8 GB.
- **562 superchunks of 8x8 km hold any terrain; 357 hold a tile worth loading.** A working
  superchunk averages 16.2 of its 64 tiles, so the 10x10 halo load is a ceiling almost nothing
  reaches.

Two caveats. This is the *terrain* rule alone -- `tilesWithRoofAnchors` adds tiles on flat ground
with a building tall enough to anchor on, worth +84 on 193 for region 7, and measuring it statewide
means a LoD1 fetch for all 31,291 tiles. And the census counts tiles the pre-pass would *fetch*, not
tiles that yield a line: 88 of the 336 fetched today were barren.

Scaling region 7 linearly gives 35 M anchors, 106 billion pairs in range, 1.1 M distinct lines and
151 M hotspot endpoints.

**What the pre-pass misses, measured on Mueggelberge: nothing.** Simulating thresholds and scoring
against the real anchors could only speak about tightening -- the anchors it scored against were
produced by a run using those values, so an anchor the rule skipped was not in the file to be
missed. So the region was rerun with `maskMinDrop: 0`, fetching every tile: 35 of 35 instead of 21,
911,937 points scanned instead of 645,600 (+41 %), and **byte-identical output** -- 7,698 anchors,
5,884,718 pairs in range, 11,951 feasible, the same 148 candidates with the same ids and scores. The
21 tiles it skipped held no anchor at all. Surface tiles were unchanged at 4 of 35, so the whole
experiment cost 17 s and 14 small terrain tiles.

Two things that does *not* establish. The coarse rule is deliberately a low-resolution copy of the
anchor scan's own gate -- `maskMinDrop` mirrors `minDropDepth`, `maskRadius` mirrors
`dropSearchRadius` -- so this says the 16 m approximation agrees with the 1 m test, not that a 10 m
drop is the right thing to require. And Mueggelberge is in Berlin, which has no LoD1 coverage, so
its city model is empty and the roof rule is untested by this. The remaining region that skips
tiles *and* has buildings is Eberswalde, at 277 of 288.

**The statewide coarse pass is done.** 961 chunks of 8192 m at 16 m, 987 MB, 7.2 minutes at 4 lanes
-- 992 over the bbox, of which the northernmost row of 31 is permanently outside the WCS's coverage
and answers HTTP 400 rather than NaN, which `chunkTiff` currently treats as retryable. 543 of the
961 carry any data at all: a rectangle around Brandenburg is about twice the state. See
`src/tools/coarseProbe.ts`. What is still to do is run `dropField` and `tilesWorthLoading` over that
cache -- chunk by chunk with a halo, since the state at 16 m is a 1 GB grid -- for the number all
the sizing below rests on: how many of the 30,545 tiles the pre-pass actually keeps.

**The unit of work becomes a superchunk, not a merged AOI.** An 8×8 block of the existing 1 km
terrain tiles, pinned to EPSG:25833 the way the anchor lattice now is. Tile edges are already the
download, cache and downsample boundaries, so chunk edges land on them for free.

This dissolves the streaming question rather than answering it. A region-wide raster needs an LRU
sampler because the pair search reads 500 m around each anchor in scan order, so the working set is
a band the full width of the region -- 750 tiles at Brandenburg's width, which just thrashes.
Bounding the work bounds the memory at the source: no cache layer, no eviction, no indirection in
the hot loop.

**A superchunk loads 10×10 tiles** -- 400 MB per raster at 1 m, 1.56× overhead:

- 1 tile N, E and W, for the 500 m a partner anchor can sit away. Not S: the anchor scan runs
  south→north, west→east and `terrainPairs` enumerates each pair from the lower-indexed anchor, so
  the partner is always strictly north or due east.
- 1 tile S anyway, because the chunk's own southernmost anchors probe 40 m south
  (`nearProbeLength`) and test their drop 25 m out (`dropSearchRadius`).

**Ownership: a line belongs to the chunk containing its first anchor** (done), "first" being the
smaller `(n, e)` -- which is what the existing `j > i` already means. `terrainPairs` takes an `owns`
box and keeps only the pairs whose first anchor is inside it, half-open so two chunks sharing an
edge divide it. Recomputing a chunk emits every line whose first anchor is in it and drops every
stored line whose first anchor is in it. A line crossing a boundary is produced exactly once, by
exactly one chunk, with no containment test and no margin to tune. Ownership is decided on the
lattice anchor, before refinement moves it up to 3 m. `WorkArea.owns` is the seam; nothing sets it
until `workAreas` emits chunks.

**The dirty set for a recompute area S is every chunk intersecting S ⊕ maxLength**, not just the
chunks overlapping S: a line owned by a neighbour can pass over S, and a change to the ground there
makes its verdict stale.

**What still crosses chunks.** Dedup is greedy, so a line near a seam can be suppressed by one in
the next chunk -- run it once over the union at assembly, which is now order-independent (see
`bestFirst`). Hotspots were the one thing that genuinely did not scale, at 151 M endpoints; done, as
a 25 m grid aggregate (count, best score, best endpoint's position) that merges exactly by feeding
cells back through the same reduction, clustered at assembly.

**What stops fitting in one file.** `candidates.json` is 7 MB for 8,865 lines, so ~790 MB for 1.1 M
-- per-chunk files fetched for whatever is in view, which is hand-rolled vector tiles and the same
pattern the profile fetch already uses. `anchors.json` likewise, or dropped from the default output.
On disk the source `.tif` is now deleted once its reduced grid exists, which halves the cache and
takes ~90 % off bdom.

**Sequencing.** Done so far: deterministic dedup, ownership by first anchor, the hotspot grid
aggregate, `.tif` deletion, and a debug view drawing each region's box with its vintage. Measured
together on the seven regions: the line set is unchanged (9,660, every id shared), the region cache
falls 68.6 -> 25.3 MB, and 1.39 M feasible endpoints reduce to 3,926 cells, which cluster to 1,293
spots against 1,360 before -- the same total weight, a few adjacent spots merged.

Also done: the statewide coarse pass, the `maskMinDrop: 0` experiment, and the chunk grid itself.
`chunks.ts` runs *beside* areas of interest rather than replacing them -- same search code, same
pooled dataset, but selected, cached and recomputed independently, so ground can move from one
mechanism to the other a piece at a time. Four chunks south of Eberswalde are claimed and seeded
empty.

**Chunk 52_728 is searched, and the ownership rule holds on real ground.** 293 candidates, and all
293 have their first anchor inside the owned square. 18 of them reach outside it, up to 190 m, which
is the halo doing exactly its job -- those lines exist only because anchors a kilometre beyond the
chunk were scanned as partners. 26.8 s of processor in 607 s of clock, essentially all of it
downloading. The 10x10 km load is 100 M cells per raster, as designed.

**The roof rule is the pre-pass's weak point, and this is the first measurement of it.** On this
chunk the terrain rule kept 25 of 121 tiles -- 21 %, right in line with the statewide 18.4 % -- and
`tilesWithRoofAnchors` then pulled in the other 96. `maskMinRoofs: 1` qualifies a tile on a single
building 10 m above nearby ground, and the result is dilated by `maxLength`, so one village claims
its whole 3x3 neighbourhood. Mueggelberge could not see this: it is in Berlin, where the city model
is empty.

What that costs is narrower than it first looks, because the surface model is gated by
`corridorTiles` -- the tiles a surviving line actually crosses -- and not by the pre-pass at all.
Only 20 of the 121 were fetched at 0.2 m. So the roof rule costs terrain bandwidth and scan compute,
not the expensive layer: statewide it is the difference between ~8 GB and the full ~44 GB of DGM,
and between scanning 20 % of the ground and all of it. The surface estimate above stands.

**Tuned, by raising the bar rather than the count.** `maskMinRoofDrop` is now 25 m, well above the
`minDropDepth` of 10 m a line actually has to clear -- deciding a tile is worth fetching at 1 m is a
stricter question than deciding a roof is worth anchoring on. Re-measured on the same chunk: 121 ->
69 tiles loaded (44 for roofs rather than 96), 20 -> 13 surface tiles, 4.0 M -> 2.0 M points scanned,
and 293 -> 274 candidates. The 19 lost are all urban, the best of them scoring 66.0 against a best
kept of 67.1.

The trade is one-sided and worth restating: an ordinary rooftop line in a small settlement is not
missed, it is never looked for, because its tile is never fetched. And "most good lines are natural"
is only true at the very top -- across the dataset the split is 47/6/47 natural/mixed/urban, and
urban is 63 % of the top thousand, giving way to natural only in the top hundred (75 %) and top
twenty (80 %). Lower this when urban coverage matters more than statewide reach.

**All four chunks are searched, and the seams hold.** 4,502 distinct lines across the 2x2 block,
**zero duplicated between chunks**, 356 crossing a seam into a neighbour and 15 reaching out of the
block entirely -- all of which exist only because each chunk scans a kilometre beyond itself. Four
lines have a first anchor 0.50 m outside their own square, which is refinement nudging a lattice
anchor at 423997.5 by its full `refineRadius` of 3 m after ownership was already decided. Bounded,
and harmless: both neighbours decide on the same pre-refinement lattice anchor, so neither can claim
the other's line.

**Rooftop anchors are opt-in by place**, via `URBAN_AREAS` -- empty, so the search is natural-only
everywhere until a rectangle says otherwise. Buildings are still merged into the ground, so they
still block a line; what stops is standing an anchor on one, and fetching a tile on the strength of
its roofs. Measured over the eight chunks, 512 km2: tiles loaded 404 -> 177, lines 7,241 -> 3,074,
**surface tiles 161 -> 52**, so 5.3 GB of bDOM becomes 1.7 GB. Four of the eight now need no
full-resolution data at all.

The saving is concentrated exactly where it has to be. The two hilliest chunks barely moved --
52_729 kept 2,071 of 2,104 lines and 53_729 kept 855 of 878 -- while the flat ones went to nothing.
Statewide the terrain rule keeps 18.4 % of tiles, so 82 % of Brandenburg is the second case.

**Eighteen chunks are searched**, a 144 x 8 km strip from E 392000 to E 464000 across rows 728-729,
1,152 km2 owned. What it actually cost:

- 346 of a possible 1,800 tiles loaded at 1 m, **none of them for a roof**, 484 MB of DGM.
- 85 surface tiles, 2.8 GB of bDOM, against 59.4 GB had every loaded tile been fetched at both
  resolutions.
- 3,251 lines, and five chunks produced none at all while needing no surface model whatsoever.

The spread is the point. `52_729` and `53_729` hold 2,926 of the 3,251 lines between them; six of
the eighteen loaded nothing at 1 m and four more found nothing worth keeping. That is 1,152 km2 of
Brandenburg costing 3.3 GB, where the same ground with rooftop anchoring everywhere would have run
several times that.

Left, in order: work-stealing tile handout; then dirty-set selection (a recompute area implies every
chunk within `maxLength` of it); then per-chunk candidate files and a viewer that fetches by view.

One refinement for later: halo anchors are re-scanned by each neighbouring chunk (~23 % redundant at
8 km). Persisting the per-chunk anchor table and letting neighbours read it removes that; the tables
are ~7 MB per chunk.
- **Other German states.** Each runs its own portal with its own tiling, formats and licence.
  NRW, Bavaria, Saxony and Thuringia all publish comparable 1 m models.
- **WCS instead of tile downloads.** `bb_dgm` serves arbitrary bounding boxes, which avoids
  fetching whole tiles for a small AOI.
- **Vector tiles for candidates.** One JSON stops working somewhere around 10⁴ candidates.
- **Road crossings are the most expensive thing per line.** The stage report splits `evaluateLine`
  by phase, and on Tropical `RoadIndex.crossings` is 32% of the whole run -- more than the banded
  terrain profile it gates, and more than scoring. It is called once per surviving pair and again
  on every refinement step, and it re-walks the bucket grid from scratch each time. Two obvious
  moves: cache the near-set per anchor pair across a refinement's steps, since the line barely
  moves; and skip it entirely where the corridor's buckets are empty, which is most of Brandenburg.
- **The dedup and refinement order is still region-relative.** The anchor lattice is now fixed to
  the projection, so growing an area of interest scans the same ground at the same points. What
  still moves is which of several near-identical candidates dedup keeps: it walks the list in score
  order and a new neighbour can displace an old winner, and refinement then hill-climbs from a
  different start. That is a much smaller effect than the lattice was, and it only reaches as far as
  `dedupRadius`, but it means an expansion is not yet strictly additive.
- **The pool is bounded by its slowest chunk, not by its total work.** Region 7 runs 401s of
  processor time in 92s of clock, which is 4.4 of a possible 9. Sixteen chunks per worker took it
  from 4.2; finer still trades against the per-chunk message, and the real fix is chunks sized by
  the anchors they contain rather than by index range, since a band over a town holds far more pairs
  than one over a lake.

### Fetch the surface model for the lines that survive, not for every pair

Not done, and worth doing on its own merits. `corridorTiles` runs on `found.pairs` -- every pair
that cleared the terrain, 25,500 of them on chunk 52_728 -- before anything has been scored. The
corridors of the 274 lines that actually survived cover 8 tiles against the 13 fetched, so roughly
a third of the surface download is bought for pairs that are about to be thrown away.

The restructure is a second pass: score once without canopy, since clearance, exposure and road
crossings do not need it, keep the survivors, fetch the surface model for their corridors, then
re-score with the canopy gate applied. Only 36 of ~20,000 rejections on that chunk were canopy, so
the first pass produces very nearly the right survivor set.

Independent of the urban rectangles above, and stacks with them.

### Line length: postponed, and here is why

`maxLength` is 500 m. Raising it was priced in both directions and shelved; these numbers are here
so the question does not get asked from scratch again.

**What it would cost.** Statewide pre-pass keep rate, measured over the cached coarse grid with
`tileCensus.ts <seconds> <reach>`, since `tilesWorthLoading` grows every passing cell into a
`ceil(L/1000)`-tile ring:

| reach | tiles kept | of the state | surface | halo | chunk load |
|-------|-----------|--------------|---------|------|------------|
| 500 m | 5,769 | 18.4 % | ~190 GB | 1 tile | 10x10 km, 400 MB/raster |
| 800 m | 6,557 | 21.0 % | ~216 GB | 1 tile | 10x10 km, 400 MB/raster |
| 1500 m | 10,201 | 35.0 % | ~337 GB | 2 tiles | 12x12 km, 576 MB/raster |
| 3000 m | 15,632 | 53.6 % | ~516 GB | 3 tiles | 14x14 km, 784 MB/raster |

The pair search is separately quadratic in `maxLength` -- every anchor scans a 3x3 grid of cells of
that side -- so 800 m is 2.6x and 3 km is 36x on a stage that is a third of the run. Region 7's
pairing is 141 s of processor at 500 m.

**What it would buy: less than nothing past about a kilometre.** A span sags `sagRatio * L` = 5 % of
its length, so the ground has to fall that far below the anchors within roughly `L/2`. Counted on the
coarse grid over three windows including the best relief in the state:

| span | sags | needs | ground that could hold it |
|------|------|-------|---------------------------|
| 500 m | 25 m | 28 m within 250 m | 1.945 % |
| 800 m | 40 m | 43 m within 400 m | 1.089 % |
| 1200 m | 60 m | 63 m within 600 m | 0.574 % |
| 2000 m | 100 m | 103 m within 1000 m | 0.039 % |
| 3000 m | 150 m | 153 m within 1500 m | **0 of 16 million cells** |

Brandenburg's entire relief is 151 m, so a 3 km line has nowhere to be. Raising the limit there buys
a 2.7x download and 36x the pair search to find nothing.

**Two things fall out of that.** The cliff is at exactly 1000 m, where `ceil(L/1000)` ticks over and
the halo, the chunk memory and the dilation ring all step together -- everything below is nearly
free and the first metre above is a step change. And the present cap is barely binding: 2 lines of
13,634 reach 500 m, against 220 in the 450-500 m band and a tail that was already decaying.

**If it is ever revisited**, 800 m is the only candidate, and the cheap test is to raise it on an
already-downloaded chunk such as 52_729 and count what appears -- minutes of compute and no new
downloads. The deeper question is `sagRatio` itself: a constant fraction of span is a stand-in, not a
model, and it is what makes long spans impossible here. A catenary would not change the conclusion
by much, but it would change these numbers.

## Viewer

- 3D terrain view with the line drawn in space.
- Re-run the *search* in the browser, not just the measurement. Most of what this needs now exists:
  the WCS gives the browser terrain and canopy for any window, and the openness scan, pairing and
  scoring are all platform-independent. What is missing is running it off the main thread and
  deciding how much area to fetch. Note the canopy discrepancy first -- the WCS resamples where the
  pipeline takes a block maximum, so a browser-side search would be systematically optimistic about
  trees unless the 0.2 m data is used.
- Permalinks to a candidate, and GPX export for the walk in.
