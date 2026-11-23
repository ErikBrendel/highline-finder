import type { RigHeights } from '../shared/plan.js'
import { spanGeometry, type LatLon, type LineSpec } from './planPoints.js'
import { report } from './report.js'

/**
 * Lines a person has kept, grouped into spots: one place, any number of lines.
 *
 * A line kept on its own is a spot with one line in it, and the UI shows it as just that line. So
 * there is one list and one kind of thing in it, whether it holds a single line or an event's twenty.
 *
 * The draft is a spot too, kept apart from the saved ones: whatever is being explored when no saved
 * spot is open. It is stored like the rest, so closing the tab loses nothing.
 */

export interface SpotLine extends LineSpec {
  id: string
  /** Free text. The first line is the title, the rest are notes. */
  name: string
  a: LatLon
  b: LatLon
}

export interface Spot {
  id: string
  /** Only shown once the spot holds more than one line. */
  name: string
  lines: SpotLine[]
  edited: number
}

export interface Library {
  spots: Spot[]
  draft: Spot
}

/** How far from a saved spot a new line is offered to it rather than to a spot of its own. */
export const NEARBY_METRES = 10_000

const STORE_KEY = 'highline-finder.spots'

export const newId = () => crypto.randomUUID()

export const emptySpot = (): Spot => ({ id: newId(), name: '', lines: [], edited: Date.now() })

export const titleOf = (text: string) => text.split('\n')[0]!.trim()

export function spotTitle(s: Spot): string {
  const own = s.lines.length > 1 ? titleOf(s.name) : ''
  return own || titleOf(s.lines[0]?.name ?? '') || 'Untitled'
}

export const defaultLineName = (a: LatLon, b: LatLon) => `${Math.round(spanGeometry(a, b).length)} m line`

/** Appends to the title, leaving the notes under it alone. */
export function retitled(text: string, suffix: string): string {
  const [first, ...rest] = text.split('\n')
  return [`${first}${suffix}`, ...rest].join('\n')
}

const samePoint = (p: LatLon, q: LatLon) =>
  Math.abs(p.lat - q.lat) < 1e-7 && Math.abs(p.lon - q.lon) < 1e-7

export const sameAnchors = (l: { a: LatLon; b: LatLon }, a: LatLon, b: LatLon) =>
  samePoint(l.a, a) && samePoint(l.b, b)

/** Saved spots with an anchor within `within` metres of any of `at`, nearest first. */
export function nearbySpots(spots: Spot[], at: LatLon[], within = NEARBY_METRES): { spot: Spot; metres: number }[] {
  return spots
    .map((spot) => ({
      spot,
      metres: Math.min(
        ...spot.lines.flatMap((l) => [l.a, l.b]).flatMap((p) => at.map((q) => spanGeometry(p, q).length)),
      ),
    }))
    .filter((n) => n.metres <= within)
    .sort((p, q) => p.metres - q.metres)
}

/** The saved spot and line with exactly these anchors, if any. */
export function findLine(spots: Spot[], a: LatLon, b: LatLon): { spot: Spot; index: number } | null {
  for (const spot of spots) {
    const index = spot.lines.findIndex((l) => sameAnchors(l, a, b))
    if (index >= 0) return { spot, index }
  }
  return null
}

const content = (s: Spot) =>
  JSON.stringify({ name: s.name, lines: s.lines.map(({ id: _, ...rest }) => rest) })

/**
 * Adds what is not there yet and never overwrites: a spot that exists here in another state comes
 * in as a copy beside it, so importing can lose nothing.
 */
export function merged(mine: Spot[], incoming: Spot[]): { spots: Spot[]; added: number } {
  const out = [...mine]
  let added = 0
  for (const spot of incoming) {
    const held = out.find((s) => s.id === spot.id)
    if (held && content(held) === content(spot)) continue
    if (out.some((s) => content(s) === content(spot))) continue
    added++
    if (!held) {
      out.push(spot)
      continue
    }
    const single = spot.lines.length === 1
    out.push({
      ...spot,
      id: newId(),
      name: single ? spot.name : retitled(spot.name || spotTitle(spot), ' (imported)'),
      lines: single ? [{ ...spot.lines[0]!, name: retitled(spot.lines[0]!.name, ' (imported)') }] : spot.lines,
    })
  }
  return { spots: out, added }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPoint = (v: unknown): v is LatLon =>
  !!v && typeof v === 'object' && isNum((v as LatLon).lat) && isNum((v as LatLon).lon)

function asLine(raw: unknown): SpotLine | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  if (!isPoint(l.a) || !isPoint(l.b)) return null
  const rig = l.rig as RigHeights | null | undefined
  return {
    id: typeof l.id === 'string' ? l.id : newId(),
    name: typeof l.name === 'string' ? l.name : '',
    a: { lat: l.a.lat, lon: l.a.lon },
    b: { lat: l.b.lat, lon: l.b.lon },
    rig: rig && isNum(rig.a) && isNum(rig.b) ? { a: rig.a, b: rig.b } : null,
    sag: isNum(l.sag) ? l.sag : null,
  }
}

function asSpot(raw: unknown): Spot | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (!Array.isArray(s.lines)) return null
  return {
    id: typeof s.id === 'string' ? s.id : newId(),
    name: typeof s.name === 'string' ? s.name : '',
    lines: s.lines.map(asLine).filter((l): l is SpotLine => l !== null),
    edited: isNum(s.edited) ? s.edited : Date.now(),
  }
}

/** Spots out of an export file. Throws on anything that is not one. */
export function parseExport(text: string): Spot[] {
  const raw = JSON.parse(text) as { spots?: unknown }
  if (!Array.isArray(raw?.spots)) throw new Error('not a Highline Finder export')
  return raw.spots.map(asSpot).filter((s): s is Spot => s !== null && s.lines.length > 0)
}

export const exportText = (spots: Spot[]) =>
  JSON.stringify({ app: 'highline-finder', version: 1, spots }, null, 1)

export function loadLibrary(): Library {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { spots?: unknown; draft?: unknown } | null
    const spots = Array.isArray(raw?.spots) ? raw.spots.map(asSpot).filter((s): s is Spot => s !== null) : []
    return { spots, draft: asSpot(raw?.draft) ?? emptySpot() }
  } catch (e) {
    report('reading the saved lines', e)
    return { spots: [], draft: emptySpot() }
  }
}

export function storeLibrary(lib: Library): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(lib))
  } catch (e) {
    report('storing the saved lines', e)
  }
}
