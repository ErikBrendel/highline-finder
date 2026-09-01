/**
 * How much of the header to spell out, measured rather than guessed.
 *
 * The header is a logo, a title and two external links, and on a narrow screen they do not fit.
 * Which of them to abbreviate is a design decision; *when* is arithmetic on the width of a dozen
 * words in whatever font the reader's system supplies -- so it is asked of the browser, on the real
 * element, rather than written down as breakpoints and hoped for.
 *
 * The question asked is the direct one: put the row in a given state and see where its last item
 * ends. Two proxies were tried before this and both lied. `max-content` on the header came out well
 * over what the row needed, and collapsed it with a hundred and sixty spare pixels on screen;
 * `scrollWidth` came out as exactly `clientWidth`, because for an `overflow: visible` box that is
 * what browsers report, so every rung looked too wide and the row collapsed to nothing at any
 * width. A rectangle is not a proxy: the guide button's right edge is where the words end.
 *
 * The spacer has to be stopped for the duration. It is `flex: 1`, so ordinarily it eats whatever
 * room the words leave and the last item sits against the right edge no matter how little is being
 * said. Frozen, the items pack to the left and the edge means something.
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

/** Room to keep between the two halves of the row, so a fit is not a collision. */
const SLACK = 24

/**
 * The first rung that fits, or the bottom of the ladder when none of them does.
 *
 * The answer depends only on what `fits` reports, never on the rung currently applied, which is
 * what keeps a resize from oscillating between two of them.
 */
export function fitLevel(rungs: number, fits: (level: number) => boolean): number {
  for (let level = 0; level < rungs; level++) if (fits(level)) return level
  return rungs
}

export function fitHeader(header: HTMLElement): () => void {
  const apply = () => {
    const last = header.lastElementChild
    if (!last) return
    const padRight = parseFloat(getComputedStyle(header).paddingRight) || 0
    header.dataset.measuring = '1'
    // The inside of the right padding: where the row runs out of room.
    const edge = header.getBoundingClientRect().right - padRight
    const level = fitLevel(LADDER.length, (i) => {
      header.dataset.fit = LADDER.slice(0, i).join(' ')
      return last.getBoundingClientRect().right + SLACK <= edge
    })
    delete header.dataset.measuring
    header.dataset.fit = LADDER.slice(0, level).join(' ')
  }
  apply()

  const resize = new ResizeObserver(apply)
  resize.observe(header)
  // The row also changes when its contents do -- the Google Maps link appears only once the map has
  // published a viewport to link to -- and that changes no size the ResizeObserver is watching.
  // childList only: `apply` writes an attribute, and observing attributes would have it chase
  // itself round.
  const content = new MutationObserver(apply)
  content.observe(header, { childList: true, subtree: true })

  return () => {
    resize.disconnect()
    content.disconnect()
  }
}
