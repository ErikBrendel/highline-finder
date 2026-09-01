import type { IControl, Map as MlMap } from 'maplibre-gl'

/**
 * The "where am I" button, in the map's own control stack beside the zoom buttons.
 *
 * There rather than in the layer column because that is where every map puts it and where a thumb
 * goes looking. It is a plain `IControl` around our own toggle rather than MapLibre's
 * GeolocateControl -- see locate.ts for why that one cannot be used -- so the button reports state
 * it is told about instead of state it owns.
 */

const ICON = `
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="2"/>
    <circle cx="12" cy="12" r="1.7" fill="currentColor"/>
    <path d="M12 1.5v3.6M12 18.9v3.6M1.5 12h3.6M18.9 12h3.6"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`

/** off: not following. busy: following, no position yet. on: following, dot on the map. */
export type LocateState = 'off' | 'busy' | 'on'

const LABEL: Record<LocateState, string> = {
  off: 'Show where I am',
  busy: 'Finding your position…',
  on: 'Stop following your position',
}

export class LocateControl implements IControl {
  private container: HTMLDivElement | null = null
  private button: HTMLButtonElement | null = null
  private state: LocateState = 'off'

  constructor(private readonly onClick: () => void) {}

  onAdd(_map: MlMap): HTMLElement {
    this.container = document.createElement('div')
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group'
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'locate'
    this.button.innerHTML = ICON
    this.button.addEventListener('click', () => this.onClick())
    this.container.appendChild(this.button)
    this.setState(this.state)
    return this.container
  }

  onRemove(): void {
    this.container?.remove()
    this.container = null
    this.button = null
  }

  setState(state: LocateState): void {
    this.state = state
    if (!this.button) return
    this.button.dataset.state = state
    this.button.title = LABEL[state]
    this.button.setAttribute('aria-label', LABEL[state])
    this.button.setAttribute('aria-pressed', String(state !== 'off'))
  }
}
