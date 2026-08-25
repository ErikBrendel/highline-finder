import type { Pos } from './grid.js'
import type { Roofs } from './anchoring.js'
import type { Crossing } from './types.js'

/**
 * Everything besides the two elevation rasters that a line is measured against.
 *
 * One bag rather than a growing tail of positional arguments, because these always travel together:
 * both the search and the interactive planner need the same answer to "what is standing here" and
 * "what passes underneath", and every stage that measures a line has to be handed both or it
 * measures a different line from the one beside it.
 *
 * Every field is optional and absent means the layer is unavailable, not that it is empty --
 * which is only safe because both layers can only ever *remove* candidates. A missing city model
 * costs roof anchors; a missing road network costs the clearance surcharge over traffic. Neither
 * invents a line that would not otherwise exist. Where that distinction matters to a person, the
 * caller says so: the planner tells the user its road data failed rather than quietly passing a
 * line four metres over a Bundesstraße.
 */
export interface Scene {
  /** Where buildings stand, so a roof can be told from a hill once the two are merged. */
  roofs?: Roofs | null
  /** What carries traffic, so a line over it can be held to the height that needs. */
  roads?: Roads | null
}

/** Whatever can say where a span passes over something that carries traffic. */
export interface Roads {
  crossings(a: Pos, b: Pos): Crossing[]
}
