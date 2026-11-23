import cdt2d from 'cdt2d'
import type { Pos } from '../shared/grid.js'
import { COVER, COVER_RGB, type MeshData } from './terrainMesh.js'

/**
 * Buildings for the 3D view, as solids with walls fitted to the survey rather than cut out of it.
 *
 * Drawn as part of the terrain grid a building is a stack of one-metre cells: every wall not lined
 * up with the grid comes out as a staircase, and every wall is a ramp one vertex wide, because a
 * height grid cannot hold a vertical face. Neither is in the data. What the data says is which
 * cells are building and how high each one stands, and both survive here unchanged: the roof is
 * triangulated through the centre of every measured cell, antenna and loggia included. Only the
 * outline is fitted -- straight walls at whatever angle the staircase of cells follows, each placed
 * by least squares through the cell corners it replaces, so it runs through the middle of the steps
 * rather than along either side of them.
 *
 * For the picture only. Anchors, clearance and the profile still read the cells themselves.
 */

/** The cells over a square: `ci0`, `cj0` is the south-west one, rows run north. */
export interface BuildingCells {
  ci0: number
  cj0: number
  w: number
  h: number
  /** The standing surface where a building is, NaN where none is. */
  roof: Float32Array
  /** Bare earth, for the foot of each wall. */
  ground: Float32Array
}

/** The colour of a building's section where the edge of the model cuts through it. */
export const CUT_RGB: [number, number, number] = [0.72, 0.34, 0.3]

type Pt = [number, number]

/** How far a fitted wall may stray from the cell edges it stands for. */
const FIT_TOLERANCE = 0.75
/** Below this angle two neighbouring walls are one wall, and their corner stays where it was. */
const MIN_CORNER = Math.sin((15 * Math.PI) / 180)
/**
 * Whether a wall runs through the cell centred at `p`. Such a cell's surface reading is part roof,
 * part street or facade -- a blend that measures neither, and along a turned wall a staircase of
 * them is what makes the roof's edge come out stepped. The roof is drawn from the cells the wall
 * leaves whole, and the wall's top from the nearest of those.
 */
const straddles = (p: Pt, [a, b]: [Pt, Pt]) => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const reach = len ? (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / (2 * len) : 0.5
  return distanceToSegment(p, a, b) < reach - 0.01
}

/**
 * The boundary of the cells `inside` names, as closed loops of cell corners.
 *
 * Inside is on the left of every loop, so an outline runs anticlockwise and a courtyard clockwise.
 * Two cells touching only at a corner are two buildings: at such a corner the walk turns left,
 * which keeps to the cell it came along.
 */
export function traceLoops(inside: (c: number, j: number) => boolean, w: number, h: number): Pt[][] {
  const key = (x: number, y: number) => y * (w + 1) + x
  const from: number[] = []
  const to: number[] = []
  const leaving = new Map<number, number[]>()
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const id = from.length
    from.push(key(x0, y0))
    to.push(key(x1, y1))
    const list = leaving.get(from[id]!)
    if (list) list.push(id)
    else leaving.set(from[id]!, [id])
  }
  const at = (c: number, j: number) => c >= 0 && j >= 0 && c < w && j < h && inside(c, j)
  for (let j = 0; j < h; j++) {
    for (let c = 0; c < w; c++) {
      if (!inside(c, j)) continue
      if (!at(c, j - 1)) edge(c, j, c + 1, j)
      if (!at(c + 1, j)) edge(c + 1, j, c + 1, j + 1)
      if (!at(c, j + 1)) edge(c + 1, j + 1, c, j + 1)
      if (!at(c - 1, j)) edge(c, j + 1, c, j)
    }
  }
  const xy = (k: number): Pt => [k % (w + 1), Math.floor(k / (w + 1))]
  const used = new Uint8Array(from.length)
  const loops: Pt[][] = []
  for (let start = 0; start < from.length; start++) {
    if (used[start]) continue
    const loop: Pt[] = []
    let e = start
    while (!used[e]) {
      used[e] = 1
      loop.push(xy(from[e]!))
      const [ax, ay] = xy(from[e]!)
      const [bx, by] = xy(to[e]!)
      const options = (leaving.get(to[e]!) ?? []).filter((n) => !used[n])
      if (!options.length) break
      // Most to the left first: the cross product of the way in and the way out.
      const turn = (n: number) => {
        const [cx, cy] = xy(to[n]!)
        return (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
      }
      e = options.reduce((best, n) => (turn(n) > turn(best) ? n : best))
    }
    loops.push(loop)
  }
  return loops
}

const area = (loop: Pt[]) => {
  let a = 0
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i]!
    const [x1, y1] = loop[(i + 1) % loop.length]!
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

function contains(loop: Pt[], [x, y]: Pt): boolean {
  let inside = false
  for (let i = 0, k = loop.length - 1; i < loop.length; k = i++) {
    const [xi, yi] = loop[i]!
    const [xk, yk] = loop[k]!
    if (yi > y !== yk > y && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) inside = !inside
  }
  return inside
}

function distanceToSegment([x, y]: Pt, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0
  return Math.hypot(x - ax - t * dx, y - ay - t * dy)
}

/** The corners Douglas-Peucker keeps of a closed loop, as indices into it, in order. */
function corners(loop: Pt[]): number[] {
  const n = loop.length
  if (n <= 4) return loop.map((_, i) => i)
  const keep = new Uint8Array(n)
  const split = (a: number, b: number) => {
    let worst = -1
    let far = FIT_TOLERANCE
    for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) {
      const d = distanceToSegment(loop[i]!, loop[a]!, loop[b]!)
      if (d > far) {
        far = d
        worst = i
      }
    }
    if (worst < 0) return
    keep[worst] = 1
    split(a, worst)
    split(worst, b)
  }
  let opposite = 0
  for (let i = 1, best = -1; i < n; i++) {
    const d = Math.hypot(loop[i]![0] - loop[0]![0], loop[i]![1] - loop[0]![1])
    if (d > best) {
      best = d
      opposite = i
    }
  }
  keep[0] = keep[opposite] = 1
  split(0, opposite)
  split(opposite, 0)
  return [...keep.keys()].filter((i) => keep[i])
}

interface Line {
  at: Pt
  dir: Pt
}

/** The line through some points, by least squares -- exact on the edge of the square. */
function fit(points: Pt[], w: number, h: number): Line {
  for (const [axis, value] of [[0, 0], [0, w], [1, 0], [1, h]] as const) {
    if (points.every((p) => p[axis] === value)) {
      return { at: points[0]!, dir: axis === 0 ? [0, 1] : [1, 0] }
    }
  }
  const mx = points.reduce((s, p) => s + p[0], 0) / points.length
  const my = points.reduce((s, p) => s + p[1], 0) / points.length
  let xx = 0
  let xy = 0
  let yy = 0
  for (const [x, y] of points) {
    xx += (x - mx) ** 2
    xy += (x - mx) * (y - my)
    yy += (y - my) ** 2
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2
  return { at: [mx, my], dir: [Math.cos(angle), Math.sin(angle)] }
}

/**
 * A traced loop as straight walls: Douglas-Peucker finds where the corners are, and each wall
 * between two of them is the least-squares line through every cell edge it replaces. The
 * building's corner is where two neighbouring walls meet -- or, where they are nearly in line
 * or would meet far off, the point Douglas-Peucker chose.
 *
 * Read through the middle of each cell edge rather than its ends: a staircase's corners stray up
 * to 1.4 m from the wall it stands for, its edge midpoints half a metre, so a turned wall comes out
 * as one while a notch a metre deep still stands out of it.
 */
function fitLoop(traced: Pt[], w: number, h: number): { fitted: Pt[]; plain: Pt[] } {
  // A shed of a few cells has nothing to fit, and its edge midpoints would cut its corners off.
  if (traced.length < 12) return { fitted: traced, plain: traced }
  const loop = traced.map(([x0, y0], i): Pt => {
    const [x1, y1] = traced[(i + 1) % traced.length]!
    return [(x0 + x1) / 2, (y0 + y1) / 2]
  })
  const kept = corners(loop)
  if (kept.length < 3) return { fitted: traced, plain: traced }
  const lines = kept.map((a, s) => {
    const b = kept[(s + 1) % kept.length]!
    const run: Pt[] = []
    for (let i = a; ; i = (i + 1) % loop.length) {
      run.push(loop[i]!)
      if (i === b) break
    }
    // Without its ends where there is more: Douglas-Peucker keeps the midpoint either side of a
    // corner, and one of them belongs to the next wall.
    return fit(run.length > 4 ? run.slice(1, -1) : run, w, h)
  })
  const plain = kept.map((index) => loop[index]!)
  const fitted = kept.map((index, s) => {
    const p = lines[(s - 1 + lines.length) % lines.length]!
    const q = lines[s]!
    const cross = p.dir[0] * q.dir[1] - p.dir[1] * q.dir[0]
    const corner = loop[index]!
    if (Math.abs(cross) < MIN_CORNER) return corner
    const t = ((q.at[0] - p.at[0]) * q.dir[1] - (q.at[1] - p.at[1]) * q.dir[0]) / cross
    const meet: Pt = [p.at[0] + t * p.dir[0], p.at[1] + t * p.dir[1]]
    return Math.hypot(meet[0] - corner[0], meet[1] - corner[1]) > 2 * FIT_TOLERANCE ? corner : meet
  })
  return { fitted, plain }
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const side = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
}

/**
 * Fitted loops with no two walls crossing, which the triangulation cannot be given. Two corners
 * close together can each be met on the far side of the other; the walls of such a crossing go
 * back to the points Douglas-Peucker chose, and only those. Null where that does not untangle them.
 */
function untangle(fitted: Pt[][], plain: Pt[][]): Pt[][] | null {
  const loops = fitted.map((l) => [...l])
  for (let round = 0; round < 4; round++) {
    const walls = loops.flatMap((l, li) => l.map((_, i) => ({ li, i, k: (i + 1) % l.length })))
    const end = (wall: { li: number; i: number }) => loops[wall.li]![wall.i]!
    const crossed = new Set<{ li: number; i: number; k: number }>()
    for (let x = 0; x < walls.length; x++) {
      for (let y = x + 1; y < walls.length; y++) {
        const [p, q] = [walls[x]!, walls[y]!]
        if (segmentsCross(end(p), loops[p.li]![p.k]!, end(q), loops[q.li]![q.k]!)) crossed.add(p).add(q)
      }
    }
    if (!crossed.size) return loops
    for (const { li, i, k } of crossed) {
      loops[li]![i] = plain[li]![i]!
      loops[li]![k] = plain[li]![k]!
    }
  }
  return null
}

/** One building: its outline and courtyards, traced, and the same fitted. */
export interface Footprint {
  traced: Pt[][]
  fitted: Pt[][]
}

/** Every building in the square, the outline first in each, in cell-corner coordinates. */
export function footprints(cells: BuildingCells): Footprint[] {
  const { w, h, roof } = cells
  const loops = traceLoops((c, j) => !Number.isNaN(roof[j * w + c]!), w, h)
  const outers = loops.filter((l) => area(l) > 0)
  const groups = outers.map((outer) => [outer])
  for (const hole of loops.filter((l) => area(l) < 0)) {
    // Just left of its first wall is building, which is inside the outline it belongs to.
    const [ax, ay] = hole[0]!
    const [bx, by] = hole[1]!
    const probe: Pt = [(ax + bx) / 2 - (by - ay) * 0.25, (ay + by) / 2 + (bx - ax) * 0.25]
    const owner = groups
      .filter((g) => contains(g[0]!, probe))
      .sort((p, q) => area(p[0]!) - area(q[0]!))[0]
    owner?.push(hole)
  }
  return groups.map((traced) => {
    const fits = traced.map((l) => fitLoop(l, w, h))
    const fitted = untangle(fits.map((f) => f.fitted), fits.map((f) => f.plain))
    return { traced, fitted: fitted ?? traced }
  })
}

/**
 * The buildings of a square as one mesh: roofs through every measured cell, walls fitted to the
 * outline and dropped to bare earth, and a wall in the cut colour where the square's edge runs
 * through a building, because that one is not a facade but where the model stops.
 */
export function buildingMesh(cells: BuildingCells, centre: Pos, datum: number): MeshData {
  const { ci0, cj0, w, h, roof, ground } = cells
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const grey = COVER_RGB[COVER.building]

  const vertex = ([x, y]: Pt, height: number, rgb: readonly number[]) => {
    positions.push(ci0 + x - centre.e, height - datum, -(cj0 + y - centre.n))
    colors.push(rgb[0]!, rgb[1]!, rgb[2]!)
    return positions.length / 3 - 1
  }
  /** Pushes a triangle wound so its face points along `out`. */
  const triangle = (a: number, b: number, c: number, out: [number, number, number]) => {
    const p = (i: number, k: number) => positions[i * 3 + k]!
    const u = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)]
    const v = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)]
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]
    indices.push(...(n[0]! * out[0] + n[1]! * out[1] + n[2]! * out[2] >= 0 ? [a, b, c] : [a, c, b]))
  }
  const cell = (x: number, y: number) =>
    Math.min(h - 1, Math.max(0, Math.floor(y))) * w + Math.min(w - 1, Math.max(0, Math.floor(x)))
  /** The roof at a wall's corner: the nearest building cell's `whole` says may carry it. */
  const roofNear = ([x, y]: Pt, whole: (c: number, j: number) => boolean = () => true): number => {
    let best = NaN
    let far = Infinity
    for (let j = Math.floor(y) - 3; j <= Math.floor(y) + 2; j++) {
      for (let c = Math.floor(x) - 3; c <= Math.floor(x) + 2; c++) {
        if (c < 0 || j < 0 || c >= w || j >= h || Number.isNaN(roof[j * w + c]!) || !whole(c, j)) continue
        const d = Math.hypot(c + 0.5 - x, j + 0.5 - y)
        if (d < far) {
          far = d
          best = roof[j * w + c]!
        }
      }
    }
    return best
  }
  const onEdge = (a: Pt, b: Pt) =>
    (a[0] === 0 && b[0] === 0) || (a[0] === w && b[0] === w) || (a[1] === 0 && b[1] === 0) || (a[1] === h && b[1] === h)

  /**
   * The roof over one building, in two parts. Wherever four neighbouring cell centres are all clear
   * of the walls, the quad between them is drawn exactly as the terrain grid draws it, split along
   * the same diagonal: every height, slope and step the cells measured is where it was. Only the
   * band between the outermost whole cells and the fitted walls is new, and it is triangulated with
   * both as constraints. Gives the height of the wall's top at a corner, or null where the
   * triangulation refuses the outline, which then gets another try as traced.
   */
  const roofOver = (loops: Pt[][], within: Pt[]): ((p: Pt) => number) | null => {
    const walls = loops.flatMap((l) => l.map((p, i): [Pt, Pt] => [p, l[(i + 1) % l.length]!]))
    const xs = within.map((p) => p[0])
    const ys = within.map((p) => p[1])
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)]
    const [bw, bh] = [Math.max(...xs) - x0, Math.max(...ys) - y0]

    /** Cells a wall runs through, and their neighbours: only these need testing against walls. */
    const near = new Uint8Array(bw * bh)
    for (const [a, b] of walls) {
      const steps = Math.ceil(4 * Math.hypot(b[0] - a[0], b[1] - a[1]))
      for (let k = 0; k <= steps; k++) {
        const c = Math.floor(a[0] + ((b[0] - a[0]) * k) / steps) - x0
        const j = Math.floor(a[1] + ((b[1] - a[1]) * k) / steps) - y0
        for (let dj = -1; dj <= 1; dj++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (c + dc >= 0 && j + dj >= 0 && c + dc < bw && j + dj < bh) near[(j + dj) * bw + c + dc] = 1
          }
        }
      }
    }
    const usable = new Uint8Array(bw * bh)
    for (let j = 0; j < bh; j++) {
      for (let c = 0; c < bw; c++) {
        if (Number.isNaN(roof[(y0 + j) * w + x0 + c]!)) continue
        const centreOf: Pt = [x0 + c + 0.5, y0 + j + 0.5]
        if (!contains(loops[0]!, centreOf) || loops.slice(1).some((l) => contains(l, centreOf))) continue
        if (near[j * bw + c] && walls.some((wall) => straddles(centreOf, wall))) continue
        usable[j * bw + c] = 1
      }
    }
    const isUsable = (c: number, j: number) => c >= 0 && j >= 0 && c < bw && j < bh && usable[j * bw + c] === 1
    /** Quad (c, j) spans the centres of cells (c, j) to (c + 1, j + 1). */
    const quad = new Uint8Array(bw * bh)
    for (let j = 0; j + 1 < bh; j++) {
      for (let c = 0; c + 1 < bw; c++) {
        if (!(isUsable(c, j) && isUsable(c + 1, j) && isUsable(c, j + 1) && isUsable(c + 1, j + 1))) continue
        if (!(near[j * bw + c] || near[j * bw + c + 1] || near[(j + 1) * bw + c] || near[(j + 1) * bw + c + 1])) {
          quad[j * bw + c] = 1
          continue
        }
        const [l, r, s, n] = [x0 + c + 0.5, x0 + c + 1.5, y0 + j + 0.5, y0 + j + 1.5]
        const sides: [Pt, Pt][] = [[[l, s], [r, s]], [[r, s], [r, n]], [[r, n], [l, n]], [[l, n], [l, s]]]
        const cut = walls.some(
          ([a, b]) =>
            Math.max(a[0], b[0]) >= l && Math.min(a[0], b[0]) <= r && Math.max(a[1], b[1]) >= s && Math.min(a[1], b[1]) <= n &&
            ((a[0] >= l && a[0] <= r && a[1] >= s && a[1] <= n) || sides.some(([p, q]) => segmentsCross(a, b, p, q))),
        )
        if (!cut) quad[j * bw + c] = 1
      }
    }

    const vertexAt = new Map<number, number>()
    const centre = (c: number, j: number) => {
      const k = j * bw + c
      let id = vertexAt.get(k)
      if (id === undefined) {
        id = vertex([x0 + c + 0.5, y0 + j + 0.5], roof[(y0 + j) * w + x0 + c]!, grey)
        vertexAt.set(k, id)
      }
      return id
    }

    const points: Pt[] = []
    const ids: number[] = []
    const pointAt = new Map<string, number>()
    const point = (p: Pt, id: () => number) => {
      const k = `${p[0]},${p[1]}`
      const had = pointAt.get(k)
      if (had !== undefined) return had
      pointAt.set(k, points.length)
      points.push(p)
      ids.push(id())
      return points.length - 1
    }
    const edges: [number, number][] = []
    const constrain = (loop: Pt[], id: (p: Pt) => () => number) => {
      const at = loop.map((p) => point(p, id(p)))
      at.forEach((a, i) => edges.push([a, at[(i + 1) % at.length]!]))
    }
    // A building too narrow to have a whole cell near the corner keeps the blend it has.
    const top = (p: Pt) => {
      const whole = roofNear(p, (c, j) => isUsable(c - x0, j - y0))
      return Number.isNaN(whole) ? roofNear(p) : whole
    }
    for (const loop of loops) {
      if (loop.some((p) => Number.isNaN(top(p)))) return null
      constrain(loop, (p) => () => vertex(p, top(p), grey))
    }
    const quadCorner = ([x, y]: Pt): Pt => [x0 + x + 0.5, y0 + y + 0.5]
    for (const loop of traceLoops((c, j) => quad[j * bw + c] === 1, bw, bh)) {
      constrain(loop.map(quadCorner), ([x, y]) => () => centre(x - x0 - 0.5, y - y0 - 0.5))
    }
    // Centres no quad reaches: between walls closer than two cells, or in a notch.
    for (let j = 0; j < bh; j++) {
      for (let c = 0; c < bw; c++) {
        if (!isUsable(c, j)) continue
        const touched = quad[j * bw + c] || (c > 0 && quad[j * bw + c - 1]) || (j > 0 && quad[(j - 1) * bw + c]) ||
          (c > 0 && j > 0 && quad[(j - 1) * bw + c - 1])
        if (!touched) point([x0 + c + 0.5, y0 + j + 0.5], () => centre(c, j))
      }
    }

    let faces: [number, number, number][]
    try {
      faces = cdt2d(points, edges, { exterior: false })
    } catch {
      return null
    }
    for (const [a, b, c] of faces) triangle(ids[a]!, ids[b]!, ids[c]!, [0, 1, 0])
    for (let j = 0; j + 1 < bh; j++) {
      for (let c = 0; c + 1 < bw; c++) {
        if (!quad[j * bw + c]) continue
        const [sw, se, nw, ne] = [centre(c, j), centre(c + 1, j), centre(c, j + 1), centre(c + 1, j + 1)]
        triangle(sw, se, nw, [0, 1, 0])
        triangle(se, ne, nw, [0, 1, 0])
      }
    }
    return top
  }

  for (const footprint of footprints(cells)) {
    const { traced } = footprint
    let top: ((p: Pt) => number) | null = null
    const fitted = [footprint.fitted, traced].find(
      (loops, k) => (k === 0 || footprint.fitted !== traced) && (top = roofOver(loops, traced[0]!)),
    )
    if (!fitted || !top) continue
    const topAt: (p: Pt) => number = top

    for (const loop of fitted) {
      loop.forEach((a, i) => {
        const b = loop[(i + 1) % loop.length]!
        const rgb = onEdge(a, b) ? CUT_RGB : grey
        const [ta, tb] = [topAt(a), topAt(b)]
        const [fa, fb] = [ground[cell(a[0], a[1])]!, ground[cell(b[0], b[1])]!]
        if (Number.isNaN(ta + tb + fa + fb)) return
        const ids = [vertex(a, ta, rgb), vertex(b, tb, rgb), vertex(a, fa, rgb), vertex(b, fb, rgb)]
        // Inside is on the left of the walk, so outwards is to its right: (dy, -dx) on the map,
        // which is (dy, 0, dx) in the scene, whose z runs south.
        const out: [number, number, number] = [b[1] - a[1], 0, b[0] - a[0]]
        triangle(ids[0]!, ids[2]!, ids[1]!, out)
        triangle(ids[1]!, ids[2]!, ids[3]!, out)
      })
    }
  }
  return {
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
  }
}
