import { toUtm33 } from '../shared/geo.js'
import { regionId } from './regionCache.js'
import type { Aoi } from '../shared/types.js'

/**
 * Turns a list of areas of interest into the areas actually rasterised.
 *
 * Two problems come with allowing more than one AOI, and merging solves both. Overlapping AOIs
 * would scan their shared ground twice and report the same line twice -- the global dedup pass
 * catches that, but only after paying for it. Worse, two AOIs that merely touch would each miss
 * every line crossing the seam, because neither grid holds both anchors.
 *
 * So any two AOIs whose boxes come within `reach` of each other are rasterised together as one
 * grid. `reach` is the longest line the search will consider: closer than that and a line could
 * span the gap, further and no line could, so the split is exact rather than a heuristic. The union
 * box is bounded -- two AOIs plus `reach` -- so this cannot quietly balloon into a regional raster.
 *
 * Anchors are still confined to `boxes`, the individual AOIs. The ground between two merged AOIs is
 * read but not searched, which is what "the AOI is where we look" should mean.
 */

export interface Box {
  minE: number
  minN: number
  maxE: number
  maxN: number
}

export interface WorkArea {
  /**
   * What this area is called, in the cache and in the run log.
   *
   * An area of interest is identified by the ground it covers, since that is all there is to it and
   * two runs listing the same rectangles mean the same area. A chunk is identified by its place on
   * the lattice, which does not move when the halo does.
   */
  id: string
  /** Which mechanism produced this area, which is also what a run's selection can name. */
  kind: 'aoi' | 'chunk'
  aois: Aoi[]
  /** One box per AOI: where anchors may sit. */
  boxes: Box[]
  /** The union, plus nothing: what gets rasterised. */
  bbox: Box
  /**
   * The ground whose *pairs* this area is responsible for, when that is narrower than the ground it
   * may anchor in.
   *
   * Absent here, and set once the run is cut into fixed chunks rather than into areas of interest:
   * a chunk keeps anchors for a kilometre beyond its own edges so a partner across the seam exists
   * to be found, and then claims only the pairs whose first anchor is its own. See PairSearchRange
   * for why that divides every pair exactly once.
   */
  owns?: Box
}

/**
 * Which areas a run was told to recompute.
 *
 * Null is the ordinary case and means none: a region that has been computed stays computed, and
 * only one with no cache at all is searched. Rectangles select by touching -- naming any part of an
 * area's ground picks the whole area, since a region is searched as one grid and cannot be rebuilt
 * in halves. `'all'` is the sledgehammer, for when the code has moved and the dataset should follow.
 */
export type Recompute = Aoi[] | 'all' | null

/** Whether two rectangles touch at all, which is how a named rectangle picks the areas it means. */
const overlaps = (a: Aoi, b: Aoi) =>
  a.west <= b.east && b.west <= a.east && a.south <= b.north && b.south <= a.north

export function recomputes(area: WorkArea, selection: Recompute): boolean {
  if (selection === 'all') return true
  if (!selection) return false
  return area.aois.some((a) => selection.some((s) => overlaps(a, s)))
}

export function boxOf(aoi: Aoi): Box {
  const corners = [
    toUtm33(aoi.south, aoi.west),
    toUtm33(aoi.south, aoi.east),
    toUtm33(aoi.north, aoi.west),
    toUtm33(aoi.north, aoi.east),
  ]
  return {
    minE: Math.min(...corners.map((c) => c[0])),
    maxE: Math.max(...corners.map((c) => c[0])),
    minN: Math.min(...corners.map((c) => c[1])),
    maxN: Math.max(...corners.map((c) => c[1])),
  }
}

export function contains(box: Box, e: number, n: number): boolean {
  return e >= box.minE && e <= box.maxE && n >= box.minN && n <= box.maxN
}

/**
 * The same test with the upper edges excluded, which is what dividing ground between boxes needs.
 *
 * `contains` is closed on all four sides, so two boxes that share an edge both claim it. That is
 * right for "is this anchor inside the area of interest" and wrong for "whose pair is this": a
 * point on the seam would be owned twice, and the line through it reported twice. Adjacent
 * half-open boxes tile the plane exactly once.
 */
export function owns(box: Box, e: number, n: number): boolean {
  return e >= box.minE && e < box.maxE && n >= box.minN && n < box.maxN
}

const union = (a: Box, b: Box): Box => ({
  minE: Math.min(a.minE, b.minE),
  minN: Math.min(a.minN, b.minN),
  maxE: Math.max(a.maxE, b.maxE),
  maxN: Math.max(a.maxN, b.maxN),
})

const within = (a: Box, b: Box, reach: number): boolean =>
  a.minE - reach <= b.maxE &&
  b.minE - reach <= a.maxE &&
  a.minN - reach <= b.maxN &&
  b.minN - reach <= a.maxN

export function workAreas(aois: Aoi[], reach: number): WorkArea[] {
  const areas: WorkArea[] = aois.map((aoi) => {
    const box = boxOf(aoi)
    return { id: regionId([aoi]), kind: 'aoi', aois: [aoi], boxes: [box], bbox: box }
  })

  // Merge until nothing more can merge: one merge can bring two previously distant areas together.
  for (let merged = true; merged; ) {
    merged = false
    outer: for (let i = 0; i < areas.length; i++) {
      for (let j = i + 1; j < areas.length; j++) {
        if (!within(areas[i]!.bbox, areas[j]!.bbox, reach)) continue
        const [a, b] = [areas[i]!, areas[j]!]
        areas.splice(j, 1)
        const joined = [...a.aois, ...b.aois]
        areas[i] = {
          id: regionId(joined),
          kind: 'aoi',
          aois: joined,
          boxes: [...a.boxes, ...b.boxes],
          bbox: union(a.bbox, b.bbox),
        }
        merged = true
        break outer
      }
    }
  }

  /**
   * Smallest first, so a run that is going to go wrong goes wrong early.
   *
   * Regions are independent, so the order is free -- and the order that costs nothing is the one
   * where a crash, a bad number or a performance regression shows up in the first thirty seconds
   * rather than after half an hour of the largest area. Region 2 alone is most of a run here; a
   * mistake that surfaces only there is a mistake found expensively.
   *
   * Ties break on the bounding box's south-west corner, so the order is stable across runs and two
   * areas of identical size cannot swap places between them.
   */
  return areas.sort((a, b) => {
    const size = (w: WorkArea) => (w.bbox.maxE - w.bbox.minE) * (w.bbox.maxN - w.bbox.minN)
    return size(a) - size(b) || a.bbox.minE - b.bbox.minE || a.bbox.minN - b.bbox.minN
  })
}
