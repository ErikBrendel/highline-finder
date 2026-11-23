import { describe, expect, it } from 'vitest'
import { emptySpot, exportText, merged, nearbySpots, parseExport, type Spot, type SpotLine } from './spots.js'
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

describe('startingPoint', () => {
  const saved = spot('s1', line(52), line(52.01))
  const draft = { ...emptySpot(), lines: [line(60)] }
  const lib = { spots: [saved], draft }

  it('opens the saved line a link names', () => {
    const at = startingPoint(lib, { ...line(52.01), rig: null })
    expect(at.working).toEqual({ spot: 's1', line: 1 })
    expect(at.replaced).toBeNull()
  })

  it('puts a line nobody saved into the draft, keeping the old draft for undo', () => {
    const at = startingPoint(lib, line(70))
    expect(at.working).toEqual({ spot: draft.id, line: 0 })
    expect(at.lib.draft.lines).toEqual([])
    expect(at.replaced).toBe(draft)
  })

  it('comes back to the draft as it was left on a bare link', () => {
    const at = startingPoint(lib, { a: null, b: null, rig: null, sag: null })
    expect(at.working).toEqual({ spot: draft.id, line: 0 })
    expect(at.lib).toBe(lib)
  })
})
