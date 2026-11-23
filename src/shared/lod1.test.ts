import { describe, expect, it } from 'vitest'
import { growRoofs, levelFaces, rasteriseFaces } from './lod1.js'
import { Grid } from './grid.js'

/** A ring as CityGML writes it: x y z triples, closed, on one line. */
const posList = (pts: [number, number, number][]) =>
  `<gml:posList srsDimension="3">${pts.map((p) => p.join(' ')).join(' ')}</gml:posList>`

const square = (e0: number, n0: number, side: number, z: number) =>
  posList([
    [e0, n0, z],
    [e0 + side, n0, z],
    [e0 + side, n0 + side, z],
    [e0, n0 + side, z],
    [e0, n0, z],
  ])

describe('levelFaces', () => {
  it('takes the level rings and leaves the walls', () => {
    const wall = posList([
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 9],
      [0, 0, 9],
      [0, 0, 0],
    ])
    const faces = levelFaces(`${square(0, 0, 4, 0)}${wall}${square(0, 0, 4, 9)}`)
    expect(faces.map((f) => f.z)).toEqual([0, 9])
    expect(faces[1]!.ring).toEqual([0, 0, 4, 0, 4, 4, 0, 4, 0, 0])
  })

  it('ignores anything too small or malformed to be a ring', () => {
    expect(levelFaces(posList([[0, 0, 5]]))).toEqual([])
    expect(levelFaces('<gml:posList>1 2 3 4</gml:posList>')).toEqual([])
  })
})

describe('rasteriseFaces', () => {
  const grid = () => Grid.filled(10, 10, 0, 10, 1)

  it('fills the cells whose centres the outline covers, and nothing else', () => {
    const g = grid()
    const cells = rasteriseFaces(levelFaces(square(2, 2, 4, 7)), g)
    expect(cells).toBe(16)
    // e in (2, 6) is columns 2..5; n in (2, 6) is rows 4..7.
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        const inside = col >= 2 && col <= 5 && row >= 4 && row <= 7
        expect([row, col, g.at(col, row)]).toEqual([row, col, inside ? 7 : NaN])
      }
    }
  })

  it('keeps the taller of two overlapping buildings', () => {
    const g = grid()
    rasteriseFaces(levelFaces(`${square(2, 2, 4, 12)}${square(3, 3, 4, 5)}`), g)
    expect(g.at(3, 5)).toBe(12)
    // The shorter one still covers ground the taller one does not.
    expect(g.at(6, 4)).toBe(5)
  })

  it('drops a building narrower than a cell rather than widening it', () => {
    const g = grid()
    // 0.2 m across, between two scanline centres in both axes.
    expect(rasteriseFaces(levelFaces(square(2.9, 2.9, 0.2, 9)), g)).toBe(0)
  })
})

describe('growRoofs', () => {
  it('follows a building down to the street and stops where a tree climbs again', () => {
    // One row over flat ground at 100: open ground, a loggia and a wall cell stepping down from the
    // footprint at 2-3, then the eaves on the other side and a tree rising past them.
    const row = (values: number[]) => {
      const g = Grid.filled(values.length, 1, 0, 1, 1)
      g.data.set(values)
      return g
    }
    const roof = row([NaN, NaN, NaN, 20, 20, NaN, NaN, NaN])
    const surface = row([101, 110, 120.5, 122, 122, 121, 124, 115])
    const grown = growRoofs(roof, surface, row(Array(8).fill(100)))
    expect([...roof.data]).toEqual([NaN, 20, 20, 20, 20, 20, NaN, NaN])
    expect(grown).toBe(3)
  })
})
