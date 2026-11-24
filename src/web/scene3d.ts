import {
  AmbientLight, BufferAttribute, Curve, BufferGeometry, CatmullRomCurve3, Color, DirectionalLight, Fog,
  DoubleSide, FrontSide, HemisphereLight, Line as ThreeLine, LineDashedMaterial, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, PerspectiveCamera, Raycaster, Scene, SphereGeometry, TubeGeometry, Vector2,
  Vector3, WebGLRenderer, Group, Sprite, SpriteMaterial, CanvasTexture, Texture,
  ClampToEdgeWrapping, SRGBColorSpace,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EMPTY_MESH, type MeshData } from './terrainMesh.js'
import { disposeProps, referenceProps } from './props3d.js'

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

/** Another line of the same spot: its span, as `line` is, and its two anchors. */
export interface Other {
  line: Float32Array
  anchors: [[number, number, number], [number, number, number]]
}

export interface SceneInput {
  mesh: MeshData
  /** The vegetation skin, drawn translucent over the solid ground. Null where none is known. */
  canopy: MeshData | null
  /** The span, three floats a point, sagging. */
  line: Float32Array
  /**
   * The span dropped onto what it passes over, twice.
   *
   * `track` lies on the solid ground as drawn, roofs included -- where the line actually runs, which
   * is the mark that says which side of a gully it is on. `overTrack` lies on the canopy sheet where
   * there is one, so over a wood it sits on the treetops. Unevenly spaced: a point wherever the
   * drawn surface bends. Both are drawn: one shadow alone either disappears under the canopy or
   * floats above ground that is nowhere near it.
   */
  track: Float32Array
  overTrack: Float32Array
  anchors: [number, number, number][]
  /** The spot's other lines, drawn paler; tapping one asks for it. */
  others: Other[]
  onOtherTapped?: (index: number) => void
  /** Half the patch's width in metres, which sets how far back the camera stands. */
  radius: number
  /** Height to look at, so the camera frames the line rather than the middle of the sky. */
  lookAt: number
  exaggeration: number
  /** Whether the anchors can be picked up now: asked on every touch, as editing comes and goes. */
  movable: () => boolean
  /** Called when an anchor is tapped. */
  onAnchorTapped: (which: 0 | 1) => void
  /** Called when the focused anchor is dropped somewhere else, with where, from the patch centre. */
  onAnchorMoved?: (which: 0 | 1, x: number, z: number) => void
  /** Called when the view is tapped anywhere but on an anchor. */
  onElsewhereTapped?: () => void
  /** Sag as a fraction of span, as it is now, for drawing the line while an anchor is carried. */
  sagRatio: () => number
  /**
   * Where the camera stood relative to what it was looking at, from a scene being replaced.
   *
   * Moving an anchor far enough forces the ground to be read again, which builds a new scene. The
   * patch has moved, so the old camera position means nothing -- but the angle and the distance it
   * was being looked at from are the viewer's, and losing those on every move is the difference
   * between a view you are working in and one that keeps starting over.
   */
  offset?: [number, number, number]
  /** Whether the camera circles on its own. Carried in so a rebuilt scene keeps the last choice. */
  spin?: boolean
  /**
   * Where to stand the size references, in the patch's own metres, or omit for none.
   *
   * Chosen by the caller, which is the only thing that has the ground to choose from. See
   * `referenceSpot` in Terrain3D.
   */
  props?: { x: number; y: number; z: number }
}

/**
 * How much of the photograph is let through, at most.
 *
 * Set by eye against the one thing that must not break: a lake has to still read as water and a
 * wood as a wood on a hillside whose imagery was flown in a dry August. Past about a half the
 * classification stops being the thing you see and the view becomes a slightly worse satellite map,
 * which exists already and is one click away.
 */
const ORTHO_MIX = 0.45

export interface Scene3D {
  dispose(): void
  /**
   * Lays the aerial photograph of this square over the ground, or takes it away.
   *
   * Separate from the mesh because it arrives separately: the terrain is drawn from heights that
   * are already held, and the imagery is a dozen requests to somebody else's server that are not
   * made at all until the view is actually being looked at.
   */
  setOrtho(image: ImageBitmap | null): void
  /** Redraws at a different vertical scale, keeping the camera where the viewer put it. */
  setExaggeration(k: number): void
  /**
   * Replaces the span, and the ground with it: round each anchor the ground is drawn from the
   * survey's own cells (see `withFineGround`), so it moves with the anchors.
   */
  setLine(
    line: Float32Array,
    track: Float32Array,
    overTrack: Float32Array,
    anchors: [number, number, number][],
    mesh: MeshData,
    others: Other[],
  ): void
  /**
   * Marks where along the span something is being pointed at, or clears it.
   *
   * `t` runs 0 to 1 from A to B, which is what the profile chart's own distance divides down to --
   * so the chart can say "here" without knowing how this view is scaled or which way it is facing.
   */
  setHover(t: number | null): void
  /** Where the camera stands relative to its target, to hand to whatever replaces this scene. */
  viewOffset(): [number, number, number]
  /** Starts or stops the camera circling on its own. */
  setSpin(on: boolean): void
  /**
   * Repaints the ground without rebuilding it.
   *
   * Land cover outside Brandenburg arrives seconds after the terrain, and the terrain is a quarter
   * of a million vertices. Only the colour attribute changes, so only the colour attribute is
   * replaced -- the geometry, its normals and the camera all stay exactly as they are.
   */
  /**
   * Replaces the canopy over the ground and the buildings on it, together.
   *
   * The view is built from a coarse pass so there is something to look at while the fine one is
   * sampled, and this is the swap; it is also how a lake arriving late is repainted. Both surfaces
   * at once and whole, because positions, colours and indices have to change together -- leave one
   * behind and the index asks for vertices the attributes do not have, and nothing draws at all.
   * The span, the camera and the height scale are in terms of the patch rather than the mesh, and
   * the datum is the coarse pass's, so the two readings sit at exactly the same height.
   *
   * `buildings` is null where the ground carries the roofs itself, as the coarse pass does.
   */
  setMesh(canopy: MeshData | null, buildings: MeshData | null): void
  /**
   * Flies the camera to one anchor and keeps it there, or back to the whole line.
   *
   * Close up is where an anchor can be placed to the decimetre: from the opening view a pixel is
   * most of a metre, and the camera was not allowed near enough for that to change.
   */
  focus(which: 0 | 1 | null): void
  /**
   * The two directions on the ground that "up" and "right" on the screen point along, as unit
   * vectors in the patch's x and z. What a nudge is measured in, so an arrow moves the anchor the
   * way it points from wherever the camera happens to be standing.
   */
  groundAxes(): { forward: [number, number]; right: [number, number] }
}

/** How far from a focused anchor the camera settles, in metres. */
const FOCUS_DISTANCE = 30

/** How close the camera may come to a focused anchor, in metres. */
const FOCUS_NEAREST = 2

/** How near an anchor a press takes it, in screen pixels: a fingertip, not the few the ball covers. */
const GRAB_PX = 28

/** How far a press may wander and still be a tap rather than a drag, in screen pixels. */
const TAP_SLOP_PX = 5

/** How much larger an anchor is drawn under the mouse. */
const HOVER_GROWTH = 1.6

/** The share of the way to its hovered size and colour an anchor moves each frame. */
const HOVER_EASE = 0.4

/** Points along a span being dragged. Fewer than the measured one; it is only a preview. */
const DRAG_SEGMENTS = 48

/**
 * The canvas shape the default camera height was chosen against.
 *
 * Roughly a wide panel on a laptop, which is where this view was designed. Anything squarer or
 * taller than this gets a higher camera -- see `lift`.
 */
const LANDSCAPE = 1.6

/** How long a camera left alone waits before it starts turning again. */
const RESUME_AFTER_MS = 4000


/** A polyline as a three.js curve, parameterised by point index so a tube puts a ring on each. */
class Polyline extends Curve<Vector3> {
  constructor(private readonly pts: Vector3[]) {
    super()
  }
  override getPoint(t: number, target = new Vector3()): Vector3 {
    const f = Math.min(1, Math.max(0, t)) * (this.pts.length - 1)
    const i = Math.min(this.pts.length - 2, Math.floor(f))
    return target.lerpVectors(this.pts[i]!, this.pts[i + 1]!, f - i)
  }
  override getPointAt(u: number, target?: Vector3): Vector3 {
    return this.getPoint(u, target)
  }
  override getTangentAt(u: number, target?: Vector3): Vector3 {
    return this.getTangent(u, target)
  }
}

export function createScene(canvas: HTMLCanvasElement, input: SceneInput): Scene3D {
  const parent = canvas.parentElement!
  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  const scene = new Scene()
  scene.background = new Color('#dfe6ee')
  // Fades the square edge of the patch into the background, so what is drawn ends because the world
  // got far away rather than because the data stopped in a straight line.
  scene.fog = new Fog('#dfe6ee', input.radius * 1.6, input.radius * 3.4)

  /**
   * The ground, built whole every time rather than attribute by attribute.
   *
   * Replacing a coarse reading with a fine one changes the vertex count, so positions, colours and
   * indices have to change together: leave any one of them behind and the index buffer asks for
   * vertices the attributes do not have, which WebGL reports and then draws nothing at all. One
   * object, swapped, cannot be half updated.
   */
  const geometryOf = (mesh: MeshData) => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(mesh.positions, 3))
    g.setAttribute('color', new BufferAttribute(mesh.colors, 3))
    g.setIndex(new BufferAttribute(mesh.indices, 1))
    g.computeVertexNormals()
    return g
  }
  /**
   * The aerial photograph of this square, mixed into the measured colours rather than over them.
   *
   * The colours are what the ground *is* -- wood, water, building, bare earth, each read from the
   * survey -- and they have to stay readable, so the photograph is let in as texture and almost no
   * hue: its brightness modulates the colour already there, and a fifth of its colour comes through.
   * What that buys is everything the classification cannot say. A field edge, a path, the shape of
   * the roof and which half of it is glass are all in the imagery and in none of the numbers.
   *
   * Three things are deliberate. The texture is a planar projection from above, so vertical faces
   * would be a smear of whatever pixel is above them -- `vOrthoUp` fades it out as a face turns
   * towards the horizon, and a wall keeps the flat colour it had. The imagery is only reached for
   * once the view is on screen (see Terrain3D), so the mix starts at zero and the uniform arrives
   * later. And where no survey answered, the texture is simply transparent there and its own alpha
   * takes the mix back to nothing.
   */
  const orthoMap = { value: null as Texture | null }
  const orthoMix = { value: 0 }
  const orthoRadius = { value: input.radius }
  const groundMaterial = (side: typeof FrontSide | typeof DoubleSide) => {
  const mat = new MeshLambertMaterial({ vertexColors: true, side })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.orthoMap = orthoMap
    shader.uniforms.orthoMix = orthoMix
    shader.uniforms.orthoRadius = orthoRadius
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float orthoRadius;
         varying vec2 vOrthoUv;
         varying float vOrthoUp;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vOrthoUv = (position.xz + orthoRadius) / (2.0 * orthoRadius);
         vOrthoUp = abs(normalize(normal).y);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D orthoMap;
         uniform float orthoMix;
         varying vec2 vOrthoUv;
         varying float vOrthoUp;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         if (orthoMix > 0.0) {
           vec4 photo = texture2D(orthoMap, vOrthoUv);
           float k = orthoMix * vOrthoUp * photo.a;
           float lum = dot(photo.rgb, vec3(0.299, 0.587, 0.114));
           diffuseColor.rgb = mix(diffuseColor.rgb, photo.rgb, k * 0.22) *
             max(0.0, 1.0 + k * (lum - 0.45) * 1.3);
         }`,
      )
  }
  return mat
  }
  const groundMat = groundMaterial(FrontSide)
  const buildingMat = groundMaterial(DoubleSide)

  const ground = new Mesh(geometryOf(input.mesh), groundMat)
  scene.add(ground)
  const buildings = new Mesh(geometryOf(EMPTY_MESH), buildingMat)
  scene.add(buildings)


  /**
   * The vegetation, over the ground rather than instead of it.
   *
   * Translucent, so the shape of the hill reads through the wood standing on it -- which is most of
   * what someone is looking for here, since the line hangs over the ground and through the trees.
   * Both sides, because the camera goes under the canopy as often as over it, and no depth writing,
   * so the sheet never hides the terrain or the span behind it.
   */
  const canopyMat = new MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: DoubleSide,
  })
  const canopy = new Mesh(geometryOf(input.canopy ?? EMPTY_MESH), canopyMat)
  canopy.visible = !!input.canopy
  scene.add(canopy)

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
  let overTrack = input.overTrack
  let anchors = input.anchors
  let others = input.others

  const points = (a: Float32Array, k: number) => {
    const out: Vector3[] = []
    for (let i = 0; i < a.length; i += 3) out.push(new Vector3(a[i]!, a[i + 1]! * k, a[i + 2]!))
    return out
  }
  const tubeAlong = (pts: Vector3[], radius: number, sides: number) =>
    new TubeGeometry(new CatmullRomCurve3(pts), pts.length * 2, radius, sides, false)
  /** Corner to corner with no smoothing, a ring at every point: a curve through a wall overshoots. */
  const tubeOnto = (pts: Vector3[], radius: number, sides: number) =>
    pts.length < 2
      ? new BufferGeometry()
      : new TubeGeometry(new Polyline(pts), pts.length - 1, radius, sides, false)

  // A tube rather than a line: a one-pixel line disappears against a lit hillside at any distance,
  // and the span is the thing the whole view exists to show.
  /**
   * How thick the span and its shadows are drawn, and how big an anchor is.
   *
   * A width in metres is the wrong unit for something whose job is to be *seen*. At the far end of
   * the zoom the span is a hair against a hillside three hundred metres across, and at the near end
   * the same tube is a pipe wide enough to hide the ground it is supposed to be measured against.
   * So the metres are recomputed from how far the camera is standing off -- see `zoomThickness` --
   * and everything drawn as an annotation rather than as terrain follows them.
   *
   * `baseRadius` is what that works out to at the distance the camera starts at, and the scaling is
   * clamped either side of it: a line should get easier to see as you pull back, not turn into a
   * causeway, and it should thin down as you close in without vanishing.
   */
  const baseRadius = Math.max(0.6, input.radius / 320)
  let tubeRadius = baseRadius
  const spanMat = new MeshBasicMaterial({ color: '#f43f5e' })
  const spanMesh = new Mesh(tubeAlong(points(line, exaggeration), tubeRadius, 6), spanMat)
  scene.add(spanMesh)

  const otherMat = new MeshBasicMaterial({ color: '#fda4af', transparent: true, opacity: 0.85 })
  const otherRoot = new Group()
  scene.add(otherRoot)
  const drawOthers = (k: number) => {
    for (const m of otherRoot.children as Mesh[]) if (m.geometry !== ballGeom) m.geometry.dispose()
    otherRoot.clear()
    others.forEach((o, i) => {
      const span = new Mesh(tubeAlong(points(o.line, k), tubeRadius * 0.8, 6), otherMat)
      span.userData.other = i
      otherRoot.add(span)
      for (const [x, y, z] of o.anchors) {
        const ball = new Mesh(ballGeom, otherMat)
        ball.position.set(x, y * k, z)
        ball.scale.setScalar(tubeRadius * 2.2)
        ball.userData.other = i
        otherRoot.add(ball)
      }
    })
  }

  // The span's shadow, as a tube like the span itself. A one-pixel line was technically present and
  // practically invisible, and this is the mark that says where on the hillside the line runs.
  const trackMat = new MeshBasicMaterial({ color: '#7f1d2e' })
  const trackMesh = new Mesh(tubeOnto(points(track, exaggeration), tubeRadius * 0.7, 5), trackMat)
  scene.add(trackMesh)

  // The same mark where the line crosses a canopy, thinner and paler: it is the top of the wood
  // rather than the ground, and the ground is the one being read.
  const overMat = new MeshBasicMaterial({ color: '#f43f5e', transparent: true, opacity: 0.45 })
  const overMesh = new Mesh(tubeOnto(points(overTrack, exaggeration), tubeRadius * 0.45, 5), overMat)
  scene.add(overMesh)

  /**
   * What holds each end up, as a post from the ground to the anchor.
   *
   * Without it a line rigged twelve metres up a pine begins in mid-air, and mid-air is the one thing
   * it must not look like. One post, coloured for what the whole thing would be made of: brown while
   * it stays inside what is standing there, since an A-frame and a trunk are both wood, and metal
   * once it reaches past it, because at that height nothing holding the line up was not carried in.
   *
   * Both heights are already in the scene -- `track` follows the bare earth under the span and
   * `overTrack` its skin -- so the ends of those two polylines are the ground and the treetop at
   * each anchor, and nothing new has to be sampled.
   */
  const stemMat = {
    wood: new MeshBasicMaterial({ color: '#6b5847' }),
    metal: new MeshBasicMaterial({ color: '#b9c0cc' }),
  }
  const stems: Mesh[] = []
  for (let i = 0; i < 2; i++) {
    const stem = new Mesh(new BufferGeometry(), stemMat.wood)
    stem.visible = false
    scene.add(stem)
    stems.push(stem)
  }

  /** Where one end's polyline starts or finishes, which is where its anchor stands. */
  const endOf = (a: Float32Array, end: 0 | 1, k: number): Vector3 => {
    const i = end === 0 ? 0 : a.length / 3 - 1
    return new Vector3(a[i * 3]!, a[i * 3 + 1]! * k, a[i * 3 + 2]!)
  }

  const drawStems = (k: number) => {
    ;([0, 1] as const).forEach((end) => {
      const post = anchors[end]
      const stem = stems[end]!
      stem.visible = false
      if (!post) return
      const top = new Vector3(post[0], post[1] * k, post[2])
      const foot = endOf(track, end, k)
      // A stem shorter than the tube is thicker than it is long, and every line has an anchor a few
      // centimetres up: a post for that is noise on every scene rather than information on one.
      if (top.y - foot.y < tubeRadius * 4) return
      stem.material = top.y > endOf(overTrack, end, k).y + tubeRadius ? stemMat.metal : stemMat.wood
      stem.geometry.dispose()
      stem.geometry = tubeAlong([foot, top], tubeRadius * 0.8, 5)
      stem.visible = true
    })
  }

  /**
   * A figure and a car, standing on the flattest ground beside the line.
   *
   * Stretched by the height factor along with everything else, which looks wrong and is right: at
   * five times the relief, a person drawn at their true height would make a twenty-metre cliff read
   * as a hundred-metre one. The reference has to be distorted exactly as much as the thing it is a
   * reference for. At the default factor of one there is no distortion and the question does not
   * arise.
   */
  const propsRoot = new Group()
  if (input.props) {
    propsRoot.add(referenceProps())
    scene.add(propsRoot)
  }

  /**
   * "A" and "B", floating over their anchors.
   *
   * Sprites drawn on a canvas, rather than text geometry: a letter as geometry needs a font file
   * fetched and parsed, and this needs two glyphs. A sprite also always faces the camera, which is
   * the whole requirement for a label in a view that spends its time slowly turning.
   *
   * Held at a constant size on screen instead of shrinking with distance, because a label is not
   * part of the scenery -- it has to stay legible at whatever zoom the terrain is being read at.
   * And drawn over everything rather than depth-tested: an anchor on the far side of a hill is
   * exactly when knowing which end it is matters, and a hidden label would say nothing at all.
   */
  const labelOf = (text: string): Sprite => {
    const px = 64
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = px
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.font = `bold ${px * 0.66}px ui-sans-serif, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      // A dark rim first, so the letter reads against pale rock and dark wood alike.
      ctx.lineWidth = px * 0.13
      ctx.strokeStyle = 'rgba(9, 10, 13, 0.85)'
      ctx.strokeText(text, px / 2, px * 0.54)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(text, px / 2, px * 0.54)
    }
    const texture = new CanvasTexture(canvas)
    const sprite = new Sprite(new SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false }))
    sprite.scale.set(0.032, 0.032, 1)
    sprite.renderOrder = 10
    return sprite
  }
  const labels = ['A', 'B'].map(labelOf)
  scene.add(...labels)

  // Unit spheres, sized by `scale` rather than by geometry: a sphere is the one thing here that can
  // follow the zoom every frame for nothing, since scaling it uniformly is exactly right.
  const ballGeom = new SphereGeometry(1, 14, 10)
  const ballColor = { plain: new Color('#fca5a5'), focused: new Color('#f43f5e'), hovered: new Color('#fb923c') }
  const balls: Mesh<SphereGeometry, MeshBasicMaterial>[] = []
  for (const [x, , z] of anchors) {
    const ball = new Mesh(ballGeom, new MeshBasicMaterial({ color: ballColor.plain }))
    ball.position.set(x, 0, z)
    scene.add(ball)
    balls.push(ball)
  }
  /** Which anchor the camera is held on, and whether it is still on its way there or back. */
  let focused: 0 | 1 | null = null
  let travelling = false
  /** The anchor under the mouse, drawn larger and in its own colour so it reads as something to take. */
  let hovered: 0 | 1 | null = null
  /** How far each ball has grown towards its hovered size, eased so a hover reads as a change. */
  const grown = [1, 1]
  /** Moves each ball `ease` of the way to the size and colour it should have; 0 only re-applies size. */
  const styleBalls = (ease = 0) =>
    balls.forEach((ball, i) => {
      const want = i === hovered ? ballColor.hovered : i === focused ? ballColor.focused : ballColor.plain
      ball.material.color.lerp(want, ease)
      grown[i]! += ((i === hovered ? HOVER_GROWTH : 1) - grown[i]!) * ease
      ball.scale.setScalar(tubeRadius * 3 * grown[i]!)
    })

  // Clear of the ball rather than on it, so the letter never sits over the thing it names.
  const placeLabel = (i: number) => {
    const at = balls[i]!.position
    labels[i]?.position.set(at.x, at.y + tubeRadius * 9, at.z)
  }

  /**
   * The pointer, borrowed from the chart beside this view.
   *
   * A ball on the span and a dashed line from it to the ground under it. The drop is what makes the
   * position readable: a ball hanging in a picture of a valley could be anywhere along the line of
   * sight, and the foot of a vertical tells you which.
   */
  const hoverBall = new Mesh(new SphereGeometry(1, 14, 10), new MeshBasicMaterial({ color: '#ffffff' }))
  const hoverDrop = new ThreeLine(
    new BufferGeometry(),
    new LineDashedMaterial({ color: '#ffffff', dashSize: tubeRadius * 6, gapSize: tubeRadius * 4 }),
  )
  hoverBall.visible = false
  hoverDrop.visible = false
  scene.add(hoverBall, hoverDrop)

  /** A point along one of the stored polylines, at a fraction of its length. */
  const along = (a: Float32Array, t: number, k: number): Vector3 => {
    const n = a.length / 3
    const at = Math.min(n - 1, Math.max(0, t * (n - 1)))
    const i = Math.min(n - 2, Math.floor(at))
    const f = at - i
    const mix = (c: number) => a[i * 3 + c]! * (1 - f) + a[(i + 1) * 3 + c]! * f
    return new Vector3(mix(0), mix(1) * k, mix(2))
  }

  /** The point of `track` straight below a point over the span, found by where it lies along it. */
  const under = (p: Vector3, k: number): Vector3 => {
    const n = track.length / 3
    if (n < 2) return new Vector3(p.x, 0, p.z)
    const [x0, z0] = [line[0]!, line[2]!]
    const [dx, dz] = [line[line.length - 3]! - x0, line[line.length - 1]! - z0]
    const s = (x: number, z: number) => ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz || 1)
    const want = s(p.x, p.z)
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (s(track[mid * 3]!, track[mid * 3 + 2]!) <= want) lo = mid
      else hi = mid
    }
    const [sa, sb] = [s(track[lo * 3]!, track[lo * 3 + 2]!), s(track[hi * 3]!, track[hi * 3 + 2]!)]
    const f = sb > sa ? Math.min(1, Math.max(0, (want - sa) / (sb - sa))) : 0
    const y = track[lo * 3 + 1]! * (1 - f) + track[hi * 3 + 1]! * f
    return new Vector3(p.x, y * k, p.z)
  }

  let hoverAt: number | null = null
  const drawHover = () => {
    hoverBall.visible = hoverDrop.visible = hoverAt !== null
    if (hoverAt === null) return
    const top = along(line, hoverAt, exaggeration)
    const foot = under(top, exaggeration)
    hoverBall.position.copy(top)
    // Follows the zoom with the anchors, or it would out-grow them as the camera comes in.
    hoverBall.scale.setScalar(tubeRadius * 4)
    hoverDrop.geometry.dispose()
    hoverDrop.geometry = new BufferGeometry().setFromPoints([top, foot])
    // Dashes are measured along the line, so it has to be told how long it is.
    hoverDrop.computeLineDistances()
  }

  /** Everything whose height is baked into its geometry rather than into a scale. */
  const rescale = (k: number) => {
    ground.scale.y = k
    buildings.scale.y = k
    canopy.scale.y = k
    spanMesh.geometry.dispose()
    spanMesh.geometry = tubeAlong(points(line, k), tubeRadius, 6)
    trackMesh.geometry.dispose()
    trackMesh.geometry = tubeOnto(points(track, k), tubeRadius * 0.7, 5)
    overMesh.geometry.dispose()
    overMesh.geometry = tubeOnto(points(overTrack, k), tubeRadius * 0.45, 5)
    if (input.props) {
      propsRoot.position.set(input.props.x, input.props.y * k, input.props.z)
      propsRoot.scale.y = k
    }
    balls.forEach((ball, i) => {
      ball.position.set(anchors[i]![0], anchors[i]![1] * k, anchors[i]![2])
      placeLabel(i)
    })
    styleBalls()
    labels.forEach((l, i) => {
      l.visible = !!anchors[i]
    })
    drawStems(k)
    drawOthers(k)
    drawHover()
  }
  rescale(exaggeration)

  const camera = new PerspectiveCamera(50, 1, 1, input.radius * 8)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  let spinning = input.spin ?? true
  controls.autoRotate = spinning
  controls.autoRotateSpeed = 0.45
  // Never below the horizon: under the terrain there is nothing but the back of it.
  controls.maxPolarAngle = Math.PI / 2 - 0.05
  controls.minDistance = input.radius * 0.3
  controls.maxDistance = input.radius * 4
  controls.target.set(0, input.lookAt * exaggeration, 0)
  /**
   * How high the camera stands when nobody has moved it, which depends on the shape of the box it
   * is standing in.
   *
   * `fov` is the *vertical* angle, so a portrait canvas is taller in world units than it is wide at
   * every depth -- while the patch, seen from this angle, is wide and short. The width is what
   * binds, the surplus height goes to sky, and on a phone that was four tenths of the picture spent
   * on black above the horizon.
   *
   * Standing higher is the lever: it tilts the camera down, which lifts the horizon towards the top
   * of the frame and fills the frame with ground. Measured against a landscape canvas, so the view
   * on a desk is exactly the view it was, and capped -- past about here it stops being a view of a
   * place and becomes a map of one.
   */
  const shape = parent.clientHeight > 0 ? parent.clientWidth / parent.clientHeight : LANDSCAPE
  const lift = Math.min(1.35, 0.62 * Math.max(1, LANDSCAPE / shape))
  const [ox, oy, oz] = input.offset ?? [
    input.radius * 1.15,
    input.radius * lift,
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
  // Back to whatever the viewer asked for rather than to turning: a scene switched off by hand must
  // not start again by itself the moment it is let go of.
  const resumeLater = () => {
    clearTimeout(idle)
    idle = setTimeout(() => {
      // Never while an anchor is being worked on: it would carry the anchor out from under the arrows.
      controls.autoRotate = spinning && focused === null
    }, RESUME_AFTER_MS)
  }
  controls.addEventListener('start', pause)
  controls.addEventListener('end', resumeLater)

  /**
   * Tapping an anchor hands it to the step controls beside this view; once it is picked, it can
   * also be dragged onto the ground, and a tap anywhere else lets it go again.
   *
   * An anchor is taken within a finger's width of where it is drawn, not by its few pixels of
   * sphere. Registered in the capture phase so a press on an anchor is decided before OrbitControls
   * sees the event, and stopped there -- otherwise the same gesture would turn the camera as well.
   */
  const raycaster = new Raycaster()
  const pointer = new Vector2()
  /** The anchor pressed, and where the press began, in client pixels. */
  let pressed: { which: 0 | 1; x: number; y: number } | null = null
  /** A press on the view itself, which is a tap elsewhere if it is let go where it began. */
  let pressedElsewhere: { x: number; y: number } | null = null
  let dragging = false

  const aimAt = (x: number, y: number) => {
    const r = canvas.getBoundingClientRect()
    pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
  }

  /** The anchor drawn within reach of a point on the screen, the nearer if both are. */
  const anchorAt = (x: number, y: number, reach = GRAB_PX): 0 | 1 | null => {
    const r = canvas.getBoundingClientRect()
    let best: 0 | 1 | null = null
    let bestDistance = reach
    balls.forEach((ball, i) => {
      if (!anchors[i]) return
      const p = ball.position.clone().project(camera)
      if (p.z > 1) return
      const d = Math.hypot(r.left + ((p.x + 1) / 2) * r.width - x, r.top + ((1 - p.y) / 2) * r.height - y)
      if (d <= bestDistance) {
        best = i as 0 | 1
        bestDistance = d
      }
    })
    return best
  }

  /** The line as it would hang from the anchors where they are drawn, while one is carried. */
  const preview = () => {
    const [p, q] = [balls[0]!.position, balls[1]!.position]
    const sag = input.sagRatio() * Math.hypot(q.x - p.x, q.z - p.z) * exaggeration
    const pts = Array.from({ length: DRAG_SEGMENTS }, (_, i) => {
      const t = i / (DRAG_SEGMENTS - 1)
      return new Vector3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t - 4 * sag * t * (1 - t), p.z + (q.z - p.z) * t)
    })
    spanMesh.geometry.dispose()
    spanMesh.geometry = tubeAlong(pts, tubeRadius, 6)
  }

  /** Carries the pressed anchor to the ground under a point on the screen. */
  const carry = (x: number, y: number) => {
    if (!pressed) return
    aimAt(x, y)
    const hit = raycaster.intersectObjects([ground, buildings], false)[0]
    if (!hit) return
    balls[pressed.which]!.position.copy(hit.point)
    placeLabel(pressed.which)
    preview()
  }

  /** Where a mouse is, so the frame loop can say whether it is over something it can pick up. */
  let hover: { x: number; y: number } | null = null

  const onDown = (ev: PointerEvent) => {
    if (!input.movable()) return
    const which = anchorAt(ev.clientX, ev.clientY)
    if (which === null) {
      pressedElsewhere = { x: ev.clientX, y: ev.clientY }
      return
    }
    pressed = { which, x: ev.clientX, y: ev.clientY }
    dragging = false
    controls.enabled = false
    pause()
    canvas.setPointerCapture(ev.pointerId)
    ev.stopPropagation()
    ev.preventDefault()
  }

  const onMove = (ev: PointerEvent) => {
    // A larger ball in its own colour, and a cursor that changes, are what say an anchor can be
    // taken. Mouse only: a finger has no hover, and there is nothing to show it.
    hover = ev.pointerType === 'mouse' && input.movable() ? { x: ev.clientX, y: ev.clientY } : null
    if (!pressed) return
    ev.stopPropagation()
    if (pressed.which !== focused || !input.onAnchorMoved) return
    if (!dragging && Math.hypot(ev.clientX - pressed.x, ev.clientY - pressed.y) < TAP_SLOP_PX) return
    dragging = true
    hovered = pressed.which
    canvas.style.cursor = 'grabbing'
    carry(ev.clientX, ev.clientY)
  }

  const onUp = (ev: PointerEvent) => {
    const elsewhere = pressedElsewhere
    pressedElsewhere = null
    if (!pressed) {
      const still = elsewhere && Math.hypot(ev.clientX - elsewhere.x, ev.clientY - elsewhere.y) < TAP_SLOP_PX
      if (!still || ev.type !== 'pointerup') return
      aimAt(ev.clientX, ev.clientY)
      const other = raycaster.intersectObjects(otherRoot.children, false)[0]
      if (other) return input.onOtherTapped?.(other.object.userData.other as number)
      if (focused !== null) input.onElsewhereTapped?.()
      return
    }
    ev.stopPropagation()
    const { which } = pressed
    pressed = null
    controls.enabled = true
    resumeLater()
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId)
    if (!dragging) return input.onAnchorTapped(which)
    dragging = false
    hovered = null
    const at = balls[which]!.position.clone()
    if (ev.type === 'pointerup') input.onAnchorMoved?.(which, at.x, at.z)
    // Back where it was until the caller answers with the line as it now is, or for good if cancelled.
    rescale(exaggeration)
    if (ev.type === 'pointerup') balls[which]!.position.copy(at)
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
    // Resizing clears the canvas, and a ResizeObserver runs after this frame's render: without
    // drawing again here, the browser paints the cleared canvas, a white flash per resize step.
    renderer.render(scene, camera)
  }
  resize()
  const observer = new ResizeObserver(resize)
  observer.observe(parent)

  /**
   * The thickness the current camera distance asks for, as a multiple of `baseRadius`.
   *
   * Proportional to distance, so the span keeps roughly the same weight on screen however far out
   * the camera is -- and clamped, because "roughly" is the honest word: past a point a line that
   * kept growing would start hiding the shape of the ground, which is the thing it is drawn on.
   */
  const startedAt = camera.position.distanceTo(controls.target)
  const zoomThickness = () =>
    Math.min(
      2.2,
      // Thinner close up to an anchor, or the ball would hide the ground it is being placed on.
      Math.max(focused === null ? 0.45 : 0.04, camera.position.distanceTo(controls.target) / startedAt),
    )

  /**
   * Eases the camera towards the focused anchor, or home to the whole line.
   *
   * While focused the target keeps following the ball, so a nudge never walks the anchor out of
   * the picture. The distance is only steered on the way there and back; in between it is the
   * viewer's to zoom.
   */
  const steer = () => {
    // Held still under a drag: following the ball would move the ground out from under the pointer.
    if (dragging || (focused === null && !travelling)) return
    const goal =
      focused === null ? new Vector3(0, input.lookAt * exaggeration, 0) : balls[focused]!.position
    const offset = camera.position.clone().sub(controls.target)
    controls.target.lerp(goal, 0.2)
    if (travelling) {
      const want = focused === null ? startedAt : FOCUS_DISTANCE
      offset.setLength(offset.length() + (want - offset.length()) * 0.2)
      if (Math.abs(offset.length() - want) < want * 0.01 && controls.target.distanceTo(goal) < 0.05) {
        travelling = false
        if (focused === null) controls.minDistance = input.radius * 0.3
      }
    }
    camera.position.copy(controls.target).add(offset)
  }

  /**
   * Rebuilt on a step rather than every frame.
   *
   * A sphere follows the zoom by scaling, which costs nothing. A tube cannot: its radius is baked
   * into its vertices, and scaling one uniformly would stretch its length as well. So the tubes are
   * rebuilt, and rebuilding four of them sixty times a second to chase a number that has moved by a
   * per cent would be a waste of a frame budget the terrain needs. A sixth either way is below what
   * the eye catches on a smooth zoom and far above what an idle orbit will trigger.
   */
  let builtAt = 1
  const followZoom = () => {
    const want = zoomThickness()
    const dash = hoverDrop.material as LineDashedMaterial
    dash.dashSize = baseRadius * want * 6
    dash.gapSize = baseRadius * want * 4
    balls.forEach((ball) => ball.scale.setScalar(baseRadius * want * 3))
    if (Math.abs(want / builtAt - 1) < 0.17) return
    builtAt = want
    tubeRadius = baseRadius * want
    rescale(exaggeration)
  }

  let raf = requestAnimationFrame(function frame() {
    raf = requestAnimationFrame(frame)
    steer()
    followZoom()
    if (!pressed) {
      // Held a little further out than it is taken, so a hover does not flicker at the rim.
      const under = hover ? anchorAt(hover.x, hover.y, hovered === null ? GRAB_PX : GRAB_PX * 1.5) : null
      if (under !== hovered) {
        hovered = under
        // A turning view would carry the anchor out from under a mouse that is holding still.
        if (under === null) resumeLater()
        else pause()
      }
      canvas.style.cursor = under === null ? '' : under === focused && input.onAnchorMoved ? 'grab' : 'pointer'
    }
    styleBalls(HOVER_EASE)
    controls.update()
    renderer.render(scene, camera)
  })

  return {
    focus(which) {
      if (which === focused) return
      focused = which
      travelling = true
      if (which === null) return resumeLater()
      controls.minDistance = FOCUS_NEAREST
      pause()
    },
    groundAxes() {
      const f = controls.target.clone().sub(camera.position)
      f.y = 0
      if (f.lengthSq() < 1e-9) f.set(0, 0, -1)
      f.normalize()
      return { forward: [f.x, f.z], right: [-f.z, f.x] }
    },
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
    setOrtho(image: ImageBitmap | null) {
      orthoMap.value?.dispose()
      if (!image) {
        orthoMap.value = null
        orthoMix.value = 0
        return
      }
      const texture = new Texture(image)
      // Drawn north-up and in the patch's own axes, which is the order the mesh's rows are built
      // in -- so it is sampled as it was drawn rather than flipped the way an HTML image would be.
      texture.flipY = false
      texture.colorSpace = SRGBColorSpace
      texture.wrapS = ClampToEdgeWrapping
      texture.wrapT = ClampToEdgeWrapping
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
      texture.needsUpdate = true
      orthoMap.value = texture
      orthoMix.value = ORTHO_MIX
    },
    setMesh(next: MeshData | null, roofs: MeshData | null) {
      for (const [target, data] of [
        [canopy, next ?? EMPTY_MESH],
        [buildings, roofs ?? EMPTY_MESH],
      ] as const) {
        const old = target.geometry
        target.geometry = geometryOf(data)
        old.dispose()
      }
      canopy.visible = !!next && next.indices.length > 0
    },
    setSpin(on) {
      spinning = on
      controls.autoRotate = on
      clearTimeout(idle)
    },
    viewOffset() {
      const o = camera.position.clone().sub(controls.target)
      return [o.x, o.y, o.z]
    },
    setHover(t) {
      hoverAt = t
      drawHover()
    },
    setLine(nextLine, nextTrack, nextOver, nextAnchors, nextMesh, nextOthers) {
      const old = ground.geometry
      ground.geometry = geometryOf(nextMesh)
      old.dispose()
      line = nextLine
      track = nextTrack
      overTrack = nextOver
      anchors = nextAnchors
      others = nextOthers
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
      disposeProps(propsRoot)
      others = []
      drawOthers(1)
      for (const g of [
        ground.geometry, buildings.geometry, canopy.geometry, spanMesh.geometry, trackMesh.geometry, overMesh.geometry,
        ballGeom, hoverBall.geometry, hoverDrop.geometry,
        ...stems.map((m) => m.geometry),
      ]) {
        g.dispose()
      }
      for (const l of labels) {
        ;(l.material as SpriteMaterial).map?.dispose()
        ;(l.material as SpriteMaterial).dispose()
      }
      orthoMap.value?.dispose()
      for (const m of [
        groundMat, buildingMat, canopyMat, spanMat, trackMat, overMat, otherMat,
        ...balls.map((b) => b.material), stemMat.wood, stemMat.metal, hoverBall.material as MeshBasicMaterial,
        hoverDrop.material as LineDashedMaterial,
      ]) {
        m.dispose()
      }
      renderer.dispose()
    },
  }
}
