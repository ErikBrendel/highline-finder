import { readFlag, writeFlag } from './remembered.js'

const KEY = 'highline-finder.dev'

/**
 * Whether the automated search is shown: found lines, hotspots, filters and the searched areas.
 *
 * Off by default, because the search is work in progress and the tool without it -- placing a line
 * by hand and sending it to someone -- is the part that is ready for people. On by default on the
 * dev server, where the search is what is being worked on.
 *
 * Fixed for the life of the page. Switching it reloads, so nothing has to cope with the dataset
 * arriving or vanishing under a line that is already open.
 */
export const DEV_MODE = readFlag(KEY, import.meta.env.DEV)

export function setDevMode(on: boolean): void {
  writeFlag(KEY, on)
  location.reload()
}
