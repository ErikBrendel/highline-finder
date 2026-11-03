# First-highline longliner — training on park lines, looking for a gap small enough to survive

Rigs 100–150 m longlines in a park to train, owns a few hundred euros of tensioning gear, and wants
a first real gap. What they need is the opposite of impressive: short, low, close to a road, nothing
underneath that punishes a mistake. Every tool in the sport, this one included, ranks lines by how
good they are — and "good" means long and high, which is exactly what this person must avoid.

- **Why this persona:** the only one whose goal runs against the product's ranking. If the score, the
  sliders and the map cannot be made to surface a small, dull, safe line, that is a finding no other
  persona can produce. Also the only one for whom the gear they own is a hard constraint on length.
- **Merged from:** longliner working up to a first highline, gear-constrained improviser (whether a
  span is short enough for what they actually own), the customers of commercial highline courses
- **Device:** phone, because this gets looked at in gaps during the day. Emulate as `Pixel 7`.
- **Tech comfort:** medium.
- **Sources:** https://www.reddit.com/r/Slackline/comments/1ur6fw4/ , https://www.reddit.com/r/Slackline/comments/1vjdevr/ , https://www.oneinchdreams.com/en/slackline-highline-courses

## Context
Comfortable on a 100 m longline in a park, has never rigged over a gap, and is looking for the one
that will not be the last. Owns one length of webbing and a set of pulleys: a line longer than what
is in the bag is not a stretch goal, it is impossible. Everything in the sport points the other way
— the photos, the records, the lines people post — and the people who could judge a first gap are
the same people who find the small ones boring.

## How they do it today
Asking in the club, and going along to whatever someone else rigs. That works, and it is slow: it
depends on someone experienced having both the time and a reason to go to a small, dull spot. A tool
that could hand them a shortlist to take to that person would be genuinely new — which is why the
failure mode here is the tool handing them something impressive instead.

## Goals and frustrations
- Find a short gap, low over soft ground, that the gear in the bag can actually span.
- Not be sold the best line. The best line is the one they must not rig first.
- Work out what is underneath before going, since that is what a mistake lands in.
- Have something concrete to show the experienced rigger who would come along.

## User stories
### S1 — Something small, near me
- **Arrives:** the bare tool, on the phone, in a gap during the day.
  `http://localhost:5173/highline-finder/`
- **Device:** Pixel 7
- **Wants:** "Is there a short, low gap anywhere near me?"
- **Done when:** they have a line on screen under about 120 m and under about 20 m of air, and know
  roughly where it is. The data holds about five thousand such lines, so this story failing is a
  surfacing failure, not an absence.
- **Gives up when:** the opening screen shows the long spectacular ones and offers no way to ask for
  the opposite.
- **Without the tool:** asking in the club, which works but waits on someone else's weekend.

### S2 — What is in the bag
- **Arrives:** continuing from S1, with one hundred metres of webbing and no more.
- **Device:** Pixel 7
- **Wants:** "Hide everything I cannot physically rig."
- **Done when:** they have set an upper length bound and are looking only at lines that fit the gear.
- **Gives up when:** the upper bound cannot be found. Length is one track with two handles, and
  whether the second handle is grabbable with a thumb is the thing to watch.
- **Without the tool:** a rule of thumb and disappointment on arrival.

### S3 — The score says this line is mediocre
- **Arrives:** having found exactly what they wanted: short, low, dull. Its score is around 60; the
  best in the dataset is 88.
- **Device:** Pixel 7
- **Wants:** to know whether a middling score means a bad line or a small one.
- **Done when:** they can tell that the score ranks spectacle, not safety, and that a low score is
  not a warning.
- **Gives up when:** they read 60-out-of-88 as "this line is poor" and go looking for a higher
  number — which, for a first highline, is the most dangerous thing this product could cause.
- **Without the tool:** nobody ranks lines today, so there is no number to misread. This frustration
  is one the tool introduces.

### S4 — What is actually underneath
- **Arrives:** with that line open, before deciding to go and look.
- **Device:** Pixel 7
- **Wants:** "Is that water, a road, brambles or a field? Is the ground even down there?"
- **Done when:** they have read the ground profile and can say what a fall would be over.
- **Gives up when:** the profile is a chart without units or landmarks and they cannot connect it to
  the map above it.
- **Without the tool:** going and standing there, which they will do anyway — the tool is only
  deciding whether the trip is worth it.

### S5 — Asking for less air
- **Arrives:** trying to narrow to the lowest thing they can find.
- **Device:** Pixel 7
- **Wants:** "Show me nothing higher than fifteen metres."
- **Done when:** they have worked out what the exposure control can and cannot do for them. It sets
  a minimum only, so "at least this much air" is expressible and "at most" is not — the one thing
  this person wants to say to the tool is the one thing it has no control for.
- **Gives up when:** they move the exposure slider, watch the low lines disappear instead of the
  high ones, and conclude the tool is for other people.
- **Without the tool:** the club picks the spot. Worth knowing as well: the search itself never
  looked below ten metres of air, so the beginner band is outside the dataset by construction, not
  merely unfiltered.
