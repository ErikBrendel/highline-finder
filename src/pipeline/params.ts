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
  // runs straight out over the void from bolts in the rock; 2 m is about the tallest practical
  // A-frame. v1 has no tree or building anchors, so this range is the only freedom the search has
  // to level a line out.
  aFrameMin: 0,
  aFrameMax: 2.0,

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

  // Midspan sag as a fraction of span. A flat 4% stand-in for a real tension model: a 100 m
  // line sags 4 m, a 500 m line 20 m. Roughly right for a loaded highline, but it is a
  // constant, not physics, and it does not respond to webbing, tension or walker mass.
  sagRatio: 0.04,

  // 5 m quantisation of anchor positions. The true best anchor can therefore sit up to ~3.5 m
  // away from the one reported.
  anchorStep: 5,

  // 64 sectors = 5.625 deg each. At 500 m a sector is ~49 m wide, which is why the pair test
  // is a prefilter and the full profile check still runs afterwards.
  sectorCount: 64,

  blockProbeLength: 30,
  dropProbeLength: 120,
  minProbeDrop: 5.0,

  // Completeness bound of the openness prefilter, see openness.ts. A line rising steeper than
  // 25% out of an anchor may be missed.
  maxUpSlope: 0.25,

  profileStep: 2,
  dedupCell: 25,
  maxCandidates: 300,
  profilePoints: 80,
}

/**
 * Sperenberg gypsum pits, Brandenburg. ~1030 x 837 m, terrain 34.5-72.9 m.
 * Chosen because highlines are known to be riggable here, so it doubles as a sanity check
 * that the finder produces plausible geometry.
 */
export const DEFAULT_AOI: Aoi = {
  south: 52.199278,
  west: 13.651291,
  north: 52.206631,
  east: 13.666139,
}
