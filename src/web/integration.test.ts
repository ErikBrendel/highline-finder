import { describe, expect, it } from 'vitest'
import { STATES } from './coverage.js'
import { integration, searchedStates, tierOf } from './integration.js'
import { ORTHO_SURVEYS, SHADE_SURVEYS, statesCovered } from './surveys.js'
import { toUtm33 } from '../shared/geo.js'

const byCode = (code: string) => integration(null).find((f) => f.code === code)!

describe('integration', () => {
  it('describes all sixteen states and nothing else', () => {
    const all = integration(null)
    expect(all).toHaveLength(16)
    expect(all.map((f) => f.code)).not.toContain('DE')
  })

  /**
   * The trap this whole file exists to avoid. A state name is written out in three places -- the
   * elevation sources, the basemap layers and the outlines -- and one spelt differently in any of
   * them does not fail: `nearState` waves an unknown name through and `statesCovered` quietly
   * matches nothing, so the map goes on claiming the old thing with no error anywhere.
   */
  it('uses no state name that has no outline', () => {
    const known = new Set(STATES.map((s) => s.name))
    for (const name of [...statesCovered(ORTHO_SURVEYS), ...statesCovered(SHADE_SURVEYS)]) {
      expect(known, `${name} is not a state in states.json`).toContain(name)
    }
  })

  it('reads canopy off the source that actually answers there', () => {
    // The four surveys with a surface model, and one of the twelve without.
    for (const code of ['BB', 'BE', 'ST', 'NW', 'MV']) expect(byCode(code).canopy).toBe(true)
    expect(byCode('BY').canopy).toBe(false)
    expect(byCode('BY').ground).toBe('shared')
  })

  /** Berlin is a hole in Brandenburg's outline, and the same survey holds both. */
  it('does not leave Berlin to the republisher', () => {
    expect(byCode('BE').ground).toBe('survey')
  })

  /**
   * Whether the point each state is judged by is really inside it.
   *
   * Not directly visible, so it is checked through what depends on it: a centroid that lands in the
   * Baltic or in a neighbour would be asked of the wrong survey, and exactly the four states with
   * their own service must come back as 'survey'. Schleswig-Holstein is the shape that makes this
   * worth testing -- it wraps around the Kiel fjord and its average position is at sea.
   */
  it('judges every state by a point inside it', () => {
    const own = integration(null)
      .filter((f) => f.ground === 'survey')
      .map((f) => f.code)
    expect(own.sort()).toEqual(['BB', 'BE', 'MV', 'NW', 'ST'])
  })

  it('ranks a searched state above a measured one above a bare one', () => {
    // Without the dataset Brandenburg is only as good as its survey makes it; lines are what
    // lift it, and they are the one fact here that does not come from a service.
    expect(tierOf(byCode('BB'))).toBe('measured')
    const searched = integration(new Set(['Brandenburg']))
    expect(tierOf(searched.find((f) => f.code === 'BB')!)).toBe('searched')
    expect(tierOf(byCode('NW'))).toBe('measured')
    expect(tierOf(byCode('BY'))).toBe('terrain')
  })
})

describe('searchedStates', () => {
  const owning = (lat: number, lon: number) => {
    const [e, n] = toUtm33(lat, lon)
    return { id: 'chunk', aois: [], owns25833: { minE: e, minN: n, maxE: e + 10, maxN: n + 10 } }
  }

  it('is unknown rather than empty before the dataset lands', () => {
    expect(searchedStates(null)).toBeNull()
  })

  /** A chunk that loads past its own edge still only owns what is inside it. */
  it('names the states the regions own ground in', () => {
    const found = searchedStates([owning(52.83, 13.75), owning(52.52, 13.4)] as never)
    expect([...found!].sort()).toEqual(['Berlin', 'Brandenburg'])
  })
})
