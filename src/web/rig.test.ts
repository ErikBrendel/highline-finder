import { describe, expect, it } from 'vitest'
import { depths, WEBBINGS, type Rig } from './rig.js'

const y2k = WEBBINGS.find((w) => w.name === 'Y2K')!
const weightless = { ...y2k, gPerM: 0 }
const rig = (lengthM: number): Rig => ({ webbing: weightless, pretensionKn: 1.5, walkerKg: 80, lengthM, backupSlackM: lengthM * 0.02 })

describe('depths', () => {
  it('matches the point-load relation on a webbing so stretchy its tension holds', () => {
    const stiff = { ...weightless, curve: [[10, 1000]] as [number, number][] }
    const { walking } = depths({ ...rig(100), webbing: stiff, pretensionKn: 2 })
    expect(walking / 100).toBeCloseTo((80 * 9.81) / 1000 / (4 * 2), 2)
  })

  it('walks at one fraction of span whatever the length, and falls deeper in that order', () => {
    const short = depths(rig(100))
    const long = depths(rig(500))
    expect(long.walking / 500).toBeCloseTo(short.walking / 100, 3)
    for (const d of [short, long]) {
      expect(d.leashFall).toBeGreaterThan(d.walking * 1.2)
      expect(d.backupFall).toBeGreaterThan(d.leashFall)
    }
  })

  it('sags a long line further under its own weight', () => {
    expect(depths({ ...rig(500), webbing: y2k }).walking).toBeGreaterThan(depths(rig(500)).walking + 1)
  })
})
