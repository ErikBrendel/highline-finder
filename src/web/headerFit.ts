/**
 * How much of the header to spell out, measured rather than guessed.
 *
 * The header is a logo, a title and two external links, and on a narrow screen they do not fit.
 * Which of them to abbreviate is a design decision; *when* is arithmetic on the width of a dozen
 * words in whatever font the reader's system supplies -- so it is done by asking the browser once,
 * on the real element, instead of by writing four breakpoints and hoping.
 *
 * The measurement is the whole trick: the header is set to `max-content` and its width read back at
 * each step of the ladder, which is exactly "how wide would I like to be if I said this much". That
 * is five forced reflows in one synchronous block at startup, with no paint in between, and then
 * nothing until the window is resized.
 *
 * Safe with system fonts, which is all this page uses -- there is no web font that could land later
 * and change every number. A page with one would have to measure again after `document.fonts.ready`.
 */

/**
 * What to give up, in the order it can be spared.
 *
 * The GitHub link's word goes first: its initials point at the same place. Then the title, which
 * the logo beside it already says. Then the Google Maps link. The title disappears altogether only
 * at the end, because the links are the only way to reach what they point at and the title is not
 * a way to reach anything.
 */
const LADDER = ['gh', 'hf', 'gm', 'notitle'] as const

/** Gap to keep between the two halves of the row, so a fit is not a collision. */
const SLACK = 24

/**
 * The fewest concessions that fit, given what each step of the ladder costs.
 *
 * `need[i]` is the width the header wants after `i` steps, so it descends. The answer depends only
 * on `have`, never on the step currently applied, which is what keeps a resize from oscillating
 * between two of them.
 */
export function fitLevel(need: number[], have: number): number {
  for (let i = 0; i < need.length; i++) if (need[i]! + SLACK <= have) return i
  return need.length - 1
}

function measure(header: HTMLElement): number[] {
  const heldFit = header.dataset.fit
  const heldWidth = header.style.width
  header.style.width = 'max-content'
  const need = LADDER.map((_, i) => {
    header.dataset.fit = LADDER.slice(0, i).join(' ')
    return header.offsetWidth
  })
  // One more for the bottom of the ladder, which is every concession made.
  header.dataset.fit = LADDER.join(' ')
  need.push(header.offsetWidth)

  header.style.width = heldWidth
  if (heldFit === undefined) delete header.dataset.fit
  else header.dataset.fit = heldFit
  return need
}

export function fitHeader(header: HTMLElement): () => void {
  const need = measure(header)
  const apply = () => {
    // The header is a full-width row whatever it is saying, so its own width is the room available
    // and applying a step cannot change it. No feedback, and so no loop for the observer to chase.
    header.dataset.fit = LADDER.slice(0, fitLevel(need, header.offsetWidth)).join(' ')
  }
  apply()
  const observer = new ResizeObserver(apply)
  observer.observe(header)
  return () => observer.disconnect()
}
