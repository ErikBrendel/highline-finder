import { describe, expect, it } from 'vitest'
import { boxOf, contains, recomputes, workAreas, type WorkArea } from './regions.js'
import type { Aoi } from '../shared/types.js'
import { DEFAULT_CHUNKS } from './params.js'
import { parseChunk } from './chunks.js'

const at = (south: number, west: number, size = 0.005): Aoi => ({
  south,
  west,
  north: south + size,
  east: west + size,
})

describe('workAreas', () => {
  it('leaves a single AOI exactly as it is, so results do not shift', () => {
    const aoi = at(52.2, 13.65)
    const [area, ...rest] = workAreas([aoi], 500)
    expect(rest).toHaveLength(0)
    expect(area!.bbox).toEqual(boxOf(aoi))
  })

  it('keeps AOIs further apart than a line could span separate', () => {
    expect(workAreas([at(52.2, 13.65), at(52.85, 13.9)], 500)).toHaveLength(2)
  })

  it('merges AOIs close enough for a line to cross between them', () => {
    // ~340 m apart in northing, inside a 500 m reach.
    const areas = workAreas([at(52.2, 13.65), at(52.208, 13.65)], 500)
    expect(areas).toHaveLength(1)
    expect(areas[0]!.aois).toHaveLength(2)
    expect(areas[0]!.boxes).toHaveLength(2)
  })

  it('merges transitively, so a chain becomes one area', () => {
    const areas = workAreas([at(52.2, 13.65), at(52.208, 13.65), at(52.216, 13.65)], 500)
    expect(areas).toHaveLength(1)
    expect(areas[0]!.aois).toHaveLength(3)
  })

  it('searches only inside the AOIs, not the ground merged in between', () => {
    const areas = workAreas([at(52.2, 13.65), at(52.208, 13.65)], 500)
    const { bbox, boxes } = areas[0]!
    const midN = (boxes[0]!.maxN + boxes[1]!.minN) / 2
    const e = boxes[0]!.minE + 10
    expect(contains(bbox, e, midN)).toBe(true)
    expect(boxes.some((b) => contains(b, e, midN))).toBe(false)
  })

  it('orders regions smallest first, so a bad run fails early and cheaply', () => {
    // Deliberately given largest first, to show the order is chosen rather than inherited.
    const big: Aoi = { south: 52.0, west: 13.0, north: 52.5, east: 13.5 }
    const middling: Aoi = { south: 51.0, west: 12.0, north: 51.1, east: 12.1 }
    const small: Aoi = { south: 50.0, west: 11.0, north: 50.01, east: 11.01 }
    const sizes = workAreas([big, middling, small], 500).map(
      (w) => (w.bbox.maxE - w.bbox.minE) * (w.bbox.maxN - w.bbox.minN),
    )
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
  })
})

describe('recomputes', () => {
  const area = (...aois: Aoi[]): WorkArea =>
    ({ id: 'x', kind: 'aoi', aois, boxes: [], bbox: boxOf(aois[0]!) })
  const tropical: Aoi = { south: 52.19, west: 13.65, north: 52.21, east: 13.67 }
  const linthe: Aoi = { south: 52.13, west: 12.77, north: 52.15, east: 12.81 }

  it('recomputes nothing by default, which is what keeping results means', () => {
    expect(recomputes(area(tropical), null)).toBe(false)
  })

  it('recomputes everything when told to', () => {
    expect(recomputes(area(tropical), 'all')).toBe(true)
  })

  it('picks a whole merged area when a rectangle touches any part of it', () => {
    // A region is searched as one grid, so naming half of one selects all of it.
    expect(recomputes(area(tropical, linthe), [{ ...linthe, north: 52.14 }])).toBe(true)
    expect(recomputes(area(tropical), [linthe])).toBe(false)
  })
})

describe('the chunk list', () => {
  it('names each chunk once', () => {
    // Hand-maintained and long. A repeat is searched once and then counted twice: the pooled dedup
    // hides that for the lines, since they carry the same ids, and cannot for the hotspot cells,
    // which are summed.
    const seen = new Set<string>()
    const twice = DEFAULT_CHUNKS.filter((c) => seen.size === seen.add(c).size)
    expect(twice).toEqual([])
  })

  it('parses every name it lists', () => {
    for (const c of DEFAULT_CHUNKS) expect(() => parseChunk(c)).not.toThrow()
  })
})
