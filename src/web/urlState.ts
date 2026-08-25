import type { RigHeights } from '../shared/plan.js'
import { LINE_KINDS, type LineKind } from '../shared/types.js'
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
 * Only what differs from the default is written. A link to the default view is the bare page, and
 * every parameter present in a URL is something the sharer actually changed -- which makes a shared
 * link readable, and means adding a new control with a new default does not invalidate old links.
 *
 * A selected candidate is stored twice over -- by id, and by the geometry needed to rebuild it as a
 * planned line. Ids are derived from anchor coordinates, so regenerating the dataset with different
 * parameters can move an anchor and orphan the id. The geometry then still reproduces the same line,
 * measured live, which is the difference between a stale link and a broken one.
 */

/** Slider positions, and the values at which each slider is not filtering anything. */
export interface Filters {
  minScore: number
  minLength: number
  minExposure: number
  maxCanopy: number
  maxOffLevel: number
}

export const FILTER_DEFAULTS: Filters = {
  minScore: 0,
  minLength: 0,
  minExposure: 0,
  maxCanopy: 100,
  maxOffLevel: 100,
}

/** URL parameter name per filter, kept short enough to read in a shared link. */
const FILTER_PARAMS: Record<keyof Filters, string> = {
  minScore: 'score',
  minLength: 'len',
  minExposure: 'air',
  maxCanopy: 'canopy',
  maxOffLevel: 'level',
}

export interface UrlState {
  /** south, west, north, east. */
  bbox: [number, number, number, number] | null
  lineId: string | null
  custom: CustomPoints
  rig: RigHeights | null
  sagPct: number | null
  /** Basemap blend position. Left unclamped here; the caller owns the valid range. */
  basemapMix: number | null
  /** Layer toggles. Null means the default, which is on for both. */
  showLines: boolean | null
  showHotspots: boolean | null
  /** Anchor classes shown. Null means all of them, which is the default. */
  kinds: LineKind[] | null
  /** Only the sliders that have been moved off {@link FILTER_DEFAULTS}. */
  filters: Partial<Filters>
}

const EMPTY: UrlState = {
  bbox: null,
  lineId: null,
  custom: { a: null, b: null },
  rig: null,
  sagPct: null,
  basemapMix: null,
  showLines: null,
  showHotspots: null,
  kinds: null,
  filters: {},
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

/** `0` turns a layer off. Anything else, including an absent parameter, leaves it on. */
const toggle = (raw: string | null): boolean | null => (raw === null ? null : raw !== '0')

/** A comma-separated subset of the anchor classes. Unrecognised names are ignored. */
function kinds(raw: string | null): LineKind[] | null {
  if (raw === null) return null
  const wanted = raw.split(',')
  const out = LINE_KINDS.filter((k) => wanted.includes(k))
  // An empty list is a real setting -- it means show no lines -- but a parameter naming nothing
  // recognisable is a broken link, and falling back to the default beats an empty map.
  return out.length || raw === '' ? out : null
}

export function parseUrl(search: string): UrlState {
  const q = new URLSearchParams(search)
  const at = numbers(q.get('at'), 4)
  const rig = numbers(q.get('rig'), 2)
  const sag = numbers(q.get('sag'), 1)
  const map = numbers(q.get('map'), 1)
  const filters: Partial<Filters> = {}
  for (const [field, param] of Object.entries(FILTER_PARAMS) as [keyof Filters, string][]) {
    const v = numbers(q.get(param), 1)
    if (v) filters[field] = v[0]!
  }
  return {
    ...EMPTY,
    bbox: at ? (at as [number, number, number, number]) : null,
    lineId: q.get('line'),
    custom: { a: point(q.get('a')), b: point(q.get('b')) },
    rig: rig ? { a: rig[0]!, b: rig[1]! } : null,
    sagPct: sag ? sag[0]! : null,
    basemapMix: map ? map[0]! : null,
    showLines: toggle(q.get('lines')),
    showHotspots: toggle(q.get('spots')),
    kinds: kinds(q.get('kinds')),
    filters,
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
  if (s.basemapMix !== null) q.set('map', s.basemapMix.toFixed(1))
  if (s.showLines === false) q.set('lines', '0')
  if (s.showHotspots === false) q.set('spots', '0')
  if (s.kinds) q.set('kinds', s.kinds.join(','))
  for (const [field, param] of Object.entries(FILTER_PARAMS) as [keyof Filters, string][]) {
    const v = s.filters[field]
    if (v !== undefined) q.set(param, String(Math.round(v * 100) / 100))
  }
  return q.toString()
}

/** The value, or null when it is exactly the default -- which is what keeps it out of the URL. */
export const changed = <T,>(value: T, fallback: T): T | null =>
  value === fallback ? null : value

/** Only the sliders that have been moved, ready to serialise. */
export function movedFilters(current: Filters): Partial<Filters> {
  const out: Partial<Filters> = {}
  for (const field of Object.keys(FILTER_DEFAULTS) as (keyof Filters)[]) {
    if (current[field] !== FILTER_DEFAULTS[field]) out[field] = current[field]
  }
  return out
}
