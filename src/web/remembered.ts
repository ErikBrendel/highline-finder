import { useState } from 'react'
import { report } from './report.js'

/**
 * A switch whose position outlives the page.
 *
 * Two of them: whether the guide is open and whether the filter panel is. Both are the same kind of
 * thing -- a choice about the workspace rather than about the map -- so neither belongs in the URL,
 * which is for what a link should show someone else.
 *
 * localStorage throws rather than returning null in a browser configured to refuse it -- private
 * windows, third-party contexts, storage blocked outright -- so both directions are guarded and the
 * caller's fallback stands. Failing open is the harmless way to be wrong here: a reader who cannot
 * be remembered gets the panel again, where an unguarded read would take the page down.
 */

export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const held = localStorage.getItem(key)
    return held === null ? fallback : held === '1'
  } catch (e) {
    report(`reading the remembered ${key}`, e)
    return fallback
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch (e) {
    report(`remembering ${key}`, e)
  }
}

/** `useState` for a boolean, with the last value read back on the next visit. */
export function useRemembered(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(key, fallback))
  return [
    value,
    (to: boolean) => {
      writeFlag(key, to)
      setValue(to)
    },
  ]
}
