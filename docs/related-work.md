# Related Work

Pattern Bridge sits at the intersection of two research and product lineages:
(1) proactive, context-aware information delivery on personal devices, and
(2) passive behavior-log capture for personal analytics ("lifelogging"). This
section reviews representative systems in both lineages and positions Pattern
Bridge's design choices — a local three-algorithm ensemble with explicit
per-algorithm confidence, coupled to a conversational LLM agent rather than a
static notification surface — against them.

## 1. Google Now (2012–2019)

Google Now introduced the "context card": a feed of proactively surfaced
information (traffic, weather, upcoming events, sports scores) inferred from
a user's search history, location, and calendar, delivered without an
explicit query. It was the first mainstream system to popularize the
predict-and-surface paradigm that Pattern Bridge also pursues.

Google Now was discontinued in 2019, folded into the more reactive Google
Assistant / Discover feed. Post-mortems and user research from the period
converge on two failure factors:

- **Trust erosion under imprecise prediction.** Because cards were surfaced
  silently and continuously, a string of irrelevant or stale cards degraded
  user trust in the whole feed rather than being dismissed as isolated
  errors — there was no mechanism for the system to learn from a single
  rejection.
- **Privacy concern over the breadth of signals used.** Cross-referencing
  search, location, and email content to justify a single card made the
  *reasoning* opaque, which amplified discomfort even when the prediction
  itself was accurate.

**Difference from Pattern Bridge.** Pattern Bridge (a) attaches an explicit,
decomposable confidence score to every detection (Bayesian / PrefixSpan / FFT
sub-scores, not just a final number), so a wrong prediction is auditable
rather than a black box, and (b) processes exclusively on-device — there is
no server-side cross-referencing of unrelated signal types.

## 2. iOS Siri Suggestions / App Shortcuts

Apple's on-device suggestion system (Siri Suggestions in Spotlight/Lock
Screen, and the App Shortcuts / App Intents framework) learns per-app,
per-time, per-location usage routines entirely on-device via Core ML, and
surfaces a shortcut or widget without a server round-trip. It remains in
production today, which suggests the on-device, narrow-scope approach is
more durable than Google Now's server-side, broad-scope one.

Its recognized limitation is precision-driven disengagement: suggestions
are low-friction to ignore (a single unused tile), so when precision is
mediocre, users habitually stop glancing at the suggestion row rather than
uninstalling anything — the feature degrades to inert UI rather than failing
loudly. This makes its real-world precision difficult to audit externally,
since silent disengagement produces no error signal.

**Difference from Pattern Bridge.** Pattern Bridge does not rely on passive
UI real estate that can be silently ignored; a detected pattern's absence
(a "miss") triggers an explicit conversational message through an LLM agent
(OpenClaw), and — via the `notification_log` feedback loop introduced in
this work — every notification's correctness is captured as an explicit
👍/👎 signal rather than inferred from non-engagement.

## 3. Rewind.ai

Rewind (and its successor, Limitless) continuously records the screen and
audio, builds a searchable local index, and layers LLM summarization /
question-answering on top. Architecturally, its data-collection layer is the
closest analogue to Pattern Bridge's collectors: both capture window/app
context continuously and store it locally before any AI processing.

The key divergence is what is captured and what leaves the capture stage.
Rewind's value proposition depends on raw, replayable content (a searchable
recording of everything seen), which is precisely the design decision Pattern
Bridge avoids.

**Difference from Pattern Bridge.** Pattern Bridge never captures screen
content, audio, or keystroke content — it captures structured, low-dimensional
event metadata (window title, app name, URL, keystroke *count*) sufficient
for statistical pattern mining but not sufficient to reconstruct what was
read, typed, or said (see `docs/privacy-design.md`). Only the output of
pattern detection — an abstracted signal like "Chrome usually opens at 09:00,
32 minutes overdue" — is ever transmitted off-device, never the underlying
window/URL log.

## 4. Reclaim.ai / Motion

These calendar-scheduling assistants learn a user's recurring commitments
(focus blocks, habits, meeting patterns) from calendar history and
automatically re-schedule or defend time for them. Like Pattern Bridge, they
operate on a single structured data source (the calendar) and use historical
recurrence to predict future need — but the data source is explicit,
user-authored calendar events rather than passively observed device usage,
which sidesteps most of the privacy and precision problems above at the cost
of only modeling what the user already scheduled.

**Difference from Pattern Bridge.** Pattern Bridge's signal is *derived*
usage behavior (which apps are opened when, in what sequence, with what
periodicity) rather than user-declared intent, so it can surface routines
the user never explicitly scheduled — at the cost of needing the confidence
machinery (Section on the three-algorithm ensemble) that a calendar-based
system does not need, since a calendar entry is already ground truth.

## Summary

| System | Signal source | Processing location | Delivery surface | Confidence exposed to user |
|---|---|---|---|---|
| Google Now | Search / location / calendar | Server | Passive card feed | No |
| Siri Suggestions | On-device app usage | On-device | Passive UI tile | No |
| Rewind.ai | Full screen/audio recording | Local (raw), cloud LLM for Q&A | Search / chat | N/A (retrieval, not prediction) |
| Reclaim.ai / Motion | Calendar events | Cloud | Auto-scheduled blocks | No |
| **Pattern Bridge** | Window/app/URL/keystroke-count events | **Local only** | **Conversational LLM agent (OpenClaw)** | **Yes — per-algorithm + ensemble score, with logged outcome feedback** |

Three design choices distinguish Pattern Bridge from all five predecessors
simultaneously: (1) prediction results are delivered through a conversational
LLM agent capable of contextual follow-up, not a static card or silent UI
element; (2) all collection, analysis, and storage occurs on the user's own
machine, with only abstracted pattern-detection results — never raw
window/URL/keystroke logs — leaving the device; and (3) every alert carries
an explicit, decomposed confidence score (Bayesian time-of-day, PrefixSpan
sequence support, FFT periodicity) rather than a single opaque number,
enabling the precision evaluation introduced in this work
(`notification_log`, `scripts/eval-report.ts`, `scripts/run-ablation.ts`).
