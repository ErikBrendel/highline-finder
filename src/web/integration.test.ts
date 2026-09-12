import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STATES } from './coverage.js'
import { integration, searchedStates, tierOf } from './integration.js'
import { ORTHO_SURVEYS, SHADE_SURVEYS, statesCovered } from './surveys.js'
import { toUtm33 } from '../shared/geo.js'
import type { Region } from '../shared/types.js'

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

/**
 * The rule against the real dataset, which is where it went wrong.
 *
 * The pipeline's 8 km chunks tile Brandenburg's bounding box, so those along the border own ground
 * on the far side -- and Brandenburg's survey renders past its own state line, so lines really are
 * found there. Any rule that asks "is there searched ground in this state" therefore credits four
 * neighbours, and the guide told people Saxony and Lower Saxony had been searched. Read against
 * the dataset rather than a fixture, because a fixture is exactly what missed it.
 */
/**
 * What the map's borders are filtered by.
 *
 * MapView splits boundaries.json into a solid layer and a dashed one by matching the feature's name
 * against the states a survey measures canopy in. Both lists come from the BKG, so they agree --
 * but the match is a string compare, and one of them spelt differently would not fail anywhere: it
 * would quietly draw every border in the country as the weaker promise.
 */
const BORDERS = new URL('public/boundaries.json', import.meta.url).pathname

describe('boundaries.json', () => {
  const drawn = (
    JSON.parse(readFileSync(BORDERS, 'utf8')) as {
      features: { properties: { name: string } }[]
    }
  ).features.map((f) => f.properties.name)

  it('draws every state and calls each what the outlines call it', () => {
    const known = STATES.filter((s) => s.code !== 'DE').map((s) => s.name)
    expect(drawn.sort()).toEqual([...known].sort())
  })

  it('has a border to draw solid for every state whose canopy is measured', () => {
    for (const f of integration(null).filter((f) => f.canopy)) expect(drawn).toContain(f.name)
  })
})

const META = new URL('public/meta.json', import.meta.url).pathname
const meta = existsSync(META)
  ? (JSON.parse(readFileSync(META, 'utf8')) as { regions: Region[] })
  : null

describe.skipIf(!meta)('searchedStates, against the generated dataset', () => {
  it('names Berlin and Brandenburg and no neighbour they spill into', () => {
    expect([...searchedStates(meta!.regions)!].sort()).toEqual(['Berlin', 'Brandenburg'])
  })
})

describe('searchedStates', () => {
  /** Chunks of the pipeline's own size, tiling a box. */
  const tiling = (box: [number, number, number, number]) => {
    const out: Pick<Region, 'owns25833'>[] = []
    for (let e = box[0]; e < box[2]; e += 8000) {
      for (let n = box[1]; n < box[3]; n += 8000) {
        out.push({ owns25833: { minE: e, minN: n, maxE: e + 8000, maxN: n + 8000 } })
      }
    }
    return out
  }

  it('is unknown rather than empty before the dataset lands', () => {
    expect(searchedStates(null)).toBeNull()
  })

  it('does not claim a state a run only reaches the edge of', () => {
    // A strip along the Saxon border, the shape a chunk grid over Brandenburg leaves behind.
    const [e, n] = toUtm33(51.36, 14.2)
    expect([...searchedStates(tiling([e - 8000, n - 8000, e + 8000, n + 8000]))!]).toEqual([])
  })

  it('claims one it covers', () => {
    const [e, n] = toUtm33(52.5, 13.4)
    expect([...searchedStates(tiling([e - 24000, n - 24000, e + 24000, n + 24000]))!]).toContain(
      'Berlin',
    )
  })
})
