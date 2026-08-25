import type { Pos, Sampler } from './grid.js'
import { lineHeightAt } from './scoring.js'
import type { Scene } from './scene.js'
import { clearanceNeeded } from './water.js'
import type { Params, ProfileSample, StoredProfile } from './types.js'

/**
 * Samples terrain and surface along a span, with the line at the given sag.
 *
 * Shared between the search and the interactive planner so a hand-placed line is measured by
 * exactly the same rule as a found one, and the two are directly comparable.
 *
 * Not one ray but a band. A single line of samples can thread between two pines three metres apart,
 * or down a corridor between two buildings, and report clear air -- and the line does not stay on
 * its centreline. Wind and the walker's own weight push it sideways, so every station is measured
 * across a lens: zero half-width at the anchors, where the line is pinned, widest at midspan. See
 * `Params.sideClearanceRatio` for why that width is a fraction of span and not a number of metres.
 */

/**
 * Half-width of the band at fraction `t` along the span.
 *
 * `4t(1-t)` peaks at 1 in the middle and vanishes at both ends, so the parameter reads directly as
 * the midspan half-width. Same shape as the sag curve because both are pinned at the same two
 * points -- and, as it happens, the same physics with the load turned sideways.
 *
 * A missing ratio means no band, which is exactly what a dataset generated before this existed was
 * measured with. Worth guarding rather than trusting: the browser reads its parameters out of
 * whichever `candidates.json` it was served, and NaN spreads silently here -- it would have drawn a
 * band at undefined coordinates and, worse, made every `NaN > 0` road test fall through to "inside
 * the band", quietly inventing crossings under planned lines.
 */
export function sideHalfWidthAt(t: number, length: number, p: Params): number {
  const ratio = p.sideClearanceRatio
  return Number.isFinite(ratio) ? 4 * t * (1 - t) * ratio * length : 0
}

/**
 * The highest reading anywhere across the band at one station.
 *
 * Lateral samples are spaced a metre apart -- the resolution of the terrain raster -- until that
 * would take more than `sideSamplesPerSide` of them, past which the step grows and the count holds.
 * A 16 m half-width on a long span is looking for hillsides and buildings, where metre resolution
 * buys nothing; the narrow urban bands, where it does, never reach the cap.
 *
 * Read from the containing cell rather than interpolated, unlike the centreline. Two reasons, and
 * they point the same way: the question here is whether anything stands in the strip, and bilinear
 * interpolation averages a one-cell wall with the ground beside it and under-reports both -- and it
 * costs four lookups where this needs one, on the stage that dominates the run.
 *
 * A NaN off the side of the loaded data is ignored rather than propagated: the band reaching past
 * what has been fetched is not evidence of an obstruction. The centreline is not treated that way
 * -- it is the sample the caller checks for validity.
 */
function worstAcross(
  s: Sampler,
  e: number,
  n: number,
  pe: number,
  pn: number,
  half: number,
  p: Params,
  /** Called at every point sampled, centreline included, for whoever else is asking about them. */
  visit?: (e: number, n: number) => void,
): number {
  const centre = s.sample(e, n)
  visit?.(e, n)
  if (!(half > 0)) return centre
  const count = Math.min(p.sideSamplesPerSide, Math.max(1, Math.ceil(half)))
  const step = half / count
  let worst = centre
  for (let j = 1; j <= count; j++) {
    const off = j * step
    const le = e - pe * off
    const ln = n - pn * off
    const left = s.nearest(le, ln)
    if (left > worst) worst = left
    visit?.(le, ln)
    const re = e + pe * off
    const rn = n + pn * off
    const right = s.nearest(re, rn)
    if (right > worst) worst = right
    visit?.(re, rn)
  }
  return worst
}

export function buildProfile(
  a: Pos,
  b: Pos,
  hA: number,
  hB: number,
  length: number,
  ground: Sampler,
  surface: Sampler,
  p: Params,
  /** For the water layer, which decides how much air each sample is held to. */
  scene: Scene = {},
): ProfileSample[] {
  const sag = p.sagRatio * length
  const de = (b.e - a.e) / length
  const dn = (b.n - a.n) / length
  // Unit normal to the span, which is what the band is measured along.
  const pe = -dn
  const pn = de
  const steps = Math.min(p.profilePoints, Math.max(8, Math.round(length / p.profileStep)))
  const water = scene.water
  const out: ProfileSample[] = []
  const r2 = (v: number) => Math.round(v * 100) / 100
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const d = t * length
    const e = a.e + de * d
    const n = a.n + dn * d
    const half = sideHalfWidthAt(t, length, p)
    const g = ground.sample(e, n)
    /**
     * Water only buys the lower requirement where the *whole* band is over it. If the walker can
     * swing onto a bank, they need what a bank demands -- and since the clearance is measured to
     * the worst obstruction anywhere across the band, the requirement has to be the worst one too
     * or the two halves of the test would be talking about different places.
     */
    let allWater = !!water
    const gMax = worstAcross(ground, e, n, pe, pn, half, p, (pe2, pn2) => {
      if (allWater && !water!.covers(pe2, pn2)) allWater = false
    })
    const s = Math.max(g, surface.sample(e, n) || g)
    const sMax = Math.max(gMax, worstAcross(surface, e, n, pe, pn, half, p) || gMax)
    out.push({
      d: r2(d),
      ground: r2(g),
      surface: r2(s),
      groundMax: r2(Math.max(g, gMax)),
      surfaceMax: r2(Math.max(s, sMax)),
      line: r2(lineHeightAt(hA, hB, sag, t)),
      halfWidth: r2(half),
      needed: clearanceNeeded(allWater, p),
    })
  }
  return out
}

/**
 * Drops everything about a profile that can be recomputed, for storage.
 *
 * `d` is `i/(n-1) * length` and `line` follows from the two attachment heights and the sag, both
 * already on the candidate -- so storing them is pure duplication, and they were more than half the
 * bytes of the largest field in the dataset. Parallel arrays rather than an array of objects for
 * the same reason: two key names per line instead of two per sample.
 *
 * The band series are omitted when they say nothing the centreline does not, and the per-sample
 * requirement when it is the ordinary one everywhere -- which is every sample of every line away
 * from water, and every line at all when `sideClearanceRatio` is 0.
 */
export function packProfile(samples: ProfileSample[], p: Params): StoredProfile {
  const stored: StoredProfile = {
    ground: samples.map((s) => s.ground),
    surface: samples.map((s) => s.surface),
  }
  if (samples.some((s) => s.groundMax > s.ground)) {
    stored.groundMax = samples.map((s) => s.groundMax)
  }
  if (samples.some((s) => s.surfaceMax > s.surface)) {
    stored.surfaceMax = samples.map((s) => s.surfaceMax)
  }
  if (samples.some((s) => s.needed !== p.minClearance)) stored.needed = samples.map((s) => s.needed)
  return stored
}

/** Rebuilds the full profile, with the line placed at `sagRatio`. Exact, not an approximation. */
export function unpackProfile(
  sp: StoredProfile,
  length: number,
  hA: number,
  hB: number,
  sagRatio: number,
  p: Params,
): ProfileSample[] {
  const last = sp.ground.length - 1
  const sag = sagRatio * length
  const r2 = (v: number) => Math.round(v * 100) / 100
  return sp.ground.map((ground, i) => {
    const t = last > 0 ? i / last : 0
    const surface = sp.surface[i] ?? ground
    return {
      d: r2(t * length),
      ground,
      surface,
      groundMax: sp.groundMax?.[i] ?? ground,
      surfaceMax: sp.surfaceMax?.[i] ?? surface,
      line: r2(lineHeightAt(hA, hB, sag, t)),
      halfWidth: r2(sideHalfWidthAt(t, length, p)),
      needed: sp.needed?.[i] ?? p.minClearance,
    }
  })
}
