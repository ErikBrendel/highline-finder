/**
 * Output schema of the pipeline. `candidates.json` is exactly a serialised {@link Dataset},
 * so these types are the schema contract between pipeline and web app.
 *
 * Height convention throughout: metres above sea level in DHHN2016 (the vertical datum the
 * Brandenburg rasters use), never metres above ground, unless a field says "clearance".
 */

/** Area of interest, WGS84 degrees. */
export interface Aoi {
  south: number
  west: number
  north: number
  east: number
}

export interface Params {
  /**
   * Range a ground anchor's attachment point may sit in, above the terrain. The line does not
   * have to leave at a fixed height: at a clean edge it can be rigged at ground level, or raised
   * on an A-frame. That slack is what lets two anchors of unequal ground height produce a level
   * line, so it is a search dimension, not a constant.
   */
  aFrameMin: number
  aFrameMax: number
  /**
   * Largest tolerated height difference between the two attachment points, as a fraction of
   * span. 0.02 means 1 m over 50 m and 10 m over 500 m. An offlevel line is harder to rig, walks
   * unevenly and loads the low anchor more, so this is a hard constraint rather than a penalty.
   */
  maxOffLevelRatio: number
  /** Line must clear bare terrain by at least this much, on the interior of the span. */
  minClearance: number
  /**
   * Distance from each anchor within which {@link minClearance} is NOT required.
   * Necessary because at the anchor the line sits at most `aFrameMax` above ground, and possibly
   * at ground level, so any whole-span clearance requirement would reject every line.
   */
  anchorZone: number
  /** Deepest air gap must reach this, else it is a lowline. Set 0 to keep everything. */
  minExposure: number
  minLength: number
  maxLength: number
  /** Midspan sag as a fraction of length. Fixed ratio, not a tension model. */
  sagRatio: number
  /** Grid spacing of candidate anchor positions. */
  anchorStep: number
  /** Number of angular sectors in the openness bitmask. */
  sectorCount: number
  /** How far out the openness probe checks for obstructions. */
  blockProbeLength: number
  /** How far out the openness probe looks for a drop. */
  dropProbeLength: number
  /** Terrain must fall at least this far below anchor height within `dropProbeLength`. */
  minProbeDrop: number
  /** Steepest upward line slope the openness probe stays admissible for. See openness.ts. */
  maxUpSlope: number
  /** Spacing of samples along a candidate line. */
  profileStep: number
  /**
   * Two lines count as the same when both endpoints are within this distance. Must be a
   * multiple of `anchorStep` to have any thinning effect.
   */
  dedupRadius: number
  /**
   * Local refinement of anchor positions after deduplication. Each end may move up to
   * `refineRadius` from where the lattice put it, searched on a `refineStep` grid, for at most
   * `refineIterations` coordinate-descent passes. 0 disables refinement.
   */
  refineRadius: number
  refineStep: number
  refineIterations: number
  maxCandidates: number
  /** Samples kept in the serialised profile, to bound output size. */
  profilePoints: number
}

export interface AnchorOut {
  lat: number
  lon: number
  /** EPSG:25833 easting / northing. */
  e: number
  n: number
  /** Terrain height. */
  ground: number
  /** Height the line actually attaches at, chosen within the allowed range. */
  anchor: number
  /** How far the attachment sits above the terrain: `anchor - ground`. */
  aFrame: number
}

export interface ProfileSample {
  /** Distance from anchor A along the span. */
  d: number
  ground: number
  /** Top of vegetation / structures (bDOM), clamped to never fall below `ground`. */
  surface: number
  /** Height of the sagging line. */
  line: number
}

export interface ScoreParts {
  exposure: number
  length: number
  canopy: number
  margin: number
  level: number
}

export interface Candidate {
  id: string
  a: AnchorOut
  b: AnchorOut
  /** Horizontal span. */
  length: number
  /** Compass bearing A to B, degrees. */
  bearing: number
  /** Midspan sag used for this line. */
  sag: number
  /** Height difference between the attachment points. */
  offLevel: number
  /** offLevel as a fraction of length. Always <= maxOffLevelRatio. */
  offLevelRatio: number
  /** Smallest line-to-terrain gap on the interior of the span. Always >= minClearance. */
  clearanceMin: number
  /** Largest line-to-terrain gap anywhere. How high the highline actually is. */
  exposure: number
  /** Smallest line-to-surface gap on the interior. Negative means the line runs into canopy. */
  canopyClearanceMin: number
  /** Fraction of interior samples where the line is below the canopy. */
  canopyBlockedFraction: number
  /** 0-100, see scoreCandidate in lines.ts. */
  score: number
  scoreParts: ScoreParts
  profile: ProfileSample[]
}

export interface DatasetMeta {
  generatedAt: string
  aoi: Aoi
  /** EPSG:25833 bounds actually rasterised. */
  bbox25833: { minE: number; minN: number; maxE: number; maxN: number }
  params: Params
  sources: { name: string; url: string; attribution: string; note: string }[]
  stats: {
    aoiWidth: number
    aoiHeight: number
    groundMin: number
    groundMax: number
    anchorsScanned: number
    anchorsKept: number
    pairsInRange: number
    pairsSectorPassed: number
    pairsLevelEnough: number
    pairsFeasible: number
    candidatesAfterDedup: number
    refinedCount: number
    refineMeanGain: number
    runtimeMs: number
  }
}

export interface Dataset {
  meta: DatasetMeta
  candidates: Candidate[]
}
