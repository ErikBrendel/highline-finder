import type { OsmKind } from './osmBlocks.js'

/**
 * Which water tags are worth drawing, and as what.
 *
 * Shared, because two things now classify OpenStreetMap: the tool that builds the blocks this app
 * ships with, and the browser when it asks Overpass for ground those blocks do not cover. If the
 * two disagreed, a lake would be a lake on one side of a state border and dry land on the other.
 */
export function waterKind(tags: Record<string, string>): OsmKind | null {
  if (tags.natural === 'water') return 'water'
  if (tags.waterway === 'riverbank') return 'water'
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return 'water'
  // Rivers and streams as lines, for the chart to draw where there is no polygon.
  if (tags.waterway === 'river' || tags.waterway === 'canal') return 'waterway'
  return null
}
