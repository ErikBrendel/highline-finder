import type { Aoi, Params } from '../shared/types.js'

/**
 * Single source of truth for every tunable. Values are metres unless stated.
 *
 * These defaults are calibrated for Tropical (38 m of relief in 1 km^2,
 * ~55% closed pine canopy 15-30 m tall). Flatter or more open terrain will want different
 * numbers, in particular `minProbeDrop` and `minExposure`.
 */
export const DEFAULT_PARAMS: Params = {
  // Attachment height range for a ground anchor. 0 is reachable at a clean edge, where the line
  // runs straight out over the void from bolts in the rock; 1.5 m is about the tallest A-frame
  // worth carrying in. v1 has no tree or building anchors, so this range is the only freedom the
  // search has to level a line out, and narrowing it directly costs candidates.
  aFrameMin: 0,
  aFrameMax: 1.5,

  // 1.5 m of offlevel on a 50 m line, scaling linearly to 15 m at 500 m.
  maxOffLevelRatio: 0.03,

  // Enough that a walker plus sag does not scrape. Applies only outside anchorZone.
  minClearance: 3.0,

  // What a line owes water instead. Falling in a lake is how a session ends; falling on ground is
  // how one ends badly, so the figure over water is about not dragging rather than about safety.
  // Islands inside lakes are ground and get the full 3 m -- see shared/water.ts.
  waterClearance: 1.0,

  // Extra metres demanded where the line passes over traffic, on top of minClearance.
  //
  // For scale: German law wants 4.50 m over a road -- the 4.00 m a lorry may legally be, plus half
  // a metre -- and 4.70 m under new motorway structures. These run to five times that on purpose. A
  // bridge deck is rigid and surveyed; a slackline sags under a walker, is rigged by hand, and can
  // drop that walker onto whatever is beneath. The road standard is the wrong reference class.
  //
  // The ladder is about what can be closed for a rigging day rather than about size alone. A forest
  // path or a footway is taped off for an afternoon and asks for nothing extra; a motorway or a
  // railway cannot be stopped at all. Which OSM values land in which class is in shared/roads.ts.
  roadClearance: {
    path: 0,
    cycle: 3,
    street: 8,
    road: 12,
    highway: 20,
  },

  // At the anchor the line sits at most aFrameMax up, and possibly at ground level, so the
  // clearance test has to exclude a window at each end or nothing would ever pass.
  anchorZone: 10.0,

  // Filters out lines that merely skim flat ground for their whole length. Raise it for more
  // dramatic results; 0 disables the check entirely. There is deliberately no upper bound --
  // an arbitrarily deep gap is arbitrarily good.
  minExposure: 10.0,

  minLength: 50,
  maxLength: 500,

  // Midspan sag as a fraction of span, used to generate the dataset. This is a *floor*, not a
  // prediction: the web app lets the user raise sag and re-derives every clearance from the stored
  // profile, but it can only tighten, because candidates rejected here are never written out. So
  // generate at the most permissive sag anyone might rig at.
  //
  // Community practice is 5-10% of span, and Balance Community's own
  // tension relation S = W*L/(4*T) gives ~7.9% for 100 m at 2.5 kN and ~6.5% for 275 m at 3 kN with
  // an 80 kg walker. 5% is the bottom of that band, so the dataset covers anyone rigging tighter
  // than average and the UI spans the rest of it. Raising this number is destructive (124 candidates
  // at 4%, 65 at 5%, 31 at 6%, 16 at 7% on the default AOI); tightening in the UI is not. A real
  // tension model is in ROADMAP.
  sagRatio: 0.05,

  // Half-width of the band clearance is measured across, at midspan, as a fraction of span.
  //
  // Same relation as the sag, because it is the same physics: a tensioned line deflects by
  // F*L/(4*T) whichever way the load points, so a side load is a sag turned sideways and its
  // excursion is a fraction of span rather than a fixed number of metres. 4% against the 5% sag
  // asserts a side load about 80% of body weight -- more than wind alone, which is nearer 1% of
  // span, and about what a walker leaning, catching or falling sideways puts in.
  //
  // Scales the right way for what it is for: a 60 m urban line gets +/-2.4 m at midspan, which is
  // what stops a line threading a corridor between two buildings, while a 400 m line over a valley
  // gets +/-16 m of air it was never going to touch anything with.
  sideClearanceRatio: 0.04,

  // Most lateral samples taken per side at any one station. Beyond this the step grows instead of
  // the count, so a 16 m half-width costs the same as a 2 m one: a band that wide is looking for
  // buildings and hillsides, and metre resolution buys nothing. Narrow bands, where resolution does
  // matter, keep their 1 m step because the count never binds.
  sideSamplesPerSide: 9,

  // 5 m quantisation of anchor positions. The true best anchor can therefore sit up to ~3.5 m
  // away from the one reported.
  anchorStep: 5,

  // 64 sectors = 5.625 deg each. At 500 m a sector is ~49 m wide, which is why the pair test is a
  // prefilter and the full profile check still runs afterwards.
  sectorCount: 64,

  // Every highline has air under it somewhere, so this mirrors minExposure: a line has to reach
  // that much clearance to count, and it can only do so where the ground is at least that far
  // below the attachment point. Measured from the attachment rather than the ground, so the terrain
  // itself only has to fall minDropDepth - aFrameMax.
  minDropDepth: 10,
  // minLength / 2, see the note on the field.
  dropSearchRadius: 25,

  nearProbeLength: 40,
  // 2 * sagRatio, the middle of the range a line's initial descent can take.
  minFallSlope: 0.1,

  profileStep: 2,
  dedupRadius: 25,

  // Local hill-climb of each anchor after dedup. 3 m comfortably exceeds half of anchorStep, so
  // the 5 m lattice stops being the limiting factor on where an anchor is reported. 0 disables.
  refineRadius: 3,
  refineStep: 1,
  refineIterations: 8,
  // Off: profiles were 89% of the dataset and every one is recoverable from the WCS the planner
  // already uses, so the file scales with the number of lines rather than with 2.5 KB each. The
  // cost is a couple of elevation windows when a line is opened. See Candidate.profile.
  // Deliberately loose. This exists to drop lines buried in forest, not to enforce a clean line --
  // the score already handles the difference between 5% and 40% blocked, and 0.2% of feasible
  // endpoints in the current data are canopy-clear, so a strict gate here would empty the dataset.
  maxCanopyBlocked: 0.8,

  storeProfiles: false,

  // Coarse pre-pass. 16 m costs ~15 KB per square kilometre against 1.4 MB for the 1 m tiles, so
  // screening at this resolution is effectively free.
  //
  // The threshold matches the exact gate rather than guessing at slack for downsampling. Measured
  // at 239,392 real anchors, the coarse drop reads 14.9 m at the median and 5.8 m at the first
  // percentile, so averaging to 16 m costs far less than the 4 m this used to allow.
  //
  // Both this and the coverage rule sit on a cliff. Simulated over every tile at every setting and
  // scored against 321k real anchors: 10 -> 12 m loses 7.6% of them and 0.02 -> 0.05 loses 9.6%,
  // while loosening either changes nothing. There is no free tightening here.
  //
  // That measurement can only speak about tightening, though. The anchors it scores against were
  // themselves produced by a run using these values, so an anchor this rule skipped is not in the
  // file to be missed -- "nothing lost at 10 m" is true by construction. What the rule actually
  // misses is measurable only by fetching ground it rejected and looking; see ROADMAP.
  maskRes: 16,
  maskRadius: 32,
  maskMinDrop: 10,
  maskMinCoverage: 0.02,
  // Anchorable roofs a tile needs before it is fetched for its buildings alone, and how tall each
  // has to stand above the ground nearby. The mirror of maskMinDrop and maskMinCoverage.
  //
  // The measurement that was waiting to be made has been made, on chunk 52_728: at
  // maskMinRoofDrop = minDropDepth this rule pulled in 96 of 121 tiles that the terrain rule had
  // rejected, because one building 10 m above its surroundings qualifies a tile and the result is
  // dilated by maxLength -- so every village claimed its whole 3x3 neighbourhood and the pre-pass
  // switched itself off wherever people live.
  //
  // 25 m is deliberately far more than a line needs. A roof only has to clear minDropDepth to be
  // worth anchoring on, so this is not the rule saying what is riggable; it is the rule saying what
  // is worth *fetching a whole tile at 1 m for*, and that is a different and much stricter
  // question. Set here to the height of a decent tower block, so the urban search goes looking for
  // the handful of exceptional lines rather than for every church steeple in Brandenburg. Most good
  // lines are natural anyway.
  //
  // The cost is real and one-sided: an ordinary rooftop line in a small settlement is not missed,
  // it is never looked for, because its tile is never fetched. Lower this when urban coverage
  // matters more than statewide reach.
  maskMinRoofs: 1,
  maskMinRoofDrop: 25,
  maskExportRes: 128,
  // The web app re-derives clearances from this profile rather than the raster, so its resolution
  // bounds how accurately sag can be re-evaluated client side. 120 keeps a 500 m line at ~4 m
  // sampling, against the 2 m the pipeline itself walks.
  profilePoints: 120,
}

/**
 * Tropical. ~1150 x 990 m, spanning four 1 km source tiles. Chosen because highlines are known
 * to be riggable here, so it doubles as a sanity check that the finder produces plausible geometry.
 */
/**
 * Where to search. Add rectangles freely: any that come within `maxLength` of each other are
 * rasterised as one grid so lines can cross between them, and overlaps are collapsed by the dedup
 * pass rather than reported twice.
 *
 * Adding an area here searches that area alone: every other is already cached under the ground it
 * covers, and a cached region is kept until a run is told to rebuild it.
 */
export const DEFAULT_AOIS: Aoi[] = [
  // Tropical: 38 m of relief in flat Brandenburg, and the reason this project exists.
  { south: 52.197701, west: 13.651291, north: 52.206631, east: 13.668149 },
  // Linthe: 4.6 km2 west of Berlin.
  { south: 52.133925, west: 12.777441, north: 52.151606, east: 12.811591 },
  // Mueggelberge: 22 km2 in south-east Berlin.
  { south: 52.390088, west: 13.601721, north: 52.428357, east: 13.677498 },
  // Vehlen: 10.6 km2, further west again.
  { south: 52.422160, west: 12.297235, north: 52.444399, east: 12.360257 },
  // Sperenberg: 1.9 km2 south of Berlin, around the old gypsum quarry.
  { south: 52.134358, west: 13.367475, north: 52.141191, east: 13.392128 },
  // Otto Lilienthal: 3.4 km2 west of Berlin, around the Gollenberg he flew from.
  { south: 52.403294, west: 12.814322, north: 52.415410, east: 12.851882 },
]

/**
 * Superchunks claimed for the search, by their place on the 8 km EPSG:25833 lattice.
 *
 * The other half of `DEFAULT_AOIS`, and eventually its replacement. A chunk is a fixed square that
 * a run is answerable for; an area of interest is a rectangle somebody drew. They are searched by
 * the same code and pooled into the same dataset, but they are selected, cached and recomputed
 * independently -- naming a rectangle never touches a chunk, and naming a chunk never touches an
 * area of interest. That is what makes it possible to move ground from one to the other a piece at
 * a time rather than in one cut. See chunks.ts.
 *
 * The first four are the 2x2 block south of Eberswalde, around E 424000 / N 5832000, which between
 * them found 4,502 lines with none duplicated across a seam. The rest extend it westward a column
 * at a time, to E 400000.
 */
/**
 * Where a roof may be anchored on. Everywhere else is searched for natural lines only.
 *
 * Empty, which is the point: a rooftop anchor is opt-in by place. Buildings are still merged into
 * the ground everywhere, so a line is still blocked by the warehouse it would have crossed -- what
 * changes is that the openness scan will not stand an anchor on top of one outside these
 * rectangles, and the coarse pre-pass will not fetch a tile on the strength of its roofs.
 *
 * The reason is that most of Brandenburg is flat, and on flat ground every line found is a rooftop
 * line: chunks 51_728, 51_729, 50_728 and 52_728 produced 202, 63, 130 and 274 lines between them,
 * every single one urban, and the surface model was fetched for 14, 6, 23 and 8 tiles to measure
 * them. None of that ground can hold a natural line at all. Statewide the terrain rule keeps 18.4 %
 * of tiles, so the other 82 % is that case.
 *
 * The trade is the usual one-sided one: a rooftop line outside these rectangles is not missed, it
 * is never looked for. It costs a lot -- 45 % of the lines found before this rule existed were
 * urban or mixed -- so add a rectangle wherever that matters. The scan reports how many anchors it
 * skipped for this, so the cost is never silent.
 *
 * The north-west quarter of Eberswalde is here because its rooftop and mixed lines are the urban
 * half of this project's results, found over ground that was searched deliberately rather than
 * swept. Narrowed to the town itself rather than the whole area of interest: the rest is the
 * Niederfinow side, where the lines worth having come off the terrain.
 */
export const URBAN_AREAS: Aoi[] = [
  { south: 52.816791, west: 13.715984, north: 52.869081, east: 13.850062 },
]

export const DEFAULT_CHUNKS: string[] = [
  '52_728', '53_728', '52_729', '53_729',
  '51_728', '51_729',
  '50_728', '50_729',
  '49_728', '49_729',
  '54_728', '54_729',
  '55_728', '55_729',
  '56_728', '56_729',
  '57_728', '57_729',
  // Row 730, the strip Eberswalde's southern edge was cut back from.
  '49_730', '50_730', '51_730', '52_730', '53_730', '54_730', '55_730', '56_730', '57_730',
  /**
   * Eberswalde and Niederfinow, which used to be an area of interest and are now eight chunks.
   *
   * The last of the hand-drawn rectangles to go. It covered 243 km2; these cover the 512 km2 of
   * lattice it sat inside, so 269 km2 of ground comes along that nobody had drawn a box around --
   * which is the whole argument for a fixed grid over rectangles somebody chose.
   */
  '51_731', '52_731', '53_731', '54_731',
  '51_732', '52_732', '53_732', '54_732',
  // Squaring off the western edge of those two rows against the three below, which start at 49.
  '49_731', '50_731',
  '49_732', '50_732',
  // And a column east of Eberswalde, towards the Oder.
  '55_731', '55_732',
]
