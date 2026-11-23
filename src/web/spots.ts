import type { RigHeights } from '../shared/plan.js'
import { spanGeometry, type LatLon, type LineSpec } from './planPoints.js'
import { report } from './report.js'

/**
 * Lines a person has kept, grouped into spots: one place, any number of lines.
 *
 * A line kept on its own is a spot with one line in it, and the UI shows it as just that line. So
 * there is one list and one kind of thing in it, whether it holds a single line or an event's twenty.
 *
 * The draft is one line apart from them: the line being planned by hand when nothing saved is being
 * edited. It is stored like the rest, so closing the tab loses nothing.
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
  draft: SpotLine | null
}

/** How far from a saved spot a new line is offered to it rather than to a spot of its own. */
export const NEARBY_METRES = 10_000

const STORE_KEY = 'highline-finder.spots'

export const newId = () => crypto.randomUUID()

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

/** Whether two spots hold the same lines, in whatever order. */
export const sameLines = (s: Spot, t: Spot) =>
  s.lines.length === t.lines.length && t.lines.every((l) => s.lines.some((m) => sameAnchors(m, l.a, l.b)))

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

type Packed = [string, [string, number, number, number, number, number | null, number | null, number | null][]]

const round = (v: number, digits: number) => Number(v.toFixed(digits))

/**
 * A spot as a link fragment: compact JSON in base64url, small enough for a chat message with twenty
 * lines in it. A fragment rather than a parameter, so it never reaches a server log.
 */
export function spotHash(s: Spot): string {
  const packed: Packed = [
    s.name,
    s.lines.map((l) => [
      l.name,
      round(l.a.lat, 7), round(l.a.lon, 7), round(l.b.lat, 7), round(l.b.lon, 7),
      l.rig ? round(l.rig.a, 2) : null, l.rig ? round(l.rig.b, 2) : null,
      l.sag,
    ]),
  ]
  const binary = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(packed)))
  return `spot=${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/** The spot a link fragment carries, with ids of its own; null when there is none or it is broken. */
export function spotFromHash(hash: string): Spot | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('spot')
  if (!raw) return null
  try {
    const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'))
    const packed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))) as unknown
    if (!Array.isArray(packed) || !Array.isArray(packed[1])) return null
    const spot = asSpot({
      name: packed[0],
      lines: (packed[1] as unknown[]).map((l) =>
        Array.isArray(l) && {
          name: l[0],
          a: { lat: l[1], lon: l[2] },
          b: { lat: l[3], lon: l[4] },
          rig: { a: l[5], b: l[6] },
          sag: l[7],
        },
      ),
    })
    return spot?.lines.length ? { ...spot, id: newId(), lines: spot.lines.map((l) => ({ ...l, id: newId() })) } : null
  } catch (e) {
    report('reading a shared spot', e)
    return null
  }
}

export function loadLibrary(): Library {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as { spots?: unknown; draft?: unknown } | null
    const spots = Array.isArray(raw?.spots) ? raw.spots.map(asSpot).filter((s): s is Spot => s !== null) : []
    return { spots, draft: asLine(raw?.draft) }
  } catch (e) {
    report('reading the saved lines', e)
    return { spots: [], draft: null }
  }
}

export function storeLibrary(lib: Library): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(lib))
  } catch (e) {
    report('storing the saved lines', e)
  }
}
