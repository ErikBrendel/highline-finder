import { describe, expect, it } from 'vitest'
import {
  exportText, merged, nearbySpots, opened, parseExport, rebased, sealedForm, spotFromHash, spotHash, spotOfText,
  spotText, type Spot, type SpotLine,
} from './spots.js'
import { movedLine, reopened, startingPoint, visibleOf } from './useSpots.js'
import { newVault, openVault, seal, unseal } from './vault.js'

const line = (lat: number, name = 'a line'): SpotLine => ({
  id: `l${lat}`,
  name,
  a: { lat, lon: 13 },
  b: { lat: lat + 0.001, lon: 13 },
  rig: null,
  sag: null,
})
const spot = (id: string, ...lines: SpotLine[]): Spot => ({ id, name: '', lines, edited: 1, secret: false })

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
    expect(merged(mine, parseExport(exportText(mine)).spots).added).toBe(0)
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
    const back = spotFromHash(`#${spotHash({ id: 's1', name: 'Crag', lines, edited: 1, secret: true })}`)!
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

describe('secret spots', () => {
  const hidden = { ...spot('s2', line(53, 'private land')), secret: true }
  const lib = { spots: [spot('s1', line(52)), hidden], draft: null }

  it('are left off screen until shown, and never as an unopened shell', () => {
    expect(visibleOf(lib, false).spots.map((s) => s.id)).toEqual(['s1'])
    expect(visibleOf(lib, true).spots.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(visibleOf(sealedForm(lib), true).spots.map((s) => s.id)).toEqual(['s1'])
  })

  it('reach the disk as a shell, and come back from what this tab opened', () => {
    const stored = sealedForm(lib)
    expect(JSON.stringify(stored)).not.toContain('private land')
    expect(opened(stored, new Map([['s2', hidden]]))).toEqual(lib)
  })

  it('seal under a password, and open only with it and under their own id', async () => {
    const { vault, key } = await newVault('correct horse')
    const sealed = await seal(key, spotText(hidden), hidden.id)
    expect(spotOfText(await unseal((await openVault(vault, 'correct horse'))!, sealed, 's2'))).toEqual(hidden)
    expect(await openVault(vault, 'wrong')).toBeNull()
    await expect(unseal(key, sealed, 's1')).rejects.toThrow()
  })

  it('travel in an export file sealed, with what it takes to open them', () => {
    const vault = { salt: 'c2FsdA==', check: 'Y2hlY2s=' }
    const file = parseExport(exportText([lib.spots[0]!], { vault, spots: [{ id: 's2', data: 'c2VhbGVk' }] }))
    expect(file.spots.map((s) => s.id)).toEqual(['s1'])
    expect(file.sealed).toEqual({ vault, spots: [{ id: 's2', data: 'c2VhbGVk' }] })
    expect(parseExport(exportText([hidden])).spots[0]!.secret).toBe(true)
  })
})

describe('movedLine', () => {
  const lib = { spots: [spot('s1', line(52), line(53)), spot('s2', line(60))], draft: null }

  it('moves a line into another spot and opens it there', () => {
    const out = movedLine(lib, 's1', 0, { kind: 'spot', id: 's2' })!
    expect(out.lib.spots.map((s) => s.lines.map((l) => l.id))).toEqual([['l53'], ['l60', 'l52']])
    expect(out.open).toEqual({ kind: 'spot', spot: 's2', line: 1, editing: false })
  })

  it('moves the last line to the draft line, and the empty spot goes', () => {
    const out = movedLine(lib, 's2', 0, { kind: 'draft' })!
    expect(out.lib.spots.map((s) => s.id)).toEqual(['s1'])
    expect(out.lib.draft?.id).toBe('l60')
    expect(movedLine(out.lib, 's1', 0, { kind: 'draft' })).toBeNull()
  })

  it('gives a line a spot of its own, as secret as the one it left', () => {
    const out = movedLine({ ...lib, spots: [{ ...lib.spots[0]!, secret: true }] }, 's1', 1, { kind: 'own' })!
    expect(out.lib.spots.map((s) => [s.lines.map((l) => l.id), s.secret])).toEqual([[['l52'], true], [['l53'], true]])
  })
})
