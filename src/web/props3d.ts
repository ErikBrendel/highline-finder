import {
  BoxGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  Group,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three'

/**
 * Two things of a known size, to stand on the ground beside a line.
 *
 * A picture of a hillside carries no scale of its own. The same shape is a bank at the end of a
 * garden or the side of a valley, and the numbers beside the view do not fix it -- reading "42 m of
 * exposure" and *seeing* forty-two metres are different things, and it is the second one that tells
 * you whether you want to walk it. A figure and a car do fix it, because everyone already knows how
 * big those are.
 *
 * Built from boxes and cylinders rather than loaded from a model. The whole point is the dimensions,
 * and the dimensions are the easy part: a person is 1.8 m and a big alcove camper is 7 m by 2.3, and
 * a silhouette at that size on a hillside three hundred metres across is a few pixels of shape.
 * A model file would cost a loader, a fetch and a place to put the asset, and buy detail nothing can
 * see. Every figure below is in metres, so the group can be dropped straight into a scene whose
 * units are metres.
 */

/**
 * Real sizes, so the comment above can be checked against the geometry.
 *
 * A big alcove motorhome, not a panel van. The length is a real one -- the Dethleffs Trend A 6877
 * is 6.99 m -- and the width and height are the usual coachbuilt figures rather than any one spec
 * sheet: the Fiat Ducato chassis these are built on is 2.05 m wide and up to 2.77 m tall as a van,
 * and the body overhangs it on both counts.
 */
export const REFERENCE = {
  person: { height: 1.8 },
  van: { length: 6.99, width: 2.3, height: 2.95 },
} as const

const SKIN = '#d9a066'
const CLOTH = '#3f6ea8'
const VAN = '#e8e4dc'
const VAN_TRIM = '#7c8797'
const TYRE = '#20242c'
const GLASS = '#4a5a6e'

/**
 * A standing figure, feet at y = 0, facing down +X.
 *
 * Legs and arms separately rather than one block with a head on it: at a few pixels the thing that
 * says "person" is the outline, and the outline of a person has a gap between the legs and arms
 * held clear of the body. Everything above the hips is one width, so the shape reads the same from
 * every side -- a figure that looked right only from the front would be worse than a box.
 */
function person(): Group {
  const g = new Group()
  const cloth = new MeshLambertMaterial({ color: CLOTH })
  const skin = new MeshLambertMaterial({ color: SKIN })
  const at = (geom: BufferGeometry, mat: MeshLambertMaterial, x: number, y: number, z: number) => {
    const m = new Mesh(geom, mat)
    m.position.set(x, y, z)
    g.add(m)
  }

  // 0.86 of leg, 0.56 of trunk, a neck and a head: 1.80 m to the crown.
  const leg = new BoxGeometry(0.17, 0.86, 0.17)
  at(leg, cloth, 0, 0.43, -0.10)
  at(leg, cloth, 0, 0.43, 0.10)
  at(new BoxGeometry(0.24, 0.30, 0.40), cloth, 0, 1.01, 0)
  at(new BoxGeometry(0.26, 0.34, 0.44), cloth, 0, 1.33, 0)
  const arm = new BoxGeometry(0.13, 0.60, 0.13)
  at(arm, skin, 0, 1.20, -0.28)
  at(arm, skin, 0, 1.20, 0.28)
  at(new CylinderGeometry(0.055, 0.055, 0.08, 8), skin, 0, 1.54, 0)
  at(new SphereGeometry(0.115, 12, 10), skin, 0, 1.68, 0)
  return g
}

/**
 * A big alcove camper, wheels on the ground and its length along +X.
 *
 * One extruded side profile rather than a stack of boxes. Boxes gave it square corners and, worse,
 * faces that landed exactly on each other -- two surfaces in the same plane are a coin toss for the
 * depth buffer, which is what made the wheels flicker. A single shape has no internal faces at all,
 * and a bevel on the extrusion rounds every edge of it at once.
 *
 * The profile is what makes it a camper rather than a lorry: the roof runs forward over the cab as
 * the alcove, its nose is the furthest-forward point of the whole vehicle, and the windscreen is
 * tucked back underneath it.
 */
function van(): Group {
  const g = new Group()
  const shell = new MeshLambertMaterial({ color: VAN })
  const trim = new MeshLambertMaterial({ color: VAN_TRIM })
  const glass = new MeshLambertMaterial({ color: GLASS })
  const rubber = new MeshLambertMaterial({ color: TYRE })
  const { length, width, height } = REFERENCE.van
  const bevel = 0.09
  // The bevel grows the shape outward on every side, so the profile is drawn that much inside the
  // real dimensions and comes out at exactly them.
  const nose = length / 2 - bevel
  const roof = height - bevel
  const floor = 0.72 + bevel

  /**
   * The side, rear to front, in metres from the middle of the vehicle and up from the ground.
   *
   * The alcove is the whole reason this outline is not a box, and it has to be short and steep: a
   * bunk hanging over the cab, its nose the furthest-forward point of the vehicle, overhanging the
   * windscreen by about a third of a metre. Drawn long and shallow -- which it was, running 1.75 m
   * forward while dropping 0.42 -- it stops being an alcove and becomes a sloped roof over the front
   * quarter, which is a different vehicle entirely.
   *
   * And the windscreen rakes the way a windscreen does, its top tucked back under the alcove lip and
   * its base forward at the bonnet. It used to run 1.12 m *backwards* from the nose before the
   * bonnet jutted forward again, which is not a notch but a gash.
   */
  const side = new Shape()
  side.moveTo(-nose, floor)
  side.lineTo(-nose, roof)
  side.lineTo(nose * 0.86, roof)
  side.lineTo(nose, roof - 0.55)
  side.lineTo(nose * 0.90, roof - 1.05)
  side.lineTo(nose * 0.97, floor + 0.55)
  side.lineTo(nose, floor + 0.35)
  side.lineTo(nose * 0.98, floor)
  side.closePath()

  const body = new Mesh(
    new ExtrudeGeometry(side, {
      depth: width - bevel * 2,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 2,
    }),
    shell,
  )
  // Extrusion runs from z = 0 forwards, so the body is walked back onto the middle of its own width.
  body.geometry.translate(0, 0, -(width - bevel * 2) / 2)
  g.add(body)

  // Standing proud of the sides rather than flush with them, for the reason the shape is one piece.
  const stick = (geom: BufferGeometry, mat: MeshLambertMaterial, x: number, y: number) => {
    for (const z of [width / 2, -width / 2]) {
      const m = new Mesh(geom, mat)
      m.position.set(x, y, z)
      g.add(m)
    }
  }
  stick(new BoxGeometry(length * 0.34, 0.52, 0.04), glass, -length * 0.14, roof - 0.62)
  stick(new BoxGeometry(length * 0.70, 0.10, 0.05), trim, -length * 0.10, floor + 0.06)

  const wheel = new CylinderGeometry(0.42, 0.42, 0.24, 14)
  for (const x of [length * 0.30, -length * 0.24]) {
    for (const z of [width / 2 - 0.3, -(width / 2 - 0.3)]) {
      const w = new Mesh(wheel, rubber)
      // Rolled onto its side: a cylinder stands on its end until it is told otherwise.
      w.rotation.x = Math.PI / 2
      w.position.set(x, 0.42, z)
      g.add(w)
    }
  }
  return g
}

/**
 * Both references, a few metres apart, with the group's origin on the ground between them.
 *
 * Side by side rather than one behind the other, so neither hides the other whichever way the camera
 * is looking -- and offset across +Z rather than along +X so the pair reads as a row from most
 * angles rather than as a queue.
 */
export function referenceProps(): Group {
  const g = new Group()
  const figure = person()
  figure.position.z = -2.9
  const vehicle = van()
  vehicle.position.z = 2.0
  g.add(figure, vehicle)
  return g
}

/** Frees the geometry and materials of a group built here. */
export function disposeProps(g: Group): void {
  const seen = new Set<BufferGeometry | Material>()
  g.traverse((o) => {
    const m = o as Mesh
    if (!m.isMesh) return
    for (const part of [m.geometry, m.material as Material]) {
      if (part && !seen.has(part)) {
        seen.add(part)
        part.dispose()
      }
    }
  })
}
