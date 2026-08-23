import type { Aoi, Params } from '../shared/types.js'

/**
 * Single source of truth for every tunable. Values are metres unless stated.
 *
 * These defaults are calibrated for the Sperenberg gypsum pits (38 m of relief in 1 km^2,
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

  // 1 m of offlevel on a 50 m line, scaling linearly to 10 m at 500 m.
  maxOffLevelRatio: 0.02,

  // Enough that a walker plus sag does not scrape. Applies only outside anchorZone.
  minClearance: 3.0,

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
  maxCandidates: 300,
  // The web app re-derives clearances from this profile rather than the raster, so its resolution
  // bounds how accurately sag can be re-evaluated client side. 120 keeps a 500 m line at ~4 m
  // sampling, against the 2 m the pipeline itself walks.
  profilePoints: 120,
}

/**
 * Sperenberg gypsum pits, Brandenburg. ~1150 x 990 m, spanning four 1 km source tiles.
 * Chosen because highlines are known to be riggable here, so it doubles as a sanity check
 * that the finder produces plausible geometry.
 */
/**
 * Where to search. Add rectangles freely: any that come within `maxLength` of each other are
 * rasterised as one grid so lines can cross between them, and overlaps are collapsed by the
 * dedup pass rather than reported twice.
 */
export const DEFAULT_AOIS: Aoi[] = [
  // Sperenberg gypsum pits: 38 m of relief in flat Brandenburg, and the reason this project exists.
  { south: 52.197701, west: 13.651291, north: 52.206631, east: 13.668149 },
  // Chorin / Oderbruch edge, north-east of Berlin.
  { south: 52.818013, west: 13.896186, north: 52.862093, east: 13.950634 },
]
