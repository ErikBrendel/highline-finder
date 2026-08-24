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
  /**
   * Omnidirectional prefilter: the terrain must fall this far below the line's attachment point
   * somewhere within `dropSearchRadius`. Every highline needs air under it at some point, and a
   * point with nothing deep enough anywhere nearby cannot produce one in any direction.
   */
  minDropDepth: number
  /**
   * Radius searched for that drop. Half of `minLength` is the natural choice: for a span of length
   * L the deepest point is at most L/2 from the nearer anchor, so at the shortest allowed length
   * this is exactly what one end must see. Requiring it of *both* ends is the deliberate lossy part
   * -- it drops lines whose only air sits close to one anchor.
   */
  dropSearchRadius: number
  /** How far out the per-direction scan checks before leaving the rest to the full profile test. */
  nearProbeLength: number
  /**
   * Minimum rate at which terrain must fall away in a usable direction.
   *
   * A line leaves its anchor descending: for a level span of length L at sag ratio r its height at
   * distance d is `anchorH - 4*r*d*(1 - d/L)`, so the initial descent is between 2*r (when d is
   * near midspan) and 4*r (for a span much longer than d). 2*sagRatio is the middle of that, and
   * raising it toward 4*sagRatio makes the scan stricter, faster and lossier.
   *
   * Note this interacts with `minDropDepth`: requiring 8 m of drop within a 25 m radius already
   * implies a ~32% local slope, far steeper than this envelope, so for smoothly falling terrain the
   * drop test binds first. What this test actually earns its keep on is obstructions -- a berm or
   * spoil heap between the anchor and the drop, which no slope or depth test can see.
   */
  minFallSlope: number
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
  /**
   * Whether to store an elevation profile per line.
   *
   * Profiles are ~85% of the dataset, and every one of them is recoverable from the elevation
   * service the interactive planner already uses. Off, the file scales to far more lines and the
   * chart for a line costs a couple of 256 m windows when it is opened; on, everything is instant
   * and offline but the file grows by ~2.5 KB per line.
   */
  /**
   * Most canopy a line may run through before it is rejected outright, as a fraction of the span's
   * interior.
   *
   * Canopy is otherwise scored rather than enforced, on purpose: a line clipping the tops of a few
   * trees is still worth reporting, with its blockage stated, because the surface model is a single
   * epoch and trees get felled. But a line that is inside a forest for most of its length is not a
   * highline anyone could rig, and reporting it as a candidate is noise rather than information.
   */
  maxCanopyBlocked: number
  storeProfiles: boolean
  /**
   * Resolution the coarse pre-pass measures terrain at, in metres. Fetched from the survey's WCS
   * with the scaling extension, so no new product is involved.
   */
  maskRes: number
  /** Radius the coarse drop is measured over. Scaled up from dropSearchRadius, see coarse.ts. */
  maskRadius: number
  /**
   * Fall the coarse pass demands before full-resolution data is fetched, in metres. 0 disables the
   * pre-pass entirely.
   *
   * Deliberately far below the anchor scan's own 10 m: downsampling averages, so a coarse cell
   * under-reports the drop inside it, and a narrow feature can be erased completely. This is a
   * lossy filter by nature -- measured at 64 m, a 4 m threshold keeps ~97% of candidate endpoints
   * for half the area, and a 12 m threshold keeps ~84% for a quarter.
   */
  maskMinDrop: number
  /**
   * Fraction of a tile's coarse cells that must pass before the tile is worth fetching.
   *
   * A single passing cell is noise -- a ditch or a field edge -- and taking it as evidence pulled
   * in whole flat kilometres. A fraction rather than a count so the rule keeps its meaning if
   * `maskRes` changes.
   */
  maskMinCoverage: number
  /** Cell size the mask is aggregated to for the debug overlay, in metres. */
  maskExportRes: number
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

/**
 * A stored profile: only the two measured series, as parallel arrays.
 *
 * Sample spacing and line height are derived on load, so they are not stored -- see packProfile.
 * Samples are evenly spaced from anchor A to anchor B inclusive.
 */
export interface StoredProfile {
  ground: number[]
  /** Top of vegetation / structures (bDOM), clamped to never fall below `ground`. */
  surface: number[]
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
  /**
   * Loosest sag at which this line still clears the terrain, as a fraction of span.
   *
   * Stored because it is the one thing the profile was needed for that applies to every line at
   * once: it lets the sag control filter the whole dataset exactly, without a profile per line.
   */
  maxSagRatio: number
  /**
   * Absent when the pipeline ran with `storeProfiles: false`, in which case the browser rebuilds it
   * from the elevation service for whichever line is actually opened.
   */
  profile?: StoredProfile
}

/**
 * One rasterised grid and what came out of it.
 *
 * Several AOIs share a region when they are close enough for a line to span between them, so the
 * search sees one grid rather than two that each miss the seam -- which is why this carries a list
 * of AOIs rather than one.
 */
export interface Region {
  aois: Aoi[]
  /** EPSG:25833 bounds actually rasterised. */
  bbox25833: { minE: number; minN: number; maxE: number; maxN: number }
  width: number
  height: number
  groundMin: number
  groundMax: number
  anchorsScanned: number
  anchorsKept: number
}

export interface DatasetMeta {
  generatedAt: string
  regions: Region[]
  params: Params
  sources: { name: string; url: string; attribution: string; note: string }[]
  stats: {
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

/**
 * Every anchor the openness scan kept, for the debug overlay. Columnar rather than an array of
 * objects because at ~25k points the repeated JSON keys would cost more than the data, and served
 * as a separate file so it is only fetched when the overlay is switched on.
 */
export interface AnchorDump {
  sectorCount: number
  aFrameMin: number
  aFrameMax: number
  anchorStep: number
  nearProbeLength: number
  minDropDepth: number
  dropSearchRadius: number
  lat: number[]
  lon: number[]
  ground: number[]
  /** Metres the terrain falls below the attachment point within `dropSearchRadius`. */
  drop: number[]
  /** Open-sector bitmask, one hex digit per 4 sectors, least significant bit first. */
  open: string[]
}

/**
 * Where lines are possible at all, at a scale where individual lines are meaningless.
 *
 * Parallel arrays rather than objects, and derived from every feasible line rather than the capped
 * candidate list: `count` is how many line endpoints collapsed into the spot, which is the whole
 * signal -- one workable line and four hundred look identical on a map of candidates.
 */
export interface Hotspots {
  /** Clustering radius in metres. */
  radius: number
  lat: number[]
  lon: number[]
  count: number[]
  score: number[]
}

/**
 * The coarse pre-pass, aggregated for display. Shows which ground was rejected before any
 * full-resolution data was fetched, and how close each part came to the threshold.
 */
export interface MaskCells {
  /** Cell size of these aggregated cells, in metres. */
  res: number
  /** Resolution the drop was actually measured at. */
  sourceRes: number
  minDrop: number
  lat: number[]
  lon: number[]
  /** Greatest coarse fall found in the cell. Below minDrop means the cell was skipped. */
  drop: number[]
}

/**
 * What the pipeline actually fetched, per 1 km source tile.
 *
 * Distinct from MaskCells, which reports what the coarse pre-pass *thought*: source data comes in
 * 1 km tiles, so a decision taken at 16 m cannot be acted on at 16 m. Showing the two side by side
 * is the point -- it is how you see a filter being too loose (tiles fetched that yielded nothing)
 * or too tight (tiles skipped beside productive ones).
 */
export interface TileUsage {
  /** Tile side in metres. */
  size: number
  lat: number[]
  lon: number[]
  /** Whether the terrain model was fetched for this tile. */
  terrain: boolean[]
  /** Whether the surface model was, which happens only where a line crosses. */
  surface: boolean[]
  /** Anchors the exact 1 m scan found in it. Zero means the terrain fetch bought nothing. */
  anchors: number[]
}

export interface Dataset {
  meta: DatasetMeta
  candidates: Candidate[]
}
