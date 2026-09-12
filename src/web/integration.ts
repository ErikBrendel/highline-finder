import { STATES, nearState } from './coverage.js'
import { SOURCES, hoehendaten } from './sources.js'
import { ORTHO_SURVEYS, SHADE_SURVEYS, statesCovered } from './surveys.js'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import type { Region } from '../shared/types.js'

/**
 * How far into this app each German state has got, worked out rather than written down.
 *
 * Every line of it is read off the thing that actually does the work: the elevation sources decide
 * whether heights and canopy are there, the basemap survey list decides whether the relief and the
 * imagery are the survey's own, and the dataset's own regions decide where lines were searched. A
 * table typed out beside them would be a claim about the code rather than a reading of it, and the
 * first time a service moved it would go on saying the old thing.
 *
 * What it is for is the map in the guide. "Past the border you can still place two anchors by hand"
 * was true and useless: it said nothing about what you would get, and what you get now differs four
 * ways across sixteen states.
 */

export type Provenance = 'survey' | 'shared'

export interface StateFacts {
  code: string
  name: string
  /** Heights: the state's own coverage service, or the republisher that carries everyone's. */
  ground: Provenance
  /** Whether anything measures what is standing on the ground here. Only a surface model does. */
  canopy: boolean
  /** Relief: the state's own at a metre, or the federal one at five. */
  shade: Provenance
  /** Imagery: the state's own at twenty centimetres or better, or Sentinel-2 at ten metres. */
  ortho: Provenance
  /** Whether the pipeline has searched here, so there are lines to browse rather than to plan. */
  lines: boolean
}

/**
 * What the colour on the map means, worst to best.
 *
 * Three bands rather than five columns, because a square two hundred pixels wide cannot say four
 * things at once and the hover says them all anyway. They are ordered by what changes the answer
 * most: whether a line was found for you, then whether the trees are measured, then nothing.
 */
export type Tier = 'terrain' | 'measured' | 'searched'

export const tierOf = (f: StateFacts): Tier =>
  f.lines ? 'searched' : f.canopy ? 'measured' : 'terrain'

/**
 * A point that is definitely inside a state, for asking the sources what they hold there.
 *
 * The centroid of the largest ring, unless the state is bent round it -- Schleswig-Holstein's
 * average is out in the Baltic -- in which case the ring's own points are walked until one of them
 * has neighbours on both sides, which for these shapes finds land immediately.
 */
function inside(rings: number[][][]): [number, number] {
  const ring = rings.reduce((big, r) => (r.length > big.length ? r : big), rings[0]!)
  const mid = ring.reduce(([x, y], p) => [x + p[0]! / ring.length, y + p[1]! / ring.length], [0, 0])
  if (enclosedBy(ring, mid[0]!, mid[1]!)) return [mid[0]!, mid[1]!]
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!
    const b = ring[(i + Math.floor(ring.length / 2)) % ring.length]!
    const p: [number, number] = [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2]
    if (enclosedBy(ring, p[0], p[1])) return p
  }
  return [mid[0]!, mid[1]!]
}

/** Ray casting, the same rule coverage.ts uses. Kept here rather than exported, it is four lines. */
function enclosedBy(ring: number[][], lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number]
    const [xj, yj] = ring[j] as [number, number]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const ORTHO_STATES = statesCovered(ORTHO_SURVEYS)
const SHADE_STATES = statesCovered(SHADE_SURVEYS)

/**
 * Which states the pipeline actually owns lines in, from the regions it reports.
 *
 * `owns25833` rather than the bounding box, since two neighbouring chunks overlap in what they load
 * and tile exactly in what they own -- the same distinction the coverage outlines on the map draw.
 * Null until the dataset has loaded, because claiming nothing is searched would be a worse guess
 * than admitting to not knowing yet.
 */
export function searchedStates(regions: Region[] | null): Set<string> | null {
  if (!regions) return null
  const found = new Set<string>()
  for (const r of regions) {
    const box = r.owns25833
    if (!box) continue
    const { lat, lon } = toWgs84((box.minE + box.maxE) / 2, (box.minN + box.maxN) / 2)
    for (const s of STATES) {
      if (s.code !== 'DE' && nearState(s.name, lon, lat, 0)) found.add(s.name)
    }
  }
  return found
}

/** Every state, in the order the map should read them. See {@link StateFacts}. */
export function integration(searched: Set<string> | null): StateFacts[] {
  return STATES.filter((s) => s.code !== 'DE').map((s) => {
    const [lon, lat] = inside(s.rings)
    const [e, n] = toUtm33(lat, lon)
    const source = SOURCES.find((src) => src.covers(e, n))
    return {
      code: s.code,
      name: s.name,
      ground: source && source !== hoehendaten ? 'survey' : 'shared',
      canopy: source?.hasSurface ?? false,
      shade: SHADE_STATES.has(s.name) ? 'survey' : 'shared',
      ortho: ORTHO_STATES.has(s.name) ? 'survey' : 'shared',
      lines: searched?.has(s.name) ?? false,
    }
  })
}
