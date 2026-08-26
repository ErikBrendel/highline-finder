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

30,545 km², i.e. 30,545 source tiles. Scaling region 7 linearly gives 35 M anchors, 106 billion
pairs in range, 1.1 M distinct lines and 151 M hotspot endpoints; the raw surface model would be
~950 GB. Linear is the wrong model and the difference decides the project: the coarse pre-pass
rejects flat ground before a single 1 m tile is fetched, and most of Brandenburg is flat. At the
67 % keep rate region 7 saw, the surface download is ~287 GB; at 10 % it is ~43 GB.

**What the pre-pass still misses is unmeasured.** Simulating it at every threshold and scoring
against the real anchors says both knobs sit on a cliff -- 10 -> 12 m loses 7.6%, coverage
0.02 -> 0.05 loses 9.6% -- but it cannot speak about loosening, because the anchors it scores
against were produced by a run using those values. An anchor the rule skipped is not in the file to
be missed. The honest experiment is to run one region with `maskMinDrop: 0`, fetching everything,
and diff the line set; Mueggelberge is the right size at 22.8 km2 and mixed urban and natural.

**Measure that first.** `loadCoarse` fetches 8192 m chunks at 16 m, so the whole state is ~456
chunks, ~460 MB, minutes, and needs no new code. That one number decides everything below.

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

**Ownership: a line belongs to the chunk containing its first anchor**, "first" being the smaller
`(n, e)` -- which is what the existing `j > i` already means. Recomputing a chunk emits every line
whose first anchor is in it and drops every stored line whose first anchor is in it. A line crossing
a boundary is produced exactly once, by exactly one chunk, with no containment test and no margin to
tune. Ownership is decided on the lattice anchor, before refinement moves it up to 3 m.

**The dirty set for a recompute area S is every chunk intersecting S ⊕ maxLength**, not just the
chunks overlapping S: a line owned by a neighbour can pass over S, and a change to the ground there
makes its verdict stale.

**What still crosses chunks.** Dedup is greedy, so a line near a seam can be suppressed by one in
the next chunk -- run it once over the union at assembly, which is now order-independent (see
`bestFirst`). Hotspots are the one thing that genuinely does not scale, at 151 M endpoints: change
the per-chunk output to a 50 m grid aggregate (count, best score, best endpoint's position), which
merges exactly by summing and maxing, and cluster that at assembly instead.

**What stops fitting in one file.** `candidates.json` is 7 MB for 8,865 lines, so ~790 MB for 1.1 M
-- per-chunk files fetched for whatever is in view, which is hand-rolled vector tiles and the same
pattern the profile fetch already uses. `anchors.json` likewise, or dropped from the default output.
On disk, the `.tif` and the `dn1_*.bin` are both retained; deleting the former once the latter
exists saves ~90 % on bdom.

**Sequencing.** Coarse pass first (no code, decides the rest). Deterministic dedup (done). Then
superchunks with ownership by first anchor; then the hotspot aggregate; then per-chunk output and a
viewer that fetches by view. A debug overlay drawing each chunk with its `generatedAt` is worth
having early -- `Region` already carries that field, so it can be built against today's model.

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

## Viewer

- 3D terrain view with the line drawn in space.
- Re-run the *search* in the browser, not just the measurement. Most of what this needs now exists:
  the WCS gives the browser terrain and canopy for any window, and the openness scan, pairing and
  scoring are all platform-independent. What is missing is running it off the main thread and
  deciding how much area to fetch. Note the canopy discrepancy first -- the WCS resamples where the
  pipeline takes a block maximum, so a browser-side search would be systematically optimistic about
  trees unless the 0.2 m data is used.
- Permalinks to a candidate, and GPX export for the walk in.
