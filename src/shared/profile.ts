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

/** How the span is walked, shared by whichever half of the profile is being built. */
/**
 * What the viewer measures a line at, overriding the search's own figures.
 *
 * The two want opposite things and no longer have to agree. The search walks billions of pairs, so
 * it samples every 2 m and caps at 120 stations -- which on a 500 m span is one reading per 4.2 m
 * of a raster that has four times that detail, and a gully narrower than that is simply not seen.
 * The viewer measures one line, once, when somebody opens it: a metre apart is the resolution of
 * the data itself, and 4,000 stations covers the planner's 4 km span cap at that spacing. Finer
 * would be measuring the interpolation between cells rather than the ground.
 *
 * Not applied while the optimiser is running. That evaluates dozens of candidate positions per
 * step, and it is looking for where to put an anchor rather than reporting what is under one.
 */
export const VIEWER_PROFILE = { profileStep: 1, profilePoints: 4000 }

function stationsAlong(a: Pos, b: Pos, length: number, p: Params) {
  const de = (b.e - a.e) / length
  const dn = (b.n - a.n) / length
  return {
    de,
    dn,
    // Unit normal to the span, which is what the band is measured along.
    pe: -dn,
    pn: de,
    steps: Math.min(p.profilePoints, Math.max(8, Math.round(length / p.profileStep))),
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Terrain along the span: the centreline, the worst of the band, and what each station is held to.
 *
 * Split from the canopy because they are not needed at the same time. Terrain decides whether a
 * line exists at all, and better than seven in ten pairs die on it -- so paying for the surface
 * model on the way to that verdict is paying for an answer that gets thrown away. See evaluateLine,
 * which gates on this alone before asking about vegetation.
 */
export function groundProfile(
  a: Pos,
  b: Pos,
  length: number,
  ground: Sampler,
  p: Params,
  scene: Scene = {},
): Pick<StoredProfile, 'ground' | 'groundMax' | 'needed'> {
  const { de, dn, pe, pn, steps } = stationsAlong(a, b, length, p)
  const water = scene.water
  const centre: number[] = []
  const band: number[] = []
  const needed: number[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const e = a.e + de * t * length
    const n = a.n + dn * t * length
    const half = sideHalfWidthAt(t, length, p)
    const g = ground.sample(e, n)
    /**
     * Water only buys the lower requirement where the *whole* band is over it. If the walker can
     * swing onto a bank, they need what a bank demands -- and since the clearance is measured to
     * the worst obstruction anywhere across the band, the requirement has to be the worst one too
     * or the two halves of the test would be talking about different places.
     */
    let allWater = !!water
    const gMax = worstAcross(ground, e, n, pe, pn, half, p, (we, wn) => {
      if (allWater && !water!.covers(we, wn)) allWater = false
    })
    centre.push(r2(g))
    band.push(r2(Math.max(g, gMax)))
    needed.push(clearanceNeeded(allWater, p))
  }
  return { ground: centre, groundMax: band, needed }
}

/**
 * The surface model along the same stations, clamped so it never reads below the terrain.
 *
 * `band` is off in the search and on everywhere a profile is going to be looked at. The canopy band
 * is drawn and never scored -- canopy stays a centreline measurement, see Metrics -- so computing
 * it for every pair the search tests is nineteen samples a station spent on a picture nobody is
 * going to open.
 */
export function canopyProfile(
  a: Pos,
  b: Pos,
  length: number,
  surface: Sampler,
  terrain: Pick<StoredProfile, 'ground' | 'groundMax'>,
  p: Params,
  band: boolean,
): Pick<StoredProfile, 'surface' | 'surfaceMax'> {
  const { de, dn, pe, pn, steps } = stationsAlong(a, b, length, p)
  const centre: number[] = []
  const top: number[] | undefined = band ? [] : undefined
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const e = a.e + de * t * length
    const n = a.n + dn * t * length
    const g = terrain.ground[i]!
    const s = r2(Math.max(g, surface.sample(e, n) || g))
    centre.push(s)
    if (!top) continue
    const gMax = terrain.groundMax?.[i] ?? g
    const half = sideHalfWidthAt(t, length, p)
    const sMax = worstAcross(surface, e, n, pe, pn, half, p) || gMax
    top.push(r2(Math.max(s, gMax, sMax)))
  }
  return { surface: centre, surfaceMax: top }
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
  const terrain = groundProfile(a, b, length, ground, p, scene)
  const canopy = canopyProfile(a, b, length, surface, terrain, p, true)
  return unpackProfile({ ...terrain, ...canopy }, length, hA, hB, p.sagRatio, p)
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
  return trimProfile(
    {
      ground: samples.map((s) => s.ground),
      surface: samples.map((s) => s.surface),
      groundMax: samples.map((s) => s.groundMax),
      surfaceMax: samples.map((s) => s.surfaceMax),
      needed: samples.map((s) => s.needed),
    },
    p,
  )
}

/**
 * Drops the optional series that say nothing the required ones do not.
 *
 * Each of them falls back to something on read -- the band to the centreline, the requirement to
 * `minClearance` -- so keeping a series of identical values is bytes spent to say "as usual". Away
 * from water and buildings that is most of a dataset.
 */
export function trimProfile(sp: StoredProfile, p: Params): StoredProfile {
  const out: StoredProfile = { ground: sp.ground, surface: sp.surface }
  if (sp.groundMax?.some((v, i) => v > sp.ground[i]!)) out.groundMax = sp.groundMax
  if (sp.surfaceMax?.some((v, i) => v > sp.surface[i]!)) out.surfaceMax = sp.surfaceMax
  if (sp.needed?.some((v) => v !== p.minClearance)) out.needed = sp.needed
  return out
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
