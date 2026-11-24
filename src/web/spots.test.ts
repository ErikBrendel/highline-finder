import { describe, expect, it } from 'vitest'
import {
  exportText, merged, nearbySpots, parseExport, rebased, spotFromHash, spotHash, type Spot, type SpotLine,
} from './spots.js'
import { reopened, startingPoint } from './useSpots.js'

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
  const draft = line(60)
  const lib = { spots: [saved], draft }
  const arrive = (l: SpotLine | null, name: string | null = null, shared: Spot | null = null) =>
    startingPoint(lib, { line: l ?? { a: null, b: null, rig: null, sag: null }, name, spot: shared })

  it('opens the saved line a link names, to look at', () => {
    expect(arrive(line(52.01), 'ignored').open).toEqual({ kind: 'spot', spot: 's1', line: 1, editing: false })
  })

  it('looks at a line nobody saved under its name, leaving the draft alone', () => {
    expect(arrive(line(70), 'From a friend').open).toEqual({ kind: 'found', name: 'From a friend' })
  })

  it('opens the draft line when the link is to it', () => {
    expect(arrive(line(60)).open).toEqual({ kind: 'draft' })
  })

  it('holds a shared spot apart, on the line the link has open', () => {
    const shared = spot('x', line(80), line(81))
    expect(arrive(line(81), null, shared)).toEqual({ open: { kind: 'shared', line: 1 }, shared })
  })

  it('opens a shared spot that is already saved, with no line picked', () => {
    expect(arrive(null, null, spot('x', line(52.01), line(52)))).toEqual({
      open: { kind: 'spot', spot: 's1', line: null, editing: false },
      shared: null,
    })
  })

  it('comes back to the draft line on a bare link', () => {
    expect(arrive(null).open).toEqual({ kind: 'draft' })
  })
})

describe('rebased', () => {
  it('lays this tab\'s change over another tab\'s, keeping both', () => {
    const base = { spots: [spot('s1', line(52)), spot('s2', line(53))], draft: line(60) }
    const next = { ...base, spots: [{ ...base.spots[0]!, name: 'mine' }] }
    const stored = { spots: [...base.spots, spot('s3', line(54))], draft: line(61) }
    const out = rebased(base, next, stored)
    expect(out.spots.map((s) => [s.id, s.name])).toEqual([['s1', 'mine'], ['s3', '']])
    expect(out.draft).toEqual(line(61))
    expect(out.spots[0]).toBe(next.spots[0])
  })
})

describe('reopened', () => {
  const before = { spots: [spot('s1', line(52), line(53), line(54))], draft: null }
  const open = { kind: 'spot', spot: 's1', line: 2, editing: true } as const

  it('follows the open line when another tab removes one before it', () => {
    const after = { ...before, spots: [spot('s1', line(52), line(54))] }
    expect(reopened(open, before, after)).toEqual({ open: { ...open, line: 1 }, reload: false })
  })

  it('reloads the open line another tab changed, and lets go of one it removed', () => {
    const changed = { ...before, spots: [spot('s1', line(52), line(53), line(54, 'theirs'))] }
    expect(reopened(open, before, changed).reload).toBe(true)
    const removed = { ...before, spots: [spot('s1', line(52))] }
    expect(reopened(open, before, removed).open).toEqual({ ...open, line: null, editing: false })
  })

  it('closes a spot another tab deleted', () => {
    expect(reopened(open, before, { spots: [], draft: null })).toEqual({ open: { kind: 'none' }, reload: true })
  })
})
