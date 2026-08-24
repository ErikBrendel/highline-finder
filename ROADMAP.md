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
- **Buildings in the pipeline.** The viewer treats a roof as ground — ALKIS footprints fetched per
  256 m window, see `src/web/terrain.ts` — so an anchor dropped on a building stands on it and a
  line has to clear one it crosses. The search still does not: it runs its lines through houses and
  counts roofs as forest. Per-corridor WMS requests are the wrong shape for a pipeline; the bulk
  equivalent is `alkis/Vektordaten/shape/` (80–100 MB per Landkreis, buildings and water as
  polygons), rasterised once per AOI to a 1 m mask.
- **Anchoring to the side of a building, not just the top.** A parapet, a balcony, a beam through a
  window: in practice urban lines are rigged off the structure, not off the roof surface, and the
  usable attachment point is often several metres below the roof and horizontally outside the
  footprint. The footprint mask cannot express that — it is 2D. `3d_gebaeude` LoD2 CityGML carries
  per-building wall and roof geometry with eave and ridge heights, which is what a real façade
  anchor model would need, and is also the point of extending properly to Berlin.
- **Anchor quality.** Rock vs. sand vs. loose spoil changes whether a ground anchor is riggable at
  all. Partly derivable from `alkis` land cover and geological maps.
- **Terrain-dependent attachment range.** Every ground anchor currently gets the same 0–2 m range.
  In reality a clean cliff edge can be rigged at ground level while a rounded slope needs a taller
  A-frame just to clear the lip, and a spot with no solid ground has no usable range at all. The
  local terrain shape in the line's direction already tells us which case we are in — it is
  computed during the openness scan and then thrown away.

## Physics

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
