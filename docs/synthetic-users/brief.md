# Brief — Highline Finder

A map of candidate [highline](https://en.wikipedia.org/wiki/Slacklining#Highlining) locations, found
automatically by measuring the public LiDAR survey of Berlin and Brandenburg instead of scanning maps
by eye. Anywhere else in Germany, the user can place two anchors by hand and have the span measured
against the real ground.

## Start and URL
- `npm run dev` in the repo root → <http://localhost:5173/highline-finder/> (a dev server may already
  be running; `curl` it before starting a second one). The dev build shows a "D" favicon.
- Deployed: <https://erikbrendel.github.io/highline-finder/>, GitHub Pages from the public repo.
- No accounts, no login, nothing to install. Everything is in the URL or in the browser's local storage.
- Test data is the shipped dataset, generated 2026-08-31: 22,371 natural and 3,317 urban candidate
  lines across 560 searched regions. It does not change between runs.
- A shared link to one line, for the arrival this run is mostly about:
  `http://localhost:5173/highline-finder/?at=51.876,14.565,51.884,14.575&line=470422.5_5747566.5__470232.5_5748022.5&full=1`

## Main features (as a user sees them)
- **The map:** candidate lines drawn in red from a district-wide zoom inward; below that zoom they
  collapse into clustered "hotspots". Background is a slider between orthophoto (satellite),
  hillshade and OSM, or a mix of them.
- **A line's details:** clicking a line opens a card with its elevation profile — terrain, canopy,
  buildings, water, roads — plus length, sag, exposure, clearance and a 0–100 score.
- **Full-screen view:** the same card filling the window, with the profile at full width and a 3D
  view of the site below it. A link can be sent from this view and opens straight into it.
- **Natural and urban:** natural lines have both ends on the ground and cover the whole state; urban
  lines have one end on a roof, exist only inside outlined rectangles, and never in Berlin, whose
  building model the state does not publish.
- **Filters:** score, length, exposure, canopy, offlevel, anchor class, and a sag slider that
  re-measures every line against the terrain.
- **Lines of your own:** drag either anchor of a selected line and it re-measures as it moves;
  right-click the map for "Set custom point A / B" to plan a span anywhere in Germany. An "optimise"
  button searches for something better nearby. Rig heights per end.
- **Orientation:** a crosshair button centres the map on the device's location; a "Google Maps ↗"
  link opens the same view in satellite imagery; an "i" button opens the guide.
- **The guide:** a panel saying what this is, where the data comes from, and what it cannot tell you.
  Open on a first visit, and whether it is open survives a reload.

## Who it is for
People who rig highlines, in a region — the North German plain — that is not obviously highline
country, where the lines that exist are found by someone walking around and looking up. It is also
read by people who do not rig: the ones a line gets sent to.

## How people arrive
- **A shared link**, almost always. The address bar follows the view, so every link carries a
  viewport, often a selected line, and sometimes `full=1` — the full-screen view of one line. This is
  the arrival the product was asked about and the one it has been designed for least.
- The GitHub repo, for people who find the project rather than a line.
- No search presence, no app store, no invites, no mailing list.

## Environment limits
Testers should not count these against the product:
- On `http://localhost` the dev server proxies Saxony-Anhalt's survey; in a build it is fetched
  directly. Both work — but a Saxony-Anhalt failure seen locally is a test-setup artefact.
- Saxony's survey (GeoSN) sends no CORS header, so its orthophoto and elevation are blocked in the
  browser on the deployed site too. This is a real product limitation, not a test artefact: report it.
- Local data is served from disk. The deployed site ships a 16 MB payload, 3 MB of it the line
  dataset, so a first load on a phone over mobile data is far slower than anything this test will
  see. Slow-first-load findings cannot come out of this run.
- Pinch-zoom and other multi-touch gestures cannot be emulated. Map zoom has to go through the
  on-screen +/- buttons or the scroll wheel.
- Elevation for a hand-planned line is fetched live from state survey services on first touch of an
  area, and can take seconds. That is the product's real behaviour, not the setup.
- The geolocation crosshair has no real fix in a headless browser.

## Privacy
The repo is public and `docs/` is committed, though it is not deployed — the Pages build serves
`dist/` only. Personas here are therefore fictional and must stay so: no profiles of real, named
people, and nothing a real person could be identified from.
