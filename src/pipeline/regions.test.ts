import { describe, expect, it } from 'vitest'
import { boxOf, contains, workAreas } from './regions.js'
import type { Aoi } from '../shared/types.js'

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
})
