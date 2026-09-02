import { useEffect, useRef, useState } from 'react'
import type { Pos } from '../shared/grid.js'
import { toWgs84 } from '../shared/geo.js'
import { lineHeightAt } from '../shared/scoring.js'
import {
  bareGround, ensureTerrain, missingWindows, onBuilding, onWindowActivity, surfaceSampler,
} from './terrain.js'
import { ensureCover, onCoverChange, water } from './landcover.js'
import {
  colorsOf, coverOf, meshOf, samplePatch, type Patch, type Readers,
} from './terrainMesh.js'
import { failureText, report } from './report.js'
import type { LatLon } from './planPoints.js'
import type { Scene3D } from './scene3d.js'

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
 * rather not hold. 480 a side is a quarter of a million, and puts a 500 m line at about 1.8 m.
 */
const STEP_M = 1
const MAX_SIDE = 480
const MIN_SIDE = 128

/**
 * Vertices a side for the first pass, which exists to be quick rather than right.
 *
 * Reading the full square is a quarter of a million points through four samplers, which is most of
 * a second of arithmetic with nothing on screen. A coarse pass is a fiftieth of that: the hillside
 * is there in a frame or two, the fine one replaces it a moment later, and because both are
 * measured from the coarse pass's own floor the swap does not move anything.
 */
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
 * Not persisted -- a working preference for the session.
 */
let preferred = 2

/** Points along the drawn span. Enough that a 500 m curve reads as a curve. */
const SPAN_POINTS = 96

/** The square of ground currently on screen, which outlives the line that chose it. */
export interface Ground {
  centre: Pos
  halfSide: number
  /** Height everything in the scene is measured from -- the floor of the patch. */
  datum: number
}

const midpointOf = (a: Pos, b: Pos): Pos => ({ e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 })
/** Ground for the span to sit in rather than fill: a line with nothing around it says little. */
const wantedHalfSide = (length: number) => Math.max(140, length * 0.85)

/** Share of the patch's half-width that must stay clear beyond each anchor. */
const EDGE_ROOM = 0.25

/**
 * Whether the ground under the view has to be read again.
 *
 * Sticky on purpose. Dragging an anchor moves the line, and re-reading a quarter of a million
 * heights for every few metres of that would make the view stutter exactly while it is being used.
 * A patch is built with room around the span, so the span can wander inside it.
 *
 * What forces a rebuild is an anchor running out of ground. An anchor near the edge of the square
 * is an anchor you cannot see the surroundings of, which is the one thing this view is for -- and
 * the midpoint can sit comfortably in the middle while an end is out at the rim, so it is the ends
 * that are asked. Measured per axis rather than as a distance, because the patch is a square: an
 * anchor is short of ground when it is close to a *side*, not when it is far from the centre.
 */
export function stale(held: Ground | null, a: Pos, b: Pos): boolean {
  if (!held) return true
  const want = wantedHalfSide(Math.hypot(b.e - a.e, b.n - a.n))
  if (want > held.halfSide * 1.3 || want < held.halfSide * 0.62) return true
  const room = held.halfSide * (1 - EDGE_ROOM)
  return [a, b].some(
    (p) => Math.max(Math.abs(p.e - held.centre.e), Math.abs(p.n - held.centre.n)) > room,
  )
}

export function Terrain3D({
  a, b, anchorA, anchorB, sagRatio, hoverAt, onMoveAnchor,
}: {
  a: Pos
  b: Pos
  anchorA: number
  anchorB: number
  sagRatio: number
  /** Where along the span the profile chart's pointer is, in metres, or null when it has left. */
  hoverAt?: number | null
  /** Omit to make the view read-only; with it, the anchors can be dragged onto the terrain. */
  onMoveAnchor?: (which: 'a' | 'b', at: LatLon) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<Scene3D | null>(null)
  const ground = useRef<Ground | null>(null)
  /** The heights as read, kept so a lake arriving later repaints them without reading them again. */
  const patch = useRef<Patch | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failed, setFailed] = useState<string | null>(null)
  const [measured, setMeasured] = useState(1)
  /** Windows still to arrive and how many there were, so the wait has a length. */
  const [fetching, setFetching] = useState<{ done: number; total: number } | null>(null)
  /** Whether the roads and water for the whole square are still on their way. */
  const [coverPending, setCoverPending] = useState(false)
  const [exaggeration, setExaggeration] = useState(preferred)
  /** Bumped when the ground under the view has to be read again. */
  const [epoch, setEpoch] = useState(0)

  const moveRef = useRef(onMoveAnchor)
  moveRef.current = onMoveAnchor

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
  useEffect(() => {
    if (!stale(ground.current, a, b)) return
    ground.current = {
      centre: midpointOf(a, b),
      halfSide: wantedHalfSide(Math.hypot(b.e - a.e, b.n - a.n)),
      datum: 0,
    }
    setEpoch((n) => n + 1)
  }, [a.e, a.n, b.e, b.n])

  /** The span and its shadow, in the scene's coordinates. Cheap: a hundred samples. */
  const spanOf = (g: Ground) => {
    const length = Math.hypot(b.e - a.e, b.n - a.n)
    const sag = sagRatio * length
    const line = new Float32Array(SPAN_POINTS * 3)
    const track = new Float32Array(SPAN_POINTS * 3)
    for (let i = 0; i < SPAN_POINTS; i++) {
      const t = i / (SPAN_POINTS - 1)
      const e = a.e + (b.e - a.e) * t
      const n = a.n + (b.n - a.n) * t
      const x = e - g.centre.e
      const z = -(n - g.centre.n)
      line[i * 3] = x
      line[i * 3 + 1] = lineHeightAt(anchorA, anchorB, sag, t) - g.datum
      line[i * 3 + 2] = z
      // The skin, not the bare earth: under a canopy the drawn ground *is* the treetops, and a
      // shadow laid on the soil beneath them would be inside the mesh and invisible.
      const bare = bareGround(e, n)
      const skin = surfaceSampler.sample(e, n)
      const under = Math.max(
        Number.isNaN(bare) ? -Infinity : bare,
        Number.isNaN(skin) ? -Infinity : skin,
      )
      track[i * 3] = x
      // A metre clear of what it follows, so it reads as lying on the ground rather than in it.
      track[i * 3 + 1] = (Number.isFinite(under) ? under : g.datum) - g.datum + 1
      track[i * 3 + 2] = z
    }
    const anchors: [number, number, number][] = [
      [a.e - g.centre.e, anchorA - g.datum, -(a.n - g.centre.n)],
      [b.e - g.centre.e, anchorB - g.datum, -(b.n - g.centre.n)],
    ]
    return { line, track, anchors, lookAt: (anchorA + anchorB) / 2 - sag / 2 - g.datum }
  }
  const spanRef = useRef(spanOf)
  spanRef.current = spanOf

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
      // Elevation only. Land cover is asked for below and never waited on: outside Brandenburg it
      // is an Overpass request that takes tens of seconds, and having it in here meant the view sat
      // on "reading the ground" long after the ground had been read. A picture of the terrain now
      // is worth more than a picture with the lakes already in it later, and the lakes repaint
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
      const rough = samplePatch(g.centre, g.halfSide, ROUGH_SIDE, readers)
      setMeasured(rough.measured)
      patch.current = rough
      // The coarse pass sets the floor everything is measured from, and the fine one keeps it, so
      // replacing the ground does not lift or drop the span hanging over it.
      g.datum = rough.low
      const mesh = meshOf(rough, g.datum)
      if (!mesh.indices.length) throw new Error('no elevation for the ground around this line')

      const { createScene } = await import('./scene3d.js')
      if (dropped || !host.current) return
      const canvas = document.createElement('canvas')
      host.current.replaceChildren(canvas)
      // Taken before the old scene goes, so a rebuild keeps the angle the viewer was looking from.
      const offset = scene.current?.viewOffset()
      scene.current?.dispose()
      scene.current = createScene(canvas, {
        mesh,
        ...spanRef.current(g),
        radius: g.halfSide,
        exaggeration: preferred,
        sagRatio,
        offset,
        onAnchorMoved: (which, x, z) => {
          const { lat, lon } = toWgs84(g.centre.e + x, g.centre.n - z)
          moveRef.current?.(which === 0 ? 'a' : 'b', { lat, lon })
        },
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
      const side = Math.min(
        MAX_SIDE,
        Math.max(MIN_SIDE, Math.round((2 * g.halfSide) / STEP_M) + 1),
      )
      const fine = samplePatch(g.centre, g.halfSide, side, readers)
      if (dropped) return
      patch.current = fine
      setMeasured(fine.measured)
      scene.current?.setMesh(meshOf(fine, g.datum))

      /**
       * And now the rest of the square's land cover, which the picture does not wait for.
       *
       * Inside Brandenburg the blocks are already held and this returns at once. Outside it, every
       * kilometre of the square is a request to Overpass -- so the ground is drawn brown, the lakes
       * arrive when they arrive, and only the colours change when they do.
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
  const repaint = useRef(() => {
    if (!patch.current || !scene.current) return
    const cover = coverOf(patch.current, {
      building: onBuilding,
      water: (e, n) => water.covers(e, n),
    })
    patch.current.cover.set(cover)
    scene.current.setColors(colorsOf(cover))
  })
  useEffect(() => onCoverChange(() => repaint.current()), [])

  /** The chart's pointer, as a fraction of the span, so the scene need not know about metres. */
  useEffect(() => {
    const length = Math.hypot(b.e - a.e, b.n - a.n)
    scene.current?.setHover(
      hoverAt === null || hoverAt === undefined || length <= 0 ? null : hoverAt / length,
    )
  }, [hoverAt, a.e, a.n, b.e, b.n, state])

  // Moving the span: the cheap half, and the one that runs on every step of an optimiser run.
  const lineKey = [a.e, a.n, b.e, b.n, anchorA, anchorB, sagRatio]
    .map((v) => Math.round(v * 100))
    .join('_')
  useEffect(() => {
    if (state !== 'ready' || !ground.current) return
    const { line, track, anchors } = spanRef.current(ground.current)
    scene.current?.setLine(line, track, anchors)
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
      {state === 'ready' && (
        <div className="scenelegend">
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
          {onMoveAnchor ? ' drag an anchor onto the ground · drag elsewhere to turn' : ' drag to turn'}
        </div>
      )}
    </div>
  )
}
