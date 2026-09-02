import {
  AmbientLight, BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, DirectionalLight, Fog,
  HemisphereLight, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Raycaster,
  Scene, SphereGeometry, TubeGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MeshData } from './terrainMesh.js'

/**
 * The 3D view of one site, and the only module in the app that knows three.js exists.
 *
 * Loaded on demand -- see Terrain3D.tsx, which imports this file dynamically -- so three and its
 * orbit controls are a chunk that nobody who never opens the full view ever downloads. That matters
 * more here than anywhere else in the app: it is about the size of everything else put together.
 *
 * Everything it is given is life size and measured from the floor of the patch, not from sea level.
 * Heights are multiplied by `exaggeration` on the way to the screen rather than on the way in, so
 * the factor can change without rebuilding the terrain and without the landscape climbing away from
 * a camera that was looking at it.
 */

export interface SceneInput {
  mesh: MeshData
  /** The span, three floats a point, sagging. */
  line: Float32Array
  /** The same span dropped onto the ground under it, which is what tells you where it runs. */
  track: Float32Array
  anchors: [number, number, number][]
  /** Half the patch's width in metres, which sets how far back the camera stands. */
  radius: number
  /** Height to look at, so the camera frames the line rather than the middle of the sky. */
  lookAt: number
  exaggeration: number
  /** Sag as a fraction of span, for drawing a line that is being dragged. */
  sagRatio: number
  /**
   * Called once an anchor has been let go, with where it landed relative to the patch centre.
   *
   * Only the drop, never the drag: measuring a line properly means planning it, and planning it
   * sixty times a second while a finger moves is neither wanted nor affordable. What the drag shows
   * is a provisional span between two points; what the drop produces is a measurement.
   */
  onAnchorMoved?: (which: 0 | 1, x: number, z: number) => void
  /**
   * Where the camera stood relative to what it was looking at, from a scene being replaced.
   *
   * Dragging an anchor far enough forces the ground to be read again, which builds a new scene. The
   * patch has moved, so the old camera position means nothing -- but the angle and the distance it
   * was being looked at from are the viewer's, and losing those on the third drag is the difference
   * between a view you are working in and one that keeps starting over.
   */
  offset?: [number, number, number]
}

export interface Scene3D {
  dispose(): void
  /** Redraws at a different vertical scale, keeping the camera where the viewer put it. */
  setExaggeration(k: number): void
  /** Replaces the span without touching the terrain, which is the expensive half. */
  setLine(line: Float32Array, track: Float32Array, anchors: [number, number, number][]): void
  /** Where the camera stands relative to its target, to hand to whatever replaces this scene. */
  viewOffset(): [number, number, number]
}

/** How long a camera left alone waits before it starts turning again. */
const RESUME_AFTER_MS = 4000

/** Points along a span being dragged. Fewer than the measured one; it is only a preview. */
const DRAG_SEGMENTS = 48

export function createScene(canvas: HTMLCanvasElement, input: SceneInput): Scene3D {
  const parent = canvas.parentElement!
  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  const scene = new Scene()
  scene.background = new Color('#0f1115')
  // Fades the square edge of the patch into the background, so what is drawn ends because the world
  // got far away rather than because the data stopped in a straight line.
  scene.fog = new Fog('#0f1115', input.radius * 1.6, input.radius * 3.4)

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(input.mesh.positions, 3))
  geometry.setAttribute('color', new BufferAttribute(input.mesh.colors, 3))
  geometry.setIndex(new BufferAttribute(input.mesh.indices, 1))
  geometry.computeVertexNormals()
  const ground = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true }))
  scene.add(ground)

  // Lambert and not standard: this is matte ground and matte foliage, there is nothing in the scene
  // that wants a roughness parameter, and the cheaper shader is the one a phone should be running.
  scene.add(new HemisphereLight('#9ec5e8', '#3b3228', 1.1))
  scene.add(new AmbientLight('#ffffff', 0.25))
  const sun = new DirectionalLight('#fff6e5', 1.5)
  sun.position.set(-1, 1.4, -0.8)
  scene.add(sun)

  let exaggeration = input.exaggeration
  let line = input.line
  let track = input.track
  let anchors = input.anchors

  const points = (a: Float32Array, k: number) => {
    const out: Vector3[] = []
    for (let i = 0; i < a.length; i += 3) out.push(new Vector3(a[i]!, a[i + 1]! * k, a[i + 2]!))
    return out
  }
  const tubeAlong = (pts: Vector3[], radius: number, sides: number) =>
    new TubeGeometry(new CatmullRomCurve3(pts), pts.length * 2, radius, sides, false)

  // A tube rather than a line: a one-pixel line disappears against a lit hillside at any distance,
  // and the span is the thing the whole view exists to show.
  const tubeRadius = Math.max(0.6, input.radius / 320)
  const spanMat = new MeshBasicMaterial({ color: '#f43f5e' })
  const spanMesh = new Mesh(tubeAlong(points(line, exaggeration), tubeRadius, 6), spanMat)
  scene.add(spanMesh)

  // The span's shadow, as a tube like the span itself. A one-pixel line was technically present and
  // practically invisible, and this is the mark that says where on the hillside the line runs.
  const trackMat = new MeshBasicMaterial({ color: '#7f1d2e' })
  const trackMesh = new Mesh(tubeAlong(points(track, exaggeration), tubeRadius * 0.7, 5), trackMat)
  scene.add(trackMesh)

  /**
   * The shadow of the span as it would be, drawn beside the shadow of the span as it is.
   *
   * While an anchor is being carried, the two together are the answer to the question the drag is
   * asking: the dark track is the ground the line covers now, the bright one is the ground it would
   * cover if you let go here. A line in the air is hard to place against a hillside seen at an
   * angle; its shadow is not, because it is lying on the thing you are aiming at.
   */
  const ghostMat = new MeshBasicMaterial({ color: '#fb7185' })
  const ghostMesh = new Mesh(new BufferGeometry(), ghostMat)
  ghostMesh.visible = false
  scene.add(ghostMesh)

  /**
   * The height of the drawn ground at a point, read straight off the mesh.
   *
   * Nearest vertex, on a grid one to two metres across: interpolating would buy a few centimetres
   * on a shadow whose job is to say which side of a gully something is on. Unexaggerated, like
   * everything else stored here.
   */
  const side = Math.round(Math.sqrt(input.mesh.positions.length / 3))
  const gridStep = (2 * input.radius) / (side - 1)
  const groundAt = (x: number, z: number): number => {
    const col = Math.round((x + input.radius) / gridStep)
    const row = Math.round((z + input.radius) / gridStep)
    if (col < 0 || row < 0 || col >= side || row >= side) return 0
    return input.mesh.positions[(row * side + col) * 3 + 1]!
  }

  const ballGeom = new SphereGeometry(tubeRadius * 3, 14, 10)
  const ballMat = new MeshBasicMaterial({ color: '#fca5a5' })
  // A hit sphere several times the drawn one, invisible. The drawn anchor is a couple of metres
  // across on a patch hundreds of metres wide, which is a few pixels -- fine to look at, impossible
  // to grab, and hopeless with a finger.
  const grabGeom = new SphereGeometry(tubeRadius * 11, 8, 6)
  const grabMat = new MeshBasicMaterial({ visible: false })
  const balls: Mesh[] = []
  const grabs: Mesh[] = []
  for (const [x, , z] of anchors) {
    const ball = new Mesh(ballGeom, ballMat)
    ball.position.set(x, 0, z)
    scene.add(ball)
    balls.push(ball)
    const grab = new Mesh(grabGeom, grabMat)
    scene.add(grab)
    grabs.push(grab)
  }

  /** Everything whose height is baked into its geometry rather than into a scale. */
  const rescale = (k: number) => {
    ground.scale.y = k
    spanMesh.geometry.dispose()
    spanMesh.geometry = tubeAlong(points(line, k), tubeRadius, 6)
    trackMesh.geometry.dispose()
    trackMesh.geometry = tubeAlong(points(track, k), tubeRadius * 0.7, 5)
    balls.forEach((ball, i) => {
      ball.position.set(anchors[i]![0], anchors[i]![1] * k, anchors[i]![2])
      grabs[i]!.position.copy(ball.position)
    })
  }
  rescale(exaggeration)

  const camera = new PerspectiveCamera(50, 1, 1, input.radius * 8)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.autoRotate = true
  controls.autoRotateSpeed = 0.45
  // Never below the horizon: under the terrain there is nothing but the back of it.
  controls.maxPolarAngle = Math.PI / 2 - 0.05
  controls.minDistance = input.radius * 0.3
  controls.maxDistance = input.radius * 4
  controls.target.set(0, input.lookAt * exaggeration, 0)
  const [ox, oy, oz] = input.offset ?? [
    input.radius * 1.15,
    input.radius * 0.62,
    input.radius * 1.15,
  ]
  camera.position.set(ox, controls.target.y + oy, oz)
  controls.update()

  // Turning stops the moment anyone touches it and starts again once they have stopped. A view that
  // keeps rotating under a drag fights the drag; one that never resumes stops being a view you can
  // leave running.
  let idle: ReturnType<typeof setTimeout> | undefined
  const pause = () => {
    controls.autoRotate = false
    clearTimeout(idle)
  }
  const resumeLater = () => {
    clearTimeout(idle)
    idle = setTimeout(() => {
      controls.autoRotate = true
    }, RESUME_AFTER_MS)
  }
  controls.addEventListener('start', pause)
  controls.addEventListener('end', resumeLater)

  /**
   * Dragging an anchor onto the ground it will actually stand on.
   *
   * The whole reason this view is worth having interactive rather than being a picture: on the map
   * an anchor is a dot on a photograph and you are guessing at the shape under it, and here you can
   * see the edge you are putting it on.
   *
   * Registered in the capture phase so a grab is decided before OrbitControls sees the event, and
   * stopped there when one is taken -- otherwise the same gesture would turn the camera as well.
   */
  const raycaster = new Raycaster()
  const pointer = new Vector2()
  let dragging: 0 | 1 | null = null
  /** Whether the anchor being held has actually gone anywhere. */
  let carried = false

  const aim = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    pointer.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
    )
    raycaster.setFromCamera(pointer, camera)
  }

  /** The provisional span, drawn straight from one ball to the other with the right sag in it. */
  const preview = () => {
    const [p, q] = [balls[0]!.position, balls[1]!.position]
    const span = Math.hypot(q.x - p.x, q.z - p.z)
    const sag = input.sagRatio * span * exaggeration
    const pts: Vector3[] = []
    for (let i = 0; i < DRAG_SEGMENTS; i++) {
      const t = i / (DRAG_SEGMENTS - 1)
      pts.push(
        new Vector3(
          p.x + (q.x - p.x) * t,
          p.y + (q.y - p.y) * t - 4 * sag * t * (1 - t),
          p.z + (q.z - p.z) * t,
        ),
      )
    }
    spanMesh.geometry.dispose()
    spanMesh.geometry = tubeAlong(pts, tubeRadius, 6)

    const shadow = pts.map(
      (v) => new Vector3(v.x, groundAt(v.x, v.z) * exaggeration + 1 * exaggeration, v.z),
    )
    ghostMesh.geometry.dispose()
    ghostMesh.geometry = tubeAlong(shadow, tubeRadius * 0.7, 5)
    ghostMesh.visible = true
  }

  /** Where a mouse is, so the frame loop can say whether it is over something it can pick up. */
  let hover: { x: number; y: number } | null = null

  const onDown = (ev: PointerEvent) => {
    if (!input.onAnchorMoved) return
    aim(ev)
    const hit = raycaster.intersectObjects(grabs, false)[0]
    if (!hit) return
    dragging = grabs.indexOf(hit.object as Mesh) as 0 | 1
    carried = false
    controls.enabled = false
    canvas.style.cursor = 'grabbing'
    pause()
    canvas.setPointerCapture(ev.pointerId)
    ev.stopPropagation()
    ev.preventDefault()
  }

  const onMove = (ev: PointerEvent) => {
    if (dragging === null) {
      // A cursor that changes over an anchor is the only thing that says the anchor can be picked
      // up. Mouse only: a finger has no hover, and there is nothing to show it.
      hover = ev.pointerType === 'mouse' && input.onAnchorMoved ? { x: ev.clientX, y: ev.clientY } : null
      return
    }
    ev.stopPropagation()
    aim(ev)
    const hit = raycaster.intersectObject(ground, false)[0]
    if (!hit) return
    // A little above where the ray met the ground, so the marker sits on the hillside rather than
    // half inside it. The height the anchor is really rigged at comes back from the measurement.
    balls[dragging]!.position.set(hit.point.x, hit.point.y + tubeRadius * 2, hit.point.z)
    grabs[dragging]!.position.copy(balls[dragging]!.position)
    carried = true
    preview()
  }

  const onUp = (ev: PointerEvent) => {
    if (dragging === null) return
    ev.stopPropagation()
    const { x, z } = balls[dragging]!.position
    const which = dragging
    dragging = null
    ghostMesh.visible = false
    controls.enabled = true
    canvas.style.cursor = ''
    resumeLater()
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)
    // A tap on an anchor is not a move. Reporting one anyway would place the anchor exactly where
    // it already is and then set a whole optimiser run going for it, which is a lot of machinery
    // for having touched something.
    if (carried) input.onAnchorMoved?.(which, x, z)
  }

  canvas.addEventListener('pointerdown', onDown, { capture: true })
  canvas.addEventListener('pointermove', onMove, { capture: true })
  canvas.addEventListener('pointerup', onUp, { capture: true })
  canvas.addEventListener('pointercancel', onUp, { capture: true })

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = parent
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const observer = new ResizeObserver(resize)
  observer.observe(parent)

  let raf = requestAnimationFrame(function frame() {
    raf = requestAnimationFrame(frame)
    if (hover && dragging === null) {
      const r = canvas.getBoundingClientRect()
      pointer.set(
        ((hover.x - r.left) / r.width) * 2 - 1,
        -((hover.y - r.top) / r.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
      canvas.style.cursor = raycaster.intersectObjects(grabs, false).length ? 'grab' : ''
    }
    controls.update()
    renderer.render(scene, camera)
  })

  return {
    setExaggeration(k: number) {
      if (k === exaggeration) return
      // Keep the camera where the viewer put it -- same direction, same distance -- and move only
      // what it is looking at. Scaling the camera's own height instead multiplies its offset from
      // the target as well, so the view backed off the landscape every time the factor went up.
      const offset = camera.position.clone().sub(controls.target)
      controls.target.y = input.lookAt * k
      camera.position.copy(controls.target).add(offset)
      exaggeration = k
      rescale(k)
      controls.update()
    },
    viewOffset() {
      const o = camera.position.clone().sub(controls.target)
      return [o.x, o.y, o.z]
    },
    setLine(nextLine, nextTrack, nextAnchors) {
      line = nextLine
      track = nextTrack
      anchors = nextAnchors
      rescale(exaggeration)
    },
    dispose() {
      cancelAnimationFrame(raf)
      clearTimeout(idle)
      observer.disconnect()
      for (const [type, fn] of [
        ['pointerdown', onDown],
        ['pointermove', onMove],
        ['pointerup', onUp],
        ['pointercancel', onUp],
      ] as const) {
        canvas.removeEventListener(type, fn, { capture: true })
      }
      controls.dispose()
      for (const g of [
        geometry, spanMesh.geometry, trackMesh.geometry, ghostMesh.geometry, ballGeom, grabGeom,
      ]) {
        g.dispose()
      }
      for (const m of [
        ground.material as MeshLambertMaterial, spanMat, trackMat, ghostMat, ballMat, grabMat,
      ]) {
        m.dispose()
      }
      renderer.dispose()
    },
  }
}
