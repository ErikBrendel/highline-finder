import type { ProfileSample } from '../shared/types.js'
import { COVER_BUILDING, type Cover } from './landcover.js'

/**
 * The drawing box, in user units.
 *
 * The SVG is laid out at `width: 100%` with no height of its own, so the box decides two things at
 * once: the aspect ratio the chart is drawn at, and -- because one user unit renders as
 * `elementWidth / w` pixels -- how big every label, tick and stroke in it comes out. Keeping `w`
 * near the width the element will actually have is therefore not an optimisation but the whole
 * reason there are two of these: at 900 units in a 358 px column a 10-unit label renders at four
 * pixels and the chart is a strip of unreadable fuzz 80 px tall.
 *
 * So the wide box is for a chart that gets most of a window, and the narrow one for a chart that
 * gets a phone. Nothing else about the drawing changes -- the paddings are in the same units and
 * come out at roughly the same pixels in both.
 *
 * The narrow one is squarer as well as smaller. At 4.5:1 a phone's width leaves eighty pixels of
 * height for thirty metres of relief, and no amount of legible lettering rescues a chart with no
 * vertical room; at 1.7:1 it is a section you can read a clearance off, and still short enough to
 * sit in the card without crowding out the figures under it.
 */
export const CHART_WIDE = { w: 900, h: 200 }
export const CHART_NARROW = { w: 380, h: 220 }

export interface Vertex {
  /** Distance along the span, in metres. */
  d: number
  /** Height at that distance, in metres. */
  h: number
}

/**
 * One series along the span, with a vertical wall wherever a building begins or ends.
 *
 * Buildings have vertical walls. Every series here is already the roof over one -- terrain.ts
 * treats a roof as ground, and the surface model sees the roof too -- so joining a pavement sample
 * to a roof sample with a straight segment draws a ramp up the side of the building at whatever
 * slope the sample spacing happens to give. There is no such slope, and at the resolution this
 * chart is read at the triangle is the first thing the eye lands on: brown for the terrain fill,
 * green for the canopy band above it, both describing material that is not there.
 *
 * So a sample standing on a building whose neighbour does not gets an extra vertex at its own
 * station, down at the foot of the wall: the series runs level to the wall and steps up it. That
 * station is exactly where the grey column's edge already is, so the two meet at a corner -- and
 * every series steps at the same station, so the shapes between them stay closed.
 *
 * Only the drawing changes. Clearance, exposure and every score are measured from the samples
 * themselves and are untouched -- the ramp was never in the numbers, only in the picture.
 */
export function steppedOutline(
  p: ProfileSample[],
  cover: Cover | null,
  height: (s: ProfileSample) => number,
  /**
   * Where this series sits at the foot of the wall, when something knows better than the neighbour
   * does. The terrain has the bare earth under the building; nothing else has an equivalent.
   */
  foot?: (i: number) => number,
): Vertex[] {
  const known = cover && cover.kind.length === p.length ? cover : null
  if (!known) return p.map((s) => ({ d: s.d, h: height(s) }))
  const onBuilding = (i: number) => known.kind[i] === COVER_BUILDING
  const atFoot = (i: number, beside: number) => {
    const under = foot?.(i)
    return under !== undefined && Number.isFinite(under) ? under : beside
  }

  const out: Vertex[] = []
  for (let i = 0; i < p.length; i++) {
    const s = p[i]!
    if (!onBuilding(i)) {
      out.push({ d: s.d, h: height(s) })
      continue
    }
    if (i > 0 && !onBuilding(i - 1)) out.push({ d: s.d, h: atFoot(i, height(p[i - 1]!)) })
    out.push({ d: s.d, h: height(s) })
    if (i + 1 < p.length && !onBuilding(i + 1)) out.push({ d: s.d, h: atFoot(i, height(p[i + 1]!)) })
  }
  return out
}

/**
 * The stretches the elevation service has not covered, and a profile with them bridged over.
 *
 * A partly measured line is drawn rather than withheld -- see planLine's `tolerateGaps` -- and it
 * arrives with NaN at every station that was not read. A NaN reaching a path coordinate does not
 * make a gap, it makes the entire `d` attribute invalid and the series vanishes, so the values are
 * bridged from the measured stations either side and the stretch is then covered by an opaque band.
 *
 * Interpolated ground is therefore never seen and never read: it exists so the paths on either side
 * of a gap stay one drawable shape, and everything that would show it -- the fills, the hover
 * readout, the two markers -- is either painted over or asks `measured` first. It is a drawing
 * convenience and not a measurement, which is why it stops here rather than going anywhere near
 * `rawMetricsAt`, where the same NaN is skipped outright.
 */
const BRIDGED: (keyof ProfileSample)[] = ['ground', 'surface', 'groundMax', 'surfaceMax']

export function bridgeGaps(profile: ProfileSample[]): {
  samples: ProfileSample[]
  gaps: [number, number][]
  measured: boolean[]
} {
  const measured = profile.map((s) => !Number.isNaN(s.ground))
  if (measured.every(Boolean)) return { samples: profile, gaps: [], measured }

  const samples = profile.map((s) => ({ ...s }))
  const gaps: [number, number][] = []
  for (let i = 0; i < samples.length; i++) {
    if (measured[i]) continue
    let end = i
    while (end + 1 < samples.length && !measured[end + 1]) end++
    // Held flat from whichever side has ground, so a gap at an end of the span does not slope off
    // to nowhere. A gap with measured ground on both sides is a straight ramp between them.
    const before = i > 0 ? samples[i - 1]! : null
    const after = end + 1 < samples.length ? samples[end + 1]! : null
    for (let j = i; j <= end; j++) {
      const t = before && after ? (j - i + 1) / (end - i + 2) : before ? 1 : 0
      for (const key of BRIDGED) {
        // Neither side has ground when nothing on the span was measured at all. The span itself is
        // still known -- it is a parabola between two attachment heights, assumed or not -- so the
        // terrain is laid along it, which keeps the paths drawable and the y-range sane under a
        // band that covers the whole chart anyway.
        const lo = (before ?? after)?.[key] ?? samples[j]!.line
        const hi = (after ?? before)?.[key] ?? samples[j]!.line
        ;(samples[j]! as unknown as Record<string, number>)[key] = lo + (hi - lo) * t
      }
    }
    gaps.push([samples[i]!.d, samples[end]!.d])
    i = end
  }
  return { samples, gaps, measured }
}
