import { toUtm33 } from '../shared/geo.js'

/**
 * The planned line's two ends, and the one rule that governs placing them.
 *
 * Kept apart from the map and the panel because it is the only part of the planner that can refuse
 * something, and it is pure -- given the current pair and a new point it says what the pair becomes.
 */

export interface LatLon {
  lat: number
  lon: number
}

export interface CustomPoints {
  a: LatLon | null
  b: LatLon | null
}

/**
 * Longest span the planner will hold both ends of.
 *
 * Not a rigging limit -- `maxLength` is that, and an over-long line is reported as a violation
 * rather than refused. This exists because a planned line fetches an elevation window for every
 * 256 m it crosses: a stray click on the far side of the map would start pulling down a corridor
 * hundreds of windows long before anyone could stop it. Past this the far end is dropped instead,
 * leaving a single placed point, which fetches nothing at all.
 */
export const PLANNED_MAX_SPAN = 4000

/**
 * Ground distance and bearing between two placed points -- the part of a planned line that needs no
 * elevation at all, so it can be shown while the raster is still on its way.
 *
 * Deliberately the same projection and the same expressions the pipeline uses, so the figures do
 * not shift when the real measurement arrives.
 */
export function spanGeometry(a: LatLon, b: LatLon): { length: number; bearing: number } {
  const [ae, an] = toUtm33(a.lat, a.lon)
  const [be, bn] = toUtm33(b.lat, b.lon)
  return {
    length: Math.hypot(be - ae, bn - an),
    bearing: Math.round((Math.atan2(be - ae, bn - an) * 180) / Math.PI + 360) % 360,
  }
}

function spanMetres(a: LatLon, b: LatLon): number {
  return spanGeometry(a, b).length
}

/** Puts one end of the planned line, dropping the far end if the span would be beyond the cap. */
export function place(points: CustomPoints, which: 'a' | 'b', at: LatLon | null): CustomPoints {
  const other = which === 'a' ? points.b : points.a
  const keep = !at || !other || spanMetres(at, other) <= PLANNED_MAX_SPAN
  return which === 'a'
    ? { a: at, b: keep ? points.b : null }
    : { a: keep ? points.a : null, b: at }
}
