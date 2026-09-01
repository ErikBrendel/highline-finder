/**
 * Where the device thinks it is, for as long as it is asked.
 *
 * The map opens on a whole federal state and the spot someone came to look at is a village in it,
 * so "start where I am" is the difference between finding it and giving up panning. On a phone it
 * is the whole answer; on a laptop it is at least the right district.
 *
 * A toggle rather than MapLibre's own GeolocateControl, for one reason: that control disables its
 * button permanently once a position request fails, so a tester who refuses the browser's prompt by
 * reflex -- which is what most people do to a prompt -- has no way back. Here the failure switches
 * the toggle off and says what happened, and pressing it again asks again.
 */

export interface Fix {
  lat: number
  lon: number
  /** Radius the browser claims the position is good to, in metres. */
  accuracy: number
}

/**
 * What went wrong, for someone who is not going to open the console.
 *
 * The refusal case has to say where the decision now lives: once a browser has stored "denied" for
 * a site, asking again does not prompt again, it fails silently -- so "press it again" on its own
 * would be advice that cannot work.
 */
export function locateFailure(e: GeolocationPositionError): string {
  if (e.code === e.PERMISSION_DENIED) {
    return 'Location permission was refused. Allow it for this site in the browser’s settings, then try again.'
  }
  if (e.code === e.POSITION_UNAVAILABLE) return 'No position available here — no GPS or network fix.'
  if (e.code === e.TIMEOUT) return 'Locating took too long. Try again, ideally outdoors.'
  return e.message || 'Locating failed.'
}

/** Follows the device until the returned function is called. */
export function watchLocation(onFix: (f: Fix) => void, onFail: (why: string) => void): () => void {
  if (!navigator.geolocation) {
    onFail('This browser does not offer a location.')
    return () => {}
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
    (e) => onFail(locateFailure(e)),
    // High accuracy because the question is which hillside, not which city. The generous timeout is
    // for a cold GPS fix, which outdoors on a phone is routinely ten seconds.
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}
