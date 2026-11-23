import { describe, expect, it } from 'vitest'
import { CUT_RGB, buildingMesh, footprints, type BuildingCells } from './buildingMesh.js'

const SIDE = 40
const centre = { e: SIDE / 2, n: SIDE / 2 }

const square = (roofAt: (c: number, j: number) => number): BuildingCells => {
  const roof = new Float32Array(SIDE * SIDE)
  for (let j = 0; j < SIDE; j++) for (let c = 0; c < SIDE; c++) roof[j * SIDE + c] = roofAt(c, j)
  return { ci0: 0, cj0: 0, w: SIDE, h: SIDE, roof, ground: new Float32Array(SIDE * SIDE).fill(50) }
}

/** A 24 by 12 m block turned 30 degrees, as the grid sees it: a staircase on every side. */
const turned = (top: (c: number, j: number) => number) =>
  square((c, j) => {
    const [x, y] = [c + 0.5 - SIDE / 2, j + 0.5 - SIDE / 2]
    const [u, v] = [x * Math.cos(Math.PI / 6) + y * Math.sin(Math.PI / 6), -x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6)]
    return Math.abs(u) < 12 && Math.abs(v) < 6 ? top(c, j) : NaN
  })

/** Face normals of a mesh's triangles, with their centroids and first vertex's colour. */
const faces = ({ positions: p, colors, indices }: ReturnType<typeof buildingMesh>) => {
  const out = []
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!]
    const u = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!]
    const v = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!]
    out.push({
      normal: [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!],
      mid: [(p[a * 3]! + p[b * 3]! + p[c * 3]!) / 3, (p[a * 3 + 2]! + p[b * 3 + 2]! + p[c * 3 + 2]!) / 3],
      cut: colors[a * 3] === Math.fround(CUT_RGB[0]),
    })
  }
  return out
}

describe('buildingMesh', () => {
  it('fits a turned building with four straight walls, not a staircase', () => {
    const [only, ...rest] = footprints(turned(() => 60))
    expect(rest).toHaveLength(0)
    expect(only!.fitted).toHaveLength(1)
    expect(only!.fitted[0]).toHaveLength(4)
  })

  it('keeps every measured roof height, steps and slopes included, and covers the outline once', () => {
    const roofAt = (c: number, j: number) => 60 + (c % 3) + j * 0.1
    const cells = turned(roofAt)
    const mesh = buildingMesh(cells, centre, 0)
    const p = mesh.positions
    const at = new Map<string, number>()
    for (let v = 0; v < p.length / 3; v++) at.set(`${p[v * 3]! + SIDE / 2},${-p[v * 3 + 2]! + SIDE / 2}`, p[v * 3 + 1]!)
    const inner = (c: number, j: number) =>
      [-1, 0, 1].every((dj) => [-1, 0, 1].every((dc) => !Number.isNaN(cells.roof[(j + dj) * SIDE + c + dc]!)))
    let checked = 0
    for (let j = 1; j < SIDE - 1; j++) {
      for (let c = 1; c < SIDE - 1; c++) {
        if (!inner(c, j)) continue
        checked++
        expect(at.get(`${c + 0.5},${j + 0.5}`)).toBeCloseTo(roofAt(c, j), 4)
      }
    }
    expect(checked).toBeGreaterThan(150)

    // The roof's area seen from above is the fitted outline's: no gap in it, and nothing twice.
    const outline = footprints(cells)[0]!.fitted[0]!
    let fitted = 0
    outline.forEach(([x0, y0], i) => {
      const [x1, y1] = outline[(i + 1) % outline.length]!
      fitted += (x0 * y1 - x1 * y0) / 2
    })
    const seen = faces(mesh).reduce((sum, f) => sum + Math.abs(f.normal[1]!) / 2, 0)
    expect(seen).toBeCloseTo(fitted, 3)
    expect(faces(mesh).every((f) => f.normal[1]! >= 0)).toBe(true)
  })

  it('closes a building the edge of the square cuts through, in the cut colour, facing out', () => {
    const mesh = buildingMesh(square((c, j) => (c < 10 && j > 5 && j < 30 ? 62 : NaN)), centre, 0)
    const walls = faces(mesh).filter((f) => Math.abs(f.normal[1]!) < 1e-6 && Math.hypot(f.normal[0]!, f.normal[2]!) > 0)
    const cut = walls.filter((f) => f.cut)
    expect(cut).toHaveLength(2)
    // Out of the square is west, -x in the scene.
    for (const f of cut) expect(f.normal[0]!).toBeLessThan(0)
    // The other three are facades, each facing away from the building's middle.
    const middle = [5 - SIDE / 2, -(18 - SIDE / 2)]
    const facades = walls.filter((f) => !f.cut)
    expect(facades).toHaveLength(6)
    for (const f of facades) {
      expect(f.normal[0]! * (f.mid[0]! - middle[0]!) + f.normal[2]! * (f.mid[1]! - middle[1]!)).toBeGreaterThan(0)
    }
  })
})
