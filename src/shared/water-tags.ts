import type { OsmKind } from './osmBlocks.js'

/**
 * Which water tags are worth drawing, and as what.
 *
 * Kept apart from the tool that builds the blocks because it is the definition of water for the
 * whole project: whatever classifies OpenStreetMap has to agree with it, or a lake is a lake in one
 * place and dry land in another.
 */
export function waterKind(tags: Record<string, string>): OsmKind | null {
  if (tags.natural === 'water') return 'water'
  if (tags.waterway === 'riverbank') return 'water'
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return 'water'
  // Rivers and streams as lines, for the chart to draw where there is no polygon.
  if (tags.waterway === 'river' || tags.waterway === 'canal') return 'waterway'
  return null
}
