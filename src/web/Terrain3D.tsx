import { useEffect, useRef, useState } from 'react'
import type { Pos } from '../shared/grid.js'
import { toWgs84 } from '../shared/geo.js'
import { lineHeightAt, type Stretch } from '../shared/scoring.js'
import {
  bareGround, ensureTerrain, missingWindows, onBuilding, onRoof, onWindowActivity, standingCell, surfaceSampler,
} from './terrain.js'
import { ensureCover, onCoverChange, water } from './landcover.js'
import { useRemembered } from './remembered.js'
import { spread, stale, wantedHalfSide, type Ground } from './patch3d.js'
import {
  COVER, EMPTY_MESH, coverOf, drape, extentOf, fineSquaresAround, groundAround, latticeOf, meshOf, samplePatch, withFineGround, type CoverClass, type MeshData, standingHeight, type Patch, type Readers,
} from './terrainMesh.js'
import { buildingMesh, type BuildingCells } from './buildingMesh.js'
import { failureText, report } from './report.js'
import type { LatLon } from './planPoints.js'
import type { NoFall, Scene3D } from './scene3d.js'
import { drapeCells, type CellReader } from './cellSurface.js'
import { intervals, overlay, polyline } from './segments.js'
import { IMAGERY_SHORT } from './surveys.js'

/**
 * The site in three dimensions, for the full-screen view of one line.
 *
 * The profile chart answers "does it clear", which is the question that decides whether a line is
 * possible. It cannot answer "what is this place", and that is the question that decides whether
 * anyone drives out to it: which way the ground falls away, what stands beside the span, whether
 * the far anchor is on the shoulder of a hill or in the middle of a field. It is also the only view
 * in which an anchor can be put somewhere by looking at the ground it will stand on.
 *
 * Everything expensive here is on demand and only here. three.js is imported dynamically, so the
 * chunk carrying it is fetched by the first person to open this view and by nobody else; and the
 * elevation for a whole square around the line is fetched on the same click, which is many more
 * windows than any other part of the app asks for at once but is asked for once, deliberately, by
 * someone who has stopped to look at one line.
 */

/**
 * How finely the patch is read, and how much of it there is to read.
 *
 * The terrain model is a 1 m grid, so a metre a vertex is the whole of what the survey knows and
 * anything finer is interpolation dressed up as detail. Short lines get exactly that. Long ones hit
 * the cap instead -- a 500 m span wants a square 850 m across, and at a metre that is three quarters
 * of a million vertices to sample and light, which is a second of work and a mesh a phone would
 * rather not hold. 480 a side is a quarter of a million, and puts a 500 m line at 2 m: always a
 * whole number of metres, so the vertices stay on the survey's cells (see `latticeOf`).
 */
const MAX_SIDE = 480

/**
 * Vertices a side for the first pass, which exists to be quick rather than right.
 *
 * Reading the full square is a quarter of a million points through four samplers, which is most of
 * a second of arithmetic with nothing on screen. A coarse pass is a fiftieth of that: the hillside
 * is there in a frame or two, the fine one replaces it a moment later, and because both are
 * measured from the coarse pass's own floor the swap does not move anything.
 */
/** The circle a spot is judged on for being flat, open and at the right height. */
const REFERENCE_RADIUS = 5
/** And how far the pair actually reaches, which is the only ground they have to clear. */
const REFERENCE_FOOTPRINT = 4
/** How far from an anchor to look for somewhere to put them, clear of its stem. */
const REFERENCE_REACH = [9, 14, 20]
/*
 * What each fault in a spot is worth, in metres of relief, and the order matters more than the
 * numbers do.
 *
 * A roof outranks everything. A van on a roof is not a scale, it is a mistake -- and the height
 * term used to beat it outright: an anchor on a church tower made a rooftop at the same height cost
 * 60 while the street thirty metres below cost 75, so it parked on the roof every time. Real ground
 * has to win that argument even when it is a long way down.
 *
 * Which is why the height term is capped. It exists to keep the pair off the cliff face and out of
 * the gully *beside* the anchor; once they are a dozen metres below it they are simply somewhere
 * else, and the next twenty metres of drop say nothing further. Uncapped it grew without bound and
 * swamped every other consideration on exactly the tall lines where the others matter most.
 */
const WOOD_COSTS = 45
const ROOF_COSTS = 120
const OFF_LEVEL_COSTS = 2.5
const OFF_LEVEL_CAP = 12

const ROUGH_SIDE = 72

/**
 * How many times life size heights may be drawn at.
 *
 * Brandenburg is a plain with edges. A kilometre of it holds tens of metres of relief, so at 1:1
 * the quarry wall a line hangs off is a crease and the view says nothing the map did not -- and yet
 * 1:1 is the only setting that is not a lie, so it has to be one of the choices. Every height in
 * the scene is multiplied alike -- terrain, canopy, roofs, the span and its sag -- so what the eye
 * compares stays comparable at any of them, and the view says which one it is on.
 */
const FACTORS = [1, 2, 3, 5]

/**
 * Held here rather than in state, so it survives moving from one line to the next.
 *
 * The same reasoning as the details panel's width: it is how someone is reading the view, not a
 * property of the thing being read, and having it snap back for every line would make it useless.
 * Starts at life size, which is the only setting that is not a lie. Brandenburg is flat and the
 * view says so; anyone who wants the drop drawn taller can say so and it will stay said.
 */
let preferred = 1

/** Points along the drawn span. Enough that a 500 m curve reads as a curve. */
const SPAN_POINTS = 96

/**
 * Half the side of the exact ground drawn around each anchor, in whole metres.
 *
 * Wide enough that the seam with the coarse ground is well away from where anyone is looking when
 * an anchor is being placed, small enough to rebuild on every nudge.
 */
const PAD_HALF = 24


/**
 * The cover of one cell, for colouring the fine ground round the anchors as the rest of the ground is coloured: earth under
 * a building once the buildings are drawn on their own.
 */
const fineCover = (roofsApart: boolean) => (ci: number, cj: number): CoverClass =>
  !roofsApart && onBuilding(ci + 0.5, cj + 0.5)
    ? COVER.building
    : water.covers(ci + 0.5, cj + 0.5)
      ? COVER.water
      : COVER.ground

/** The whole cells inside the square the view shows, for `buildingMesh`. */
function buildingCellsOver(centre: Pos, halfSide: number): BuildingCells {
  const ci0 = Math.ceil(centre.e - halfSide)
  const cj0 = Math.ceil(centre.n - halfSide)
  const w = Math.floor(centre.e + halfSide) - ci0
  const h = Math.floor(centre.n + halfSide) - cj0
  const roof = new Float32Array(w * h)
  const ground = new Float32Array(w * h)
  for (let j = 0; j < h; j++) {
    for (let c = 0; c < w; c++) {
      const [e, n] = [ci0 + c + 0.5, cj0 + j + 0.5]
      roof[j * w + c] = onRoof(e, n) ? standingCell(ci0 + c, cj0 + j) : NaN
      ground[j * w + c] = bareGround(e, n)
    }
  }
  return { ci0, cj0, w, h, roof, ground }
}

/**
 * Where the line from p to q is inside the box [e0, e1] x [n0, n1], as a range of the way along it,
 * or null when it never is.
 */
function clip(p: Pos, q: Pos, e0: number, n0: number, e1: number, n1: number): [number, number] | null {
  let lo = 0
  let hi = 1
  for (const [from, to, min, max] of [[p.e, q.e, e0, e1], [p.n, q.n, n0, n1]] as const) {
    if (from === to) {
      if (from < min || from > max) return null
      continue
    }
    const [ta, tb] = [(min - from) / (to - from), (max - from) / (to - from)].sort((x, y) => x - y)
    lo = Math.max(lo, ta!)
    hi = Math.min(hi, tb!)
  }
  return lo < hi ? [lo, hi] : null
}

/** How far the shadows float over the surface they are laid on, in metres. */
const SHADOW_LIFT = 0.4

/** Another kept line, measured: drawn beside the one being worked on. */
export interface Companion {
  a: Pos
  b: Pos
  /** A line of the same spot, which the view is widened to take in; any other is drawn if it is in it. */
  widens: boolean
  anchorA: number
  anchorB: number
  sagRatio: number
  noFall: NoFall
}

/** What one press of a nudge arrow moves an anchor by, in metres. */
const STEPS = [0.1, 0.5, 1, 5]

export function Terrain3D({
  a, b, anchorA, anchorB, sagRatio, others, hoverAt, onMoveAnchor, onOtherTapped, noFall,
}: {
  a: Pos
  b: Pos
  anchorA: number
  anchorB: number
  sagRatio: number
  others: Companion[]
  onOtherTapped?: (index: number) => void
  /** Where along the span the profile chart's pointer is, in metres, or null when it has left. */
  hoverAt?: number | null
  /** Omit to make the view read-only; with it, a tapped anchor can be stepped or dragged. */
  onMoveAnchor?: (which: 'a' | 'b', at: LatLon) => void
  /** In metres from A, as the planner measures them. */
  noFall: Stretch[]
}) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<Scene3D | null>(null)
  // Read by the scene when an anchor is dropped or carried, which outlives the render that built it.
  const moveRef = useRef(onMoveAnchor)
  moveRef.current = onMoveAnchor
  const otherTappedRef = useRef(onOtherTapped)
  otherTappedRef.current = onOtherTapped
  const sagRef = useRef(sagRatio)
  sagRef.current = sagRatio
  const ground = useRef<Ground | null>(null)
  /** The heights as read, kept so a lake arriving later repaints them without reading them again. */
  const patch = useRef<Patch | null>(null)
  /** The buildings as solids of their own, where drawn so; the ground is then bare earth under them. */
  const roofs = useRef<MeshData | null>(null)
  /** Those solids for the fine pass, built on first use and kept until the ground is read again. */
  const fittedRoofs = useRef<MeshData | null>(null)
  const fineRead = useRef(false)
  /** The ground as the grid carries it, before the cells round the anchors are put into it. */
  const base = useRef<MeshData | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failed, setFailed] = useState<string | null>(null)
  const [measured, setMeasured] = useState(1)
  /** Windows still to arrive and how many there were, so the wait has a length. */
  const [fetching, setFetching] = useState<{ done: number; total: number } | null>(null)
  /** Whether the roads and water for the whole square are still on their way. */
  const [coverPending, setCoverPending] = useState(false)
  const [exaggeration, setExaggeration] = useState(preferred)
  /**
   * Whether the camera circles on its own, remembered between visits.
   *
   * A slow orbit is what makes a still picture of a hillside readable, and it is also the thing that
   * makes a view impossible to sit and look at. Which of those it is depends on the person, so it is
   * theirs to set -- and it is a choice about the workspace, so it is remembered rather than shared
   * in a link.
   */
  const [spin, setSpin] = useRemembered('highline-finder.spin3d', true)
  /** Buildings with fitted walls, or the raw cell grid they are fitted to. */
  const [fitWalls, setFitWalls] = useRemembered('highline-finder.fitwalls3d', true)
  const fitWallsRef = useRef(fitWalls)
  fitWallsRef.current = fitWalls
  const spinRef = useRef(spin)
  spinRef.current = spin
  useEffect(() => {
    scene.current?.setSpin(spin)
  }, [spin])
  /** Bumped when the ground under the view has to be read again. */
  const [epoch, setEpoch] = useState(0)
  /**
   * Whether this view has ever been on screen.
   *
   * The 3D view sits at the bottom of the full-screen panel, under the figures and both sets of
   * sliders, so on a phone it is usually two screens below the fold when the panel opens. The
   * terrain itself is read from windows the rest of the page already needed; the imagery is not --
   * it is a dozen requests to state servers for a picture nobody has looked at yet. So it waits.
   *
   * Sticky once true: the texture is already in hand by then, and scrolling back up must not throw
   * it away and fetch it again on the way down.
   */
  const [seen, setSeen] = useState(false)
  /** Whether the imagery landed, since the credit is owed only once its pixels are on screen. */
  const [textured, setTextured] = useState(false)

  /**
   * The anchor being placed by hand, and how far one press of an arrow moves it. Tapping an anchor
   * brings the camera to it and offers steps: exact, and as small as a decimetre.
   */
  const [picked, setPicked] = useState<'a' | 'b' | null>(null)
  useEffect(() => {
    if (!onMoveAnchor) setPicked(null)
  }, [!onMoveAnchor])
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const [step, setStep] = useState(0.5)
  useEffect(() => {
    scene.current?.focus(picked === null ? null : picked === 'a' ? 0 : 1)
  }, [picked, state])

  /** Moves the picked anchor `right` and `forward` steps, as the screen sees them. */
  const nudge = (right: number, forward: number) => {
    if (!picked || !scene.current || !onMoveAnchor) return
    const axes = scene.current.groundAxes()
    const x = (axes.right[0] * right + axes.forward[0] * forward) * step
    const z = (axes.right[1] * right + axes.forward[1] * forward) * step
    const from = picked === 'a' ? a : b
    onMoveAnchor(picked, toWgs84(from.e + x, from.n - z))
  }
  const nudgeRef = useRef(nudge)
  nudgeRef.current = nudge

  useEffect(() => {
    if (!picked) return
    const KEYS: Record<string, [number, number]> = {
      ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    }
    const onKey = (e: KeyboardEvent) => {
      // A focused slider owns its own arrow keys.
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Escape') {
        // Captured ahead of the full view's own Escape, which would otherwise leave the view too.
        e.stopImmediatePropagation()
        return setPicked(null)
      }
      const dir = KEYS[e.key]
      if (!dir) return
      e.preventDefault()
      nudgeRef.current(dir[0], dir[1])
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [picked])

  useEffect(() => {
    if (seen || !host.current) return
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true)
      },
      // A screen's warning, so the imagery is usually there by the time the view is scrolled to.
      { rootMargin: '400px' },
    )
    watch.observe(host.current)
    return () => watch.disconnect()
  }, [seen])

  /**
   * The aerial photograph over the ground, once there is ground and somebody looking at it.
   *
   * Keyed on the patch as well as on the view being seen, because a drag that runs an anchor out of
   * the square rebuilds the scene -- and a scene rebuilt without this would be the only part of the
   * view that silently lost its texture. Aborting on the way out matters for the same reason: the
   * answer is for a square that no longer exists.
   */
  useEffect(() => {
    if (!seen || state !== 'ready') return
    const g = ground.current
    if (!g) return
    setTextured(false)
    const stop = new AbortController()
    void (async () => {
      try {
        const { orthoPatch } = await import('./ortho.js')
        const image = await orthoPatch(g.centre, g.halfSide, stop.signal)
        if (stop.signal.aborted) return
        scene.current?.setOrtho(image)
        setTextured(!!image)
      } catch (e: unknown) {
        // Decoration. Every state server in the stack can be down without this view being wrong,
        // and a toast about a missing photograph would be noise over a picture that is complete.
        if (!stop.signal.aborted) console.warn('[highline] no imagery for the 3D view:', e)
      }
    })()
    return () => stop.abort()
  }, [seen, state, epoch])

  useEffect(() => {
    preferred = exaggeration
    scene.current?.setExaggeration(exaggeration)
  }, [exaggeration])

  /**
   * Re-centre the ground on the line whenever the line has outgrown it.
   *
   * An effect and not a decision taken while rendering, so it is re-asked after every commit: an
   * anchor dropped at the rim of the square cannot sit there being unlookable-at, because the pass
   * that notices runs again on the render that put it there. Recentring on the line's own midpoint
   * with a square sized to its length always leaves each end well inside the new edge, so this
   * settles in one step rather than chasing itself.
   */
  const otherEnds = others.filter((o) => o.widens).flatMap((o) => [o.a, o.b])
  const othersKey = otherEnds.map((p) => `${Math.round(p.e)},${Math.round(p.n)}`).join(';')
  useEffect(() => {
    if (!stale(ground.current, a, b, otherEnds)) return
    const { centre, reach } = spread([a, b, ...otherEnds])
    ground.current = {
      // On a cell centre, so the square's vertices are the survey's own: see `latticeOf`.
      centre: { e: Math.floor(centre.e) + 0.5, n: Math.floor(centre.n) + 0.5 },
      halfSide: wantedHalfSide(Math.hypot(b.e - a.e, b.n - a.n), reach),
      datum: 0,
    }
    setEpoch((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.e, a.n, b.e, b.n, othersKey])

  /** The span and its shadow, in the scene's coordinates. Cheap: a hundred samples. */
  /**
   * Where to stand the size references: the best patch of ground within reach of either anchor.
   *
   * Not a fixed offset from the anchor, which is how this started and which put them over the edge
   * as often as not -- an anchor is usually *on* the lip of something, and the ground a few metres
   * one way is a cliff face while a few metres the other way is a meadow. So a ring of candidate
   * spots around each end is scored and the best one wins.
   *
   * Three things make a spot good, and the weights say what they are worth against each other:
   * ground rather than a rooftop above all else, because a van on a roof is not a scale but a
   * mistake; then out of the trees, where nobody would see it; then level; then at about the
   * anchor's own height, which is what keeps them off the cliff face and out of the gully beside
   * it. See the weights above for why that last one is ranked where it is and capped where it is.
   *
   * Anything within a wide cone towards the far anchor is skipped, so they never stand under the
   * span. Decided once per ground patch and left alone while an anchor is nudged: the references are
   * a scale for the scene rather than a marker on the line, and having them hop about mid-drag would
   * be motion that means nothing. A drag far enough to matter rebuilds the patch anyway.
   */
  const referenceSpot = (patch: Patch, g: Ground) => {
    const local = (p: Pos) => ({ x: p.e - g.centre.e, z: -(p.n - g.centre.n) })
    const spots: { x: number; z: number; y: number; cost: number }[] = []
    for (const [at, away] of [[local(a), local(b)], [local(b), local(a)]] as const) {
      const here = groundAround(patch, at.x, at.z, 2)
      const toFar = Math.atan2(away.z - at.z, away.x - at.x)
      for (const radius of REFERENCE_REACH) {
        for (let step = 0; step < 12; step++) {
          const angle = (step / 12) * Math.PI * 2
          // A wide cone towards the other end, so nothing ever stands beneath the line.
          const off = Math.abs(((angle - toFar + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
          if (off < Math.PI / 3) continue
          const x = at.x + Math.cos(angle) * radius
          const z = at.z + Math.sin(angle) * radius
          const ground = groundAround(patch, x, z, REFERENCE_RADIUS)
          if (!Number.isFinite(ground.relief)) continue
          // Standing height over what they cover, not over the wider circle they were judged on.
          const stand = standingHeight(patch, x, z, REFERENCE_FOOTPRINT)
          if (Number.isNaN(stand)) continue
          const drop = Number.isFinite(here.top)
            ? Math.min(Math.abs(stand - here.top), OFF_LEVEL_CAP)
            : 0
          spots.push({
            x,
            z,
            y: stand - g.datum,
            cost:
              ground.relief +
              ground.canopy * WOOD_COSTS +
              ground.building * ROOF_COSTS +
              drop * OFF_LEVEL_COSTS,
          })
        }
      }
    }
    return spots.sort((p, q) => p.cost - q.cost)[0]
  }

  const spanOf = (g: Ground) => {
    const hang = (p: Pos, q: Pos, hp: number, hq: number, ratio: number) => {
      const sag = ratio * Math.hypot(q.e - p.e, q.n - p.n)
      const out = new Float32Array(SPAN_POINTS * 3)
      for (let i = 0; i < SPAN_POINTS; i++) {
        const t = i / (SPAN_POINTS - 1)
        out[i * 3] = p.e + (q.e - p.e) * t - g.centre.e
        out[i * 3 + 1] = lineHeightAt(hp, hq, sag, t) - g.datum
        out[i * 3 + 2] = -(p.n + (q.n - p.n) * t - g.centre.n)
      }
      return out
    }
    const sag = sagRatio * Math.hypot(b.e - a.e, b.n - a.n)
    const line = hang(a, b, anchorA, anchorB, sagRatio)
    const at = (p: Pos, h: number): [number, number, number] => [p.e - g.centre.e, h - g.datum, -(p.n - g.centre.n)]
    const inView = (p: Pos) => Math.max(Math.abs(p.e - g.centre.e), Math.abs(p.n - g.centre.n)) < g.halfSide
    const shown = others.flatMap((o, index) => (o.widens || (inView(o.a) && inView(o.b)) ? [{ ...o, index }] : []))
    const drawnOthers = shown.map((o) => ({
      index: o.index,
      line: hang(o.a, o.b, o.anchorA, o.anchorB, o.sagRatio),
      anchors: [at(o.a, o.anchorA), at(o.b, o.anchorB)] as [[number, number, number], [number, number, number]],
      noFall: o.noFall,
    }))
    // Round each anchor the ground is drawn cell by cell, as its height is measured, and the track
    // lies on it there. Where the buildings are drawn apart, the earth under them is drawn instead,
    // as it is everywhere else.
    const read = patch.current
    const squares = read ? fineSquaresAround(read, [a, b, ...shown.flatMap((o) => [o.a, o.b])], PAD_HALF) : []
    const apart = roofs.current !== null
    const drawn: CellReader = apart
      ? (i, j) => (onBuilding(i + 0.5, j + 0.5) ? bareGround(i + 0.5, j + 0.5) : standingCell(i, j))
      : standingCell
    const mesh = read && base.current
      ? withFineGround(read, base.current, squares, drawn, fineCover(apart), g.datum)
      : EMPTY_MESH

    // Two shadows, because the ground is drawn under the wood rather than replaced by it: one on
    // the solid ground and roofs, which is where the line runs, and one on the canopy sheet where
    // there is one and on the ground where there is not. Each lies on exactly what is drawn under
    // it -- the cells round the anchors, the coarse grid between them -- and is lifted just clear.
    const [x0, z0, x1, z1] = [line[0]!, line[2]!, line[line.length - 3]!, line[line.length - 1]!]
    const inFine = read ? squares.map((q) => clip(a, b, ...extentOf(read, q))) : []
    const solid = intervals(inFine.flatMap((r) => r ?? []), 0, 1).flatMap(([ta, tb]) => {
      const mid = (ta + tb) / 2
      return inFine.some((r) => r !== null && mid > r[0] && mid < r[1])
        ? drapeCells(standingCell, a.e, a.n, b.e, b.n, ta, tb)
        : read
          ? drape(read, 'solid', x0, z0, x1, z1, ta, tb)
          : []
    })
    const sheet = patch.current ? drape(patch.current, 'canopy', x0, z0, x1, z1) : []
    const point = (t: number, y: number): [number, number, number] => [
      x0 + (x1 - x0) * t,
      y + SHADOW_LIFT - g.datum,
      z0 + (z1 - z0) * t,
    ]
    const track = polyline(solid, point)
    const overTrack = polyline(overlay(solid, sheet), point)
    const anchors: [number, number, number][] = [
      [a.e - g.centre.e, anchorA - g.datum, -(a.n - g.centre.n)],
      [b.e - g.centre.e, anchorB - g.datum, -(b.n - g.centre.n)],
    ]
    const span = Math.hypot(b.e - a.e, b.n - a.n)
    const zones: NoFall = span > 0 ? noFall.map((z) => [z.from / span, z.to / span]) : []
    return {
      line, track, overTrack, anchors, mesh, others: drawnOthers, noFall: zones,
      lookAt: (anchorA + anchorB) / 2 - sag / 2 - g.datum,
    }
  }
  const spanRef = useRef(spanOf)
  spanRef.current = spanOf
  const redrape = (g: Ground) => {
    const { line, track, overTrack, anchors, mesh, others, noFall } = spanRef.current(g)
    scene.current?.setLine(line, track, overTrack, anchors, mesh, others, noFall)
  }

  // Building the ground: the expensive half, and the one that must not run while an anchor is being
  // nudged a few metres. Keyed on the epoch, which only `stale` above advances.
  useEffect(() => {
    if (!ground.current) return
    let dropped = false
    setState('loading')
    setFailed(null)

    const build = async () => {
      const g = ground.current
      // Nothing to read until the effect above has chosen a square, which it does on the first
      // commit. The epoch it bumps brings this back.
      if (!g) return
      const total = missingWindows(g.centre, g.centre, g.halfSide)
      setFetching(total ? { done: 0, total } : null)
      let done = 0
      const watching = onWindowActivity(({ state }) => {
        if (state === 'loading') return
        done++
        setFetching(done >= total ? null : { done, total })
      })
      // Elevation only. Land cover is asked for below and never waited on: a picture of the terrain
      // now is worth more than a picture with the lakes already in it later, and the lakes repaint
      // themselves when they land.
      try {
        await ensureTerrain(g.centre, g.centre, g.halfSide)
      } finally {
        watching()
        setFetching(null)
      }
      if (dropped) return

      const readers: Readers = {
        // Both readings nearest, and that matters more than it looks. Bare earth has no bilinear
        // reader, so pairing a bilinear surface with a nearest ground compares two different
        // samplings of the same field -- and where the field is a dam wall or a cliff, the two
        // differ by metres between neighbouring cells. That difference is what `classOf` reads as
        // vegetation, so a bare concrete face came out in canopy green. Read alike, ground with
        // nothing standing on it gives exactly zero.
        ground: bareGround,
        surface: (e, n) => surfaceSampler.nearest(e, n),
        building: onBuilding,
        water: (e, n) => water.covers(e, n),
      }
      const roughly = latticeOf(g.halfSide, ROUGH_SIDE)
      const rough = samplePatch(g.centre, roughly.halfSide, roughly.side, readers)
      setMeasured(rough.measured)
      patch.current = rough
      // The coarse pass sets the floor everything is measured from, and the fine one keeps it, so
      // replacing the ground does not lift or drop the span hanging over it.
      g.datum = rough.low
      roofs.current = null
      fittedRoofs.current = null
      fineRead.current = false
      base.current = meshOf(rough, g.datum)
      if (!base.current.indices.length) throw new Error('no elevation for the ground around this line')

      const { createScene } = await import('./scene3d.js')
      if (dropped || !host.current) return
      const canvas = document.createElement('canvas')
      host.current.replaceChildren(canvas)
      // Taken before the old scene goes, so a rebuild keeps the angle the viewer was looking from.
      const offset = scene.current?.viewOffset()
      scene.current?.dispose()
      scene.current = createScene(canvas, {
        canopy: meshOf(rough, g.datum, 'canopy'),
        ...spanRef.current(g),
        radius: g.halfSide,
        exaggeration: preferred,
        offset,
        spin: spinRef.current,
        props: referenceSpot(rough, g),
        movable: () => !!moveRef.current,
        onAnchorTapped: (which) => {
          const end = which === 0 ? 'a' : 'b'
          setPicked((cur) => (cur === end ? null : end))
        },
        onAnchorMoved: (which, x, z) => moveRef.current?.(which === 0 ? 'a' : 'b', toWgs84(g.centre.e + x, g.centre.n - z)),
        onElsewhereTapped: () => setPicked(null),
        onOtherTapped: (i) => otherTappedRef.current?.(i),
        sagRatio: () => sagRef.current,
      })
      setState('ready')

      /**
       * And now the same square read properly.
       *
       * After a turn of the event loop, so the coarse hillside actually paints before the main
       * thread disappears into a quarter of a million samples. One metre a vertex is the whole of
       * what the survey knows; the cap is what a phone can hold.
       */
      await new Promise((done) => setTimeout(done, 0))
      if (dropped) return
      const finely = latticeOf(g.halfSide, MAX_SIDE)
      const fine = samplePatch(g.centre, finely.halfSide, finely.side, readers)
      if (dropped) return
      patch.current = fine
      fineRead.current = true
      setMeasured(fine.measured)
      redraw.current()

      /**
       * And now the rest of the square's land cover, which the picture does not wait for.
       *
       * Usually the blocks are already held for the line and this returns at once. When they are not,
       * the ground is drawn brown, the lakes arrive when their block does, and only the colours
       * change.
       */
      const half = g.halfSide
      setCoverPending(true)
      ensureCover(
        { e: g.centre.e - half, n: g.centre.n - half },
        { e: g.centre.e + half, n: g.centre.n + half },
        0,
      )
        .catch((e: unknown) => report('fetching land cover for the 3D view', e))
        .finally(() => {
          if (dropped) return
          setCoverPending(false)
          // Once on our own account as well as on every announcement: this scene may have been
          // built after the cover it needs had already landed, and then nothing would announce.
          repaint.current()
        })
    }

    build().catch((e: unknown) => {
      report('building the 3D view of this line', e)
      if (dropped) return
      setFailed(failureText(e))
      setState('failed')
    })

    return () => {
      dropped = true
      scene.current?.dispose()
      scene.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch])

  /**
   * Repaint whenever land cover lands, whoever asked for it.
   *
   * Not in the build above, after this view's own request: the panel asks for the line's corridor
   * at the same time, and either request can be the one that delivers the lake. Subscribing means
   * the ground is repainted when the data exists rather than when this component's promise happens
   * to settle -- and it goes on working after an anchor is dropped somewhere new.
   */
  /**
   * Re-reads what is standing on the ground and rebuilds both surfaces from it.
   *
   * Both, because the classes decide more than a colour now: a cell that turns out to be a building
   * belongs to the solid mesh at its roof, and one that is canopy belongs to the sheet above. So
   * this is a rebuild rather than a repaint -- a few milliseconds of arithmetic over heights that
   * were already read, and no fetch.
   */
  const repaint = useRef(() => {
    const read = patch.current
    if (!read) return
    read.cover.set(
      coverOf(read, { building: onBuilding, water: (e, n) => water.covers(e, n) }),
    )
    redraw.current()
  })
  useEffect(() => onCoverChange(() => repaint.current()), [])

  /**
   * Puts the surfaces as read into the scene: the buildings fitted where they are wanted and the
   * fine pass is in, otherwise as the cell grid carries them.
   */
  const redraw = useRef(() => {
    const read = patch.current
    const g = ground.current
    if (!read || !scene.current || !g) return
    if (fitWallsRef.current && fineRead.current) {
      fittedRoofs.current ??= buildingMesh(buildingCellsOver(g.centre, g.halfSide), g.centre, g.datum)
      roofs.current = fittedRoofs.current
    } else {
      roofs.current = null
    }
    base.current = meshOf(read, g.datum, roofs.current ? 'earth' : 'solid')
    scene.current.setMesh(meshOf(read, g.datum, 'canopy'), roofs.current)
    redrape(g)
  })
  useEffect(() => redraw.current(), [fitWalls])

  /** The chart's pointer, as a fraction of the span, so the scene need not know about metres. */
  useEffect(() => {
    const length = Math.hypot(b.e - a.e, b.n - a.n)
    scene.current?.setHover(
      hoverAt === null || hoverAt === undefined || length <= 0 ? null : hoverAt / length,
    )
  }, [hoverAt, a.e, a.n, b.e, b.n, state])

  // Moving the span: the cheap half, and the one that runs on every step of an optimiser run.
  const lineKey = [a, b, ...others.flatMap((o) => [o.a, o.b])]
    .flatMap((p) => [p.e, p.n])
    .concat(
      [anchorA, anchorB, sagRatio],
      others.flatMap((o) => [o.anchorA, o.anchorB, o.sagRatio, ...o.noFall.flat()]),
      noFall.flatMap((z) => [z.from, z.to]),
    )
    .map((v) => Math.round(v * 100))
    .join('_')
  useEffect(() => {
    if (state !== 'ready' || !ground.current) return
    const { line, track, overTrack, anchors, mesh, others, noFall } = spanRef.current(ground.current)
    scene.current?.setLine(line, track, overTrack, anchors, mesh, others, noFall)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineKey, state])

  return (
    <div className="scene3d">
      <div className="canvas" ref={host} />
      {state === 'loading' && (
        <div className="scenenote">
          <i className="spinner" />
          <span>
            {fetching
              ? `fetching elevation — ${fetching.done} of ${fetching.total}…`
              : 'reading the ground around this line…'}
          </span>
        </div>
      )}
      {state === 'failed' && (
        <div className="scenenote" data-bad="true">
          <span>No 3D view &mdash; {failed}</span>
        </div>
      )}
      {textured && <span className="scenecredit">{IMAGERY_SHORT}</span>}
      {state === 'ready' && (
        <button
          className="spin3d"
          data-on={spin || undefined}
          onClick={() => setSpin(!spin)}
          title={spin ? 'Stop the camera circling' : 'Let the camera circle on its own'}
          aria-label={spin ? 'Stop the camera circling' : 'Let the camera circle on its own'}
        >
          &#x27f3;
        </button>
      )}
      {state === 'ready' && (
        <button
          className="spin3d walls3d"
          data-on={fitWalls || undefined}
          onClick={() => setFitWalls(!fitWalls)}
          title={fitWalls ? 'Show buildings as the raw 1 m height cells' : 'Show buildings with walls fitted to the cells'}
          aria-label={fitWalls ? 'Show buildings as the raw 1 m height cells' : 'Show buildings with walls fitted to the cells'}
        >
          &#x25b1;
        </button>
      )}
      {state === 'ready' && picked && onMoveAnchor && (
        <div className="nudge" role="group" aria-label={`Move anchor ${picked.toUpperCase()}`}>
          <div className="which">
            {(['a', 'b'] as const).map((end) => (
              <button
                key={end}
                data-active={end === picked}
                onClick={() => setPicked(end)}
                aria-label={`Move anchor ${end.toUpperCase()}`}
              >
                {end.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="pad">
            <button onClick={() => nudge(0, 1)} aria-label="Away from you" style={{ gridArea: 'up' }}>&#9650;</button>
            <button onClick={() => nudge(-1, 0)} aria-label="Left" style={{ gridArea: 'left' }}>&#9664;</button>
            <button onClick={() => nudge(1, 0)} aria-label="Right" style={{ gridArea: 'right' }}>&#9654;</button>
            <button onClick={() => nudge(0, -1)} aria-label="Towards you" style={{ gridArea: 'down' }}>&#9660;</button>
          </div>
          <div className="steps">
            {STEPS.map((m) => (
              <button key={m} data-active={m === step} onClick={() => setStep(m)}>
                {m < 1 ? `${m * 100} cm` : `${m} m`}
              </button>
            ))}
          </div>
          <button className="done" onClick={() => setPicked(null)}>done</button>
        </div>
      )}
      {state === 'ready' && (
        <div className="scenelegend">
          <span className="ref">for scale: a person, and a 7 m camper</span>
          <span className="heights">
            heights
            {FACTORS.map((k) => (
              <button
                key={k}
                data-active={k === exaggeration}
                onClick={() => setExaggeration(k)}
                title={
                  k === 1
                    ? 'True to life. Brandenburg is flat, and this is how flat.'
                    : `Every height ${k} times life size, the span and its sag included`
                }
              >
                &times;{k}
              </button>
            ))}
          </span>
          {coverPending && ' finding water and roads…'}
          {measured < 0.995 && ` ${Math.round((1 - measured) * 100)} % unsurveyed ·`}
          {onMoveAnchor
            ? ' tap an anchor to pick it, then drag it or step it · drag elsewhere to turn'
            : ' drag to turn'}
        </div>
      )}
    </div>
  )
}
