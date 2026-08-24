import type { RigHeights } from '../shared/plan.js'
import type { CustomPoints, LatLon } from './planPoints.js'

/**
 * The part of the app's state that belongs in the URL, so a view can be shared.
 *
 * Pure parse and serialise, no map or React involvement, because the interesting behaviour is the
 * round trip and that is worth testing directly.
 *
 * The viewport is a rectangle rather than centre and zoom: the point of a shared link is that the
 * recipient sees the same ground, and centre-plus-zoom shows a different area on a different sized
 * window. The cost is that reopening and resharing on a differently shaped window widens the
 * rectangle slightly, since a fitted view is a superset of what was asked for.
 *
 * A selected candidate is stored twice over -- by id, and by the geometry needed to rebuild it as a
 * planned line. Ids are derived from anchor coordinates, so regenerating the dataset with different
 * parameters can move an anchor and orphan the id. The geometry then still reproduces the same line,
 * measured live, which is the difference between a stale link and a broken one.
 */

export interface UrlState {
  /** south, west, north, east. */
  bbox: [number, number, number, number] | null
  lineId: string | null
  custom: CustomPoints
  rig: RigHeights | null
  sagPct: number | null
}

const EMPTY: UrlState = {
  bbox: null,
  lineId: null,
  custom: { a: null, b: null },
  rig: null,
  sagPct: null,
}

/** 6 decimals of a degree is ~11 cm, past any accuracy this data has. */
const coord = (v: number) => v.toFixed(6).replace(/\.?0+$/, '')

function numbers(raw: string | null, count: number): number[] | null {
  if (!raw) return null
  const parts = raw.split(',').map(Number)
  if (parts.length !== count || parts.some((v) => !Number.isFinite(v))) return null
  return parts
}

function point(raw: string | null): LatLon | null {
  const n = numbers(raw, 2)
  if (!n) return null
  const [lat, lon] = n as [number, number]
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

export function parseUrl(search: string): UrlState {
  const q = new URLSearchParams(search)
  const at = numbers(q.get('at'), 4)
  const rig = numbers(q.get('rig'), 2)
  const sag = numbers(q.get('sag'), 1)
  return {
    ...EMPTY,
    bbox: at ? (at as [number, number, number, number]) : null,
    lineId: q.get('line'),
    custom: { a: point(q.get('a')), b: point(q.get('b')) },
    rig: rig ? { a: rig[0]!, b: rig[1]! } : null,
    sagPct: sag ? sag[0]! : null,
  }
}

export function toSearch(s: UrlState): string {
  const q = new URLSearchParams()
  if (s.bbox) q.set('at', s.bbox.map((v) => v.toFixed(5)).join(','))
  if (s.lineId) q.set('line', s.lineId)
  if (s.custom.a) q.set('a', `${coord(s.custom.a.lat)},${coord(s.custom.a.lon)}`)
  if (s.custom.b) q.set('b', `${coord(s.custom.b.lat)},${coord(s.custom.b.lon)}`)
  if (s.rig) q.set('rig', `${s.rig.a.toFixed(2)},${s.rig.b.toFixed(2)}`)
  if (s.sagPct !== null) q.set('sag', s.sagPct.toFixed(1))
  return q.toString()
}
