import { describe, expect, it } from 'vitest'
import {
  emptySpot, exportText, merged, nearbySpots, parseExport, spotFromHash, spotHash, type Spot, type SpotLine,
} from './spots.js'
import { startingPoint } from './useSpots.js'

const line = (lat: number, name = 'a line'): SpotLine => ({
  id: `l${lat}`,
  name,
  a: { lat, lon: 13 },
  b: { lat: lat + 0.001, lon: 13 },
  rig: null,
  sag: null,
})
const spot = (id: string, ...lines: SpotLine[]): Spot => ({ id, name: '', lines, edited: 1 })

describe('merged', () => {
  it('adds what is new, skips what is held, and keeps both where they differ', () => {
    const mine = [spot('s1', line(52)), spot('s2', line(53, 'mine'))]
    const theirs = [spot('s1', line(52)), spot('s2', line(53, 'theirs')), spot('s3', line(54))]
    const { spots, added } = merged(mine, theirs)
    expect(added).toBe(2)
    expect(spots.map((s) => s.lines[0]!.name)).toEqual(['a line', 'mine', 'theirs (imported)', 'a line'])
    expect(new Set(spots.map((s) => s.id)).size).toBe(4)
  })

  it('round-trips through an export file', () => {
    const mine = [spot('s1', line(52, 'top\nnotes')), spot('s2', line(53), line(53.01))]
    expect(merged(mine, parseExport(exportText(mine))).added).toBe(0)
  })
})

describe('nearbySpots', () => {
  it('lists spots with an anchor within reach, nearest first', () => {
    // 0.05 degrees of latitude is about 5.6 km, 0.2 about 22 km.
    const near = nearbySpots([spot('far', line(52.2)), spot('mid', line(52.05)), spot('here', line(52))], [
      { lat: 52, lon: 13 },
    ])
    expect(near.map((n) => n.spot.id)).toEqual(['here', 'mid'])
  })
})

describe('spotHash', () => {
  it('carries a spot through a link', () => {
    const at = (lat: number, lon: number) => ({ lat, lon })
    const lines: SpotLine[] = [
      { id: 'l1', name: 'Quarry\nbolts ü', a: at(52.1234567, 13.1), b: at(52.2, 13.2), rig: null, sag: null },
      { id: 'l2', name: '', a: at(52.3, 13.3), b: at(52.4, 13.4), rig: { a: 1.5, b: 0.8 }, sag: 4 },
    ]
    const back = spotFromHash(`#${spotHash({ id: 's1', name: 'Crag', lines, edited: 1 })}`)!
    expect(back.name).toBe('Crag')
    expect(back.lines.map(({ id: _, ...rest }) => rest)).toEqual(lines.map(({ id: _, ...rest }) => rest))
    expect(back.lines[0]!.id).not.toBe('l1')
  })
})

describe('startingPoint', () => {
  const saved = spot('s1', line(52), line(52.01))
  const draft = { ...emptySpot(), lines: [line(60)] }
  const lib = { spots: [saved], draft }
  const arrive = (l: SpotLine | null, name: string | null = null, shared: Spot | null = null) =>
    startingPoint(lib, { line: l ?? { a: null, b: null, rig: null, sag: null }, name, spot: shared })

  it('opens the saved line a link names', () => {
    const at = arrive(line(52.01), 'ignored')
    expect(at.working).toEqual({ spot: 's1', line: 1 })
    expect(at.replaced).toBeNull()
  })

  it('puts a line nobody saved into the draft under its name, keeping the old draft for undo', () => {
    const at = arrive(line(70), 'From a friend')
    expect(at.working).toEqual({ spot: draft.id, line: 0 })
    expect(at.lib.draft.lines.map((l) => [l.a.lat, l.name])).toEqual([[70, 'From a friend']])
    expect(at.replaced).toBe(draft)
  })

  it('puts a shared spot into the draft, on the line the link has open', () => {
    const at = arrive(line(81), null, spot('x', line(80), line(81)))
    expect(at.working).toEqual({ spot: draft.id, line: 1 })
    expect(at.lib.draft.lines).toHaveLength(2)
    expect(at.replaced).toBe(draft)
  })

  it('opens a shared spot that is already saved', () => {
    const at = arrive(null, null, spot('x', line(52.01), line(52)))
    expect(at.working).toEqual({ spot: 's1', line: 0 })
    expect(at.lib).toBe(lib)
  })

  it('comes back to the draft as it was left on a bare link', () => {
    const at = arrive(null)
    expect(at.working).toEqual({ spot: draft.id, line: 0 })
    expect(at.lib).toBe(lib)
  })
})
