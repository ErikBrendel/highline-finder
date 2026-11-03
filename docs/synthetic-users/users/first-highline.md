# First-highline longliner — training on park lines, looking for a gap small enough to survive

Rigs 100–150 m longlines in a park to train, owns a few hundred euros of tensioning gear, and wants
a first real gap. Height is not the constraint — a first highline can be a kilometre in the air, and
nobody rigs a shorter line because it is lower. Length is: a line longer than the webbing in the bag
cannot be rigged at all, by anyone, ever. Every tool in the sport ranks lines by how good they are,
and part of "good" is simply "long", which is the one axis this person cannot move on.

- **Why this persona:** the only one arriving with a hard cap on what they can rig, and so the only
  one for whom most of the dataset is noise. Also the only one who has never rigged a highline, so
  the only one who reads the numbers without already knowing what they ought to say.
- **Merged from:** longliner working up to a first highline, gear-constrained improviser (whether a
  span is short enough for what they actually own), the customers of commercial highline courses
- **Device:** phone, because this gets looked at in gaps during the day. Emulate as `Pixel 7`.
- **Tech comfort:** medium.
- **Sources:** https://www.reddit.com/r/Slackline/comments/1ur6fw4/ , https://www.reddit.com/r/Slackline/comments/1vjdevr/ , https://www.oneinchdreams.com/en/slackline-highline-courses

## Context
Comfortable on a 100 m longline in a park, has never rigged over a gap. Owns one length of webbing
and a set of pulleys, and that length is the whole of what is possible: a 300 m span is not
ambitious, it is equipment they do not have. Would go with someone experienced — that part is not
in doubt — but the trip has to be worth that person's weekend.

## How they do it today
Asking in the club, and going along to whatever someone else rigs. That works, and it is slow: it
waits on an experienced rigger having both the time and a reason to go. A shortlist of real spans
within the gear, to take to that person, would be genuinely new — which is why the failure mode
here is the tool handing them lines they cannot rig.

## Goals and frustrations
- Find gaps the webbing in the bag can actually span.
- Understand what the two ends are, since a tree they can sling is the difference between a plan
  and a daydream.
- Have something concrete enough that an experienced rigger would agree to come along.
- Not be made to feel the small line is the wrong line.

## User stories
### S1 — Anything near me at all
- **Arrives:** the bare tool, on the phone, in a gap during the day.
  `http://localhost:5173/highline-finder/`
- **Device:** Pixel 7
- **Wants:** "Is there a gap anywhere near me I could actually rig?"
- **Done when:** they have a specific line on screen and know roughly where it is.
- **Gives up when:** the opening screen is a map of a whole state and gives them no first move.
- **Without the tool:** asking in the club, which works but waits on someone else's weekend.

### S2 — What is in the bag
- **Arrives:** continuing from S1, with one hundred metres of webbing and no more.
- **Device:** Pixel 7
- **Wants:** "Hide everything I cannot physically rig."
- **Done when:** they have set an upper length bound and are looking only at lines that fit the
  gear. About 5,000 of the 22,371 natural lines are 120 m or under, so there is plenty to find.
- **Gives up when:** the upper bound cannot be found. Length is one track with two handles, and
  whether the second handle is grabbable with a thumb is the thing to watch.
- **Without the tool:** a rule of thumb, and disappointment on arrival.

### S3 — What the number means
- **Arrives:** having found a line inside the gear limit. Its score is lower than the ones they
  scrolled past.
- **Device:** Pixel 7
- **Wants:** to know whether a lower number means a worse line or just a shorter one.
- **Done when:** they can tell which part of the score they are looking at. Length is 15 of the 100
  points and is simply span over the 500 m maximum, so a 100 m line gives up about twelve points
  for being short — nothing to do with whether it is safe to rig.
- **Gives up when:** they read the number as a verdict and go looking for a higher one, which means
  going looking for a longer line than they own webbing for.
- **Without the tool:** nobody ranks lines today, so there is no number to misread. This confusion
  is one the product introduces.

### S4 — What is at the two ends
- **Arrives:** with that line open, deciding whether to put it in front of an experienced rigger.
- **Device:** Pixel 7
- **Wants:** "What am I tying to? Trees? How big? Can I get to both ends?"
- **Done when:** they can say what each anchor stands on and roughly what it is.
- **Gives up when:** the ends are two coordinates and a height and nothing about what is there — in
  which case the whole trip is still a guess and the tool has saved nothing.
- **Without the tool:** going and standing there, or satellite imagery, which is what they would do
  anyway.

### S5 — Showing it to someone who knows
- **Arrives:** at the end, having found one or two candidates.
- **Device:** Pixel 7
- **Wants:** to send it to the club's experienced rigger in a way that survives the sending.
- **Done when:** a link is in the chat app, and what the other person opens says enough to get a
  yes or a no.
- **Gives up when:** getting the link out of the browser on a phone is more effort than describing
  the place in words.
- **Without the tool:** "there's a gap near the quarry, want to look at it?" — which is the status
  quo, and it is not bad. The tool only wins if what arrives is more convincing than that sentence.
