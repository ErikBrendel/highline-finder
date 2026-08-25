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

- **All of Brandenburg + Berlin.** The blocker is data volume, not compute: the surface model is
  ~32 MB per km² zipped, so the whole state is ~950 GB. The cache must reduce to a 1 m normalised
  surface on ingest and discard the 0.2 m source. The openness scan is already per-tile
  independent, so it parallelises directly.
- **Other German states.** Each runs its own portal with its own tiling, formats and licence.
  NRW, Bavaria, Saxony and Thuringia all publish comparable 1 m models.
- **WCS instead of tile downloads.** `bb_dgm` serves arbitrary bounding boxes, which avoids
  fetching whole tiles for a small AOI.
- **Vector tiles for candidates.** One JSON stops working somewhere around 10⁴ candidates.

## Viewer

- 3D terrain view with the line drawn in space.
- Re-run the *search* in the browser, not just the measurement. Most of what this needs now exists:
  the WCS gives the browser terrain and canopy for any window, and the openness scan, pairing and
  scoring are all platform-independent. What is missing is running it off the main thread and
  deciding how much area to fetch. Note the canopy discrepancy first -- the WCS resamples where the
  pipeline takes a block maximum, so a browser-side search would be systematically optimistic about
  trees unless the 0.2 m data is used.
- Permalinks to a candidate, and GPX export for the walk in.
