# JevsBistro reference

The detailed description of the simulation, its evidence rules, planners, metrics, AI adapters, and deliberate abstractions. For a friendly overview with screenshots, start with the [README](../README.md).

## Run locally

Requires Node.js 22.12+ (validated with Node 24).

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. `npm run build` produces static files in `dist/`; `npm run preview` serves the production build. Both dev and preview include the local API adapter. A static-only host supports rules modes but cannot use Jev or the OpenAI proxy. The loopback-only adapter is for local use, not public deployment.

## Explore a service

1. Use **New restaurant** to set table count, rooms, seats, staffing, arrivals, guest-habit percentages, and the scenario seed. Add, remove, or edit menu dishes, courses, prices, and preparation times.
2. Choose the **Planner** (next task or multi-stop) and **Observation source** (local scans or camera snapshots) independently. Choose a floor preset, aisle width, station placement, and bartender count. Configuration is immutable during a run.
3. Click **Run service**. Pause, accelerate playback, orbit the scene, or switch to top-down. Use **Expand view**, **+ / −**, and **Fit** for more space and closer inspection. Right-drag pans the scene.
4. Hover a compact table marker for its state, or click it to inspect individual diners. Enable **On the floor → Speech bubbles** for scripted character dialogue and thoughts tied to the current activity. Servers greet guests, take orders, and check in; diners chat, think about their phones, and ask for help. Rounded speech balloons and cloudy thought balloons are camera-facing 3D sprites anchored above each person: their size scales with the restaurant when you zoom. Bubbles use the scene depth buffer, so nearby surfaces naturally occlude them; overlapping rectangles no longer hide entire bubbles. They pop open and fold closed around their tail tip, using wall-clock animation even while service is paused. Dialogue comes from a local library, with per-character shuffled decks that exhaust a category before repeating. Rapid activity changes are coalesced into the latest line after a short readable hold. This presentation works in either controller mode without API calls or changes to server knowledge. At high playback speeds, dialogue advances with simulation time; pause or slow playback to read it. Route overlays show colored paths, direction arrows, and destination rings; colors match server uniforms. Solid paths show current tasks; dashed paths show planned stops. Staff cards list the remaining itinerary. Staff and journal details expand below the floor.
5. Open **Camera feed** to scrub, step, or play recorded observations. **Back to live** follows new frames. Reviewing history does not rewind the restaurant; a selected frame stays pinned while service continues.
6. Use **Compare servers** for a paired-seed proxy comparison or four-condition rules comparison in a background worker; export individual runs and raw metrics. The current live service is paused and not advanced by the comparison.
7. Choose **Dark view** in the header for dark interface surfaces and adjusted scene lighting. This preference is stored locally. Export a JSON service report to retain a run before resetting.

The arrival window controls when new parties stop arriving. Existing guests continue dining until payment, departure, and table reset. Simulation time pauses when the browser tab is hidden.

**Saved restaurants:** In **New restaurant**, give the setup a name and choose **Save setup**. Select it later and choose **Load setup** to restore the complete form, including the menu and seed, then **Create restaurant** when ready. Saving under an existing name offers **Update saved setup**. Saved setups persist in this browser's local storage; they contain configuration, not an in-progress run or API credentials.

**Run history:** Every completed live service is saved automatically. Open **Run history** in the header for a table of past runs with the full setup (observation source, planner, floor, staffing, arrivals, guest habits, menu size) beside the service report figures (guests, revenue, every wait mean, ready-to-table p90, empty-glass time, requests, walking, planning counts, AI calls, tokens, and estimated cost). Click a heading to sort, hide the setup or report column groups, **Export CSV** for a spreadsheet, **Use setup** to reopen New restaurant with that run's configuration and menu, **Delete** a row, or **Clear history** (asks for a second click). A running or paused service can be added from the service report with **Save to run history**; if it later completes, the same row is updated. History lives in this browser's local storage, keeps the newest 400 runs, and never contains API keys. Comparison-worker runs and raw wait arrays are not stored; use Export run as JSON for those.

**Table numbers:** Switch the table indicators on or off using **Table numbers** in the sidebar or below the scene. Both controls stay in sync, and the choice is remembered across reloads.

**Quiet bubbles:** At most four balloons (including their exit animations) are allocated at once. The scheduler selects one speaker per table, prioritizing requests, low water, readiness to order/pay, and active service. Important cues rotate in six-second appearances with cooldowns; casual chatter gets at most one 3.5-second appearance every 15 real seconds when space is available. Needs take precedence over phone use and conversation. Speaker selection runs at 4 Hz, only selected dialogue is generated, and new texture uploads are capped at four per second. Movement and pop animations still run every frame. This is presentation only and does not change server observations or decisions.

The simulation keeps deterministic 0.25-second steps, while the renderer interpolates movement and gestures every animation frame. This adds at most one tick of visual delay without changing camera cadence or decisions. Pausing freezes that visual time. Servers have white shirts, dark aprons, colored waistbands and floor rings, and compact S1–S6 markers matching their routes; walking guests wear ordinary clothes without service equipment.

## Implemented

- Generated floor plans with 1–3 logical rooms, 2–24 tables, 2–4 seats/table, and 1–6 servers.
- Nine default dishes across appetizers, mains, and desserts. Each diner independently chooses optional courses; everyone orders a main. Diners at a table can choose different combinations.
- Guests enter, seat, wait for menus, read, order, eat individually delivered dishes, pay, optionally linger for 1–5 minutes, depart, and leave tables to be reset.
- Appetizer plates must be cleared before the kitchen starts mains. After mains are cleared, the server offers dessert; interested guests read menus and order again. A diner skipping a course waits for their companions.
- Seeded individual eating speeds, conversation, and intermittent phone use. Talking and using a phone pause food consumption, affecting table turnover. Phones are visible in the scene and classified in the camera feed.
- Optional seeded restroom trips (20% of diners by default, adjustable under Guest habits). Guests walk from their seats around furniture to the marked restroom and back, pausing eating and drinking. Plates stay at the table. Observations show the empty seat and visible walking location; no restroom interior is observed. Parties cannot finish their meal or leave while a companion is away.
- Independent kitchen timers per dish and shared ready-ticket notifications.
- Three cocktails ordered at greeting, a FIFO bar queue with 1–3 preparation slots (bartenders), bar pickup and table delivery, drinking progress, and billing.
- Servers observe locally, remember needs, prioritize, batch up to four ready dishes, top up water during visits, collect finished plates, return used dishes, and handle guest requests.
- Water consumption, occasional eligible fork/spill incidents, visible guest signalling, in-person request conversations, follow-up supply trips, and optional voice reports.
- Routing around tables, chairs, courtyard fountains, and room dividers. Classic, courtyard, and staggered presets; 1–3 m nominal aisles; front or separated bar/side-station locations.
- Full-room camera snapshots at a configurable simulated interval, with full-run timeline review and per-diner apparent activity, water, plate state, and visible-course completion.
- Seeded guest schedules, headless simulation, metrics, and JSON export.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/sim/types.ts` | Restaurant, observation, task, controller, and kitchen contracts |
| `src/sim/scenario.ts` | Configuration validation and deterministic guest generation |
| `src/sim/layout.ts` | Layout generation and four-connected grid routing |
| `src/sim/movement.ts` | Distance-based path sampling, seat access, and guest routes |
| `src/sim/engine.ts` | Fixed-step world simulation, observations, task validation, metrics |
| `src/sim/controllers.ts` | Evidence-only decision interface and rules controller |
| `src/sim/kitchen.ts` | Replaceable timer-based kitchen |
| `src/sim/bar.ts` | FIFO cocktail preparation, staffing slots, and tickets |
| `src/sim/comparison.ts` | Paired conditions, bounded headless runs, and summaries |
| `src/sim/comparison.worker.ts` | Background comparison execution |
| `src/view/restaurant.ts` | Three.js scene and visual projection of state |
| `src/sim/observations.ts` | Deterministic diner classifications shared by scene and camera feed |
| `src/view/camera-feed.ts` | Read-only camera history scrubber, playback, and live observations |
| `src/main.ts` | Setup form, clock, UI controls, reports, optional WebMCP tools |

The simulation has no browser or Three.js dependency. The view never drives customer state. A future layout editor should create a restaurant definition before a run; a richer kitchen can implement `KitchenPort`.

## Evidence and fairness

The world state is not a controller input. `DecisionEngine.choose` receives a copied `DecisionContext`: observations, server inventory, and feasible task candidates. An action returned by a controller must match the offered candidates; action completion validates current world state again.

Local servers scan **one visible table every 2 simulated seconds** by default, within 4.5 metres and the same logical room. Moving servers have a forward/peripheral field of view; opaque dividers block sight. A completed table visit supplies a direct observation. Observations older than the configurable memory horizon (90 seconds by default) produce a recheck, rather than a service task based on expired detail. Observation times remain visible to every controller. Camera mode adds full-room snapshots at the configured cadence. Kitchen and bar readiness, task reservations, floor geometry, and entrance queue pressure are shared operational facts. Physical speed, service times, and capacities are identical for every condition.

The **next-task** planner scores urgency against actual routed travel time. The **multi-stop** planner uses a bounded three-stop beam search, scoring discounted urgency per tour time, and projecting dirty-load and water use. A fixed dispatch allowance makes adjacent stops worthwhile without rewarding task count alone. Ready food waiting roughly 43 seconds (cocktails roughly 60 seconds) forces collection at the next decision boundary; already carried items and a required dirty return remain protected. Plans end at supply, pickup, or unload stops so the resulting inventory can be incorporated before continuing. Clean-food/drink deliveries take precedence while carried; dirty returns can be combined with nearby table work until capacity is reached. Every next stop is regenerated from current evidence and checked for party identity, reservations, and resource feasibility. A newly urgent task or interruption discards the remaining itinerary. Plans are intentions, not reservations of future tables.

This is a stronger, inspectable heuristic baseline, **not an empirically calibrated model of experienced staff** or an optimal router. It does not learn staff habits, estimate personalized meal hazards, or choose an arbitrary mixed food/drink itinerary. The bounded candidate/action interface applies to both rules and future Jev decisions.

**Compare servers → Four rules baselines** runs all four planner/evidence combinations on 1–10 consecutive seeds starting at the configured seed. It retains per-seed metrics and pools completed-stage wait samples for display; counts include paid guests and queue abandonment. Walking is normalized by completed guests, and empty-water time is normalized by time at the table. All runs continue past arrivals closing until service finishes, subject to a four-hour drain limit. Capped or stopped batches are marked; compare equal completed seed counts. These comparisons distinguish information availability from planning method, and do not measure Jev accuracy, cost, or latency.

The seed pre-generates arrival times, party sizes, menu choices, reading/eating durations, phone habits, restroom visits, post-payment lingering, cocktail choices, and request attributes. Cocktail choices use a separate random stream so bar settings do not alter arrivals or food preferences. The random generator is never consumed by a controller. An extra request opportunity is scheduled relative to seating and only manifests during an eligible service stage with a present diner. Fork drops additionally require delivered, unfinished food; spills require water in the glass. Request frequency uses an independent random stream, so adjusting it preserves all other guest attributes. Consequently, interruptions are comparable opportunities, not guaranteed identical realized incidents. Use repeated seeds, not a single run, for conclusions.

## Metrics

- Seating: arrival to table assignment, per party (walking to the table excluded).
- Greeting: seated to completed menu greeting, per party.
- Ordering: ready to order to submitted order, per ordering round (initial and, if requested, dessert).
- Ready-to-table time: dish ready to delivered, per dish across all courses; includes pickup and transit. Export field remains `foodWaits`.
- Cocktails: order-to-table and ready-at-bar-to-table, per delivered drink; preparation queue and service delay remain distinguishable.
- Planning: multi-stop plan count, discarded remaining stops, and observation age at table-task dispatch. Discarded stops are replanning events, not necessarily wasted visits.
- Payment: final-course completion or dessert declined, through bill request, presentation, review and completed payment, per party.
- Request response: visible signal to the start of in-person help; resolution: visible signal to completed help. Counts include routine bill requests. Averages include only answered/resolved requests; unfinished requests remain in the request count and timeline.
- Empty-glass time: fraction of diner-seconds at the table with water below 1% during active service; restroom trips are excluded.
- Walking: actual simulated route distance; one grid unit is treated as one metre.
- Completed: guests who paid, including those still lingering. Revenue is the sum of delivered dishes and cocktails, without taxes or tips.

Means include completed stages only; unfinished waits are not included. Exports contain raw wait arrays so distributions can be calculated. The service journal holds the latest 300 events. Camera history now retains every captured frame in memory for the current run, until reset or reload; long runs with many tables use more memory. Export schema version 5 includes `cameraSnapshots`, the generated layout/obstacles, bar tickets, and planner settings. Reports mark whether the run finished. Observation history is not a restorable simulation checkpoint.

Diner activity is a deterministic proxy for a vision classifier, also used for scene animation. Course completion tracks consumed eating time; talking and phone use pause that clock. A course is exposed only after its plate is delivered and while the plate remains visible. Its ordinal counts that diner's ordered courses: a main can be course 1 or 2. Future menu preferences, eating targets, and phone schedules never appear in controller observations. These are illustrative behavior assumptions, not calibrated observations of real diners.

## Real Jev / TypeSafe

1. Open **AI settings**, select **Real Jev - TypeSafe**, paste your TypeSafe API key and **Save key**. The input clears immediately. The key stays in local server memory for at most 24 hours, with an isolated HttpOnly cookie; restart or **Forget key** clears access. Nothing is saved in browser storage or exports.
2. Choose **Check Jev access** to call the authenticated models endpoint without inference. Default model is pinned to `jev-1.13.0` for reproducibility. `jev-latest`, `jev-preview`, and aliases returned by the access check are also available. The returned model ID is recorded on every response.
3. Before starting, choose **With real Jev - TypeSafe** in the sidebar. No OpenAI credential or request is needed. Settings lock for the run; reset to change controllers.
4. In **Compare servers**, choose **Diagnose all three - real Jev** (the default). This runs multi-stop rules/local observations, multi-stop rules/camera observations, and Jev/camera observations with the same seed, layout and guest schedule. Start with a short arrival window and one seed. The call limit applies separately to each AI seed, including retries.
5. Open **LLM activity** to see exact typed requests, selected tour, probabilities, confidence, resolved model, provider tokens and real latency. Confidence describes how concentrated the choice distribution is; it is not a correctness guarantee. Ambiguous but valid choices execute normally.

The adapter calls `POST https://api.typesafe.ai/v1/systemone` with a named JSON state and one Choice question. It constructs one single-stop option and, when useful, one multi-stop option for every feasible first action (at most 200 alternatives from the 100-candidate local API limit; the documented Choice limit is 255). Follow-ups use the baseline's discounted-work-per-time objective, with a bounded search of up to three stops. No first action is removed to force a preferred answer. Each offered tour is described by what every stop accomplishes, how long that guest has already waited, the number of tables served, and the tour's total and walking time (prompt version `tours-v3`, recorded in Run history). Kitchen and bar pickups are credited with the tables they feed and the summed age of their ready tickets. Earlier wordings are kept in history for comparison: `tours-v1` stated only time, which made the quickest single stop look best on large floors and produced long single-stop churn; `tours-v2` described table stops but called pickups station trips serving no table, which left cocktails at the bar for twenty minutes. Keep the version column in mind when comparing runs. This is a bounded choice architecture, not exhaustive planning or generated dialogue. Jev's choice is mapped back to original candidate IDs; route distances, projected dirty load, water, terminal inventory stops, reservations and stale action validation stay in code.

State includes only candidate-relevant observed needs: action descriptions, evidence source/age, current table stage and its age, visible requests, water and cleared/finished plates. It excludes future guest preferences and irrelevant conversational activity. Numeric travel and service durations are precomputed. Unknown private requests remain unknown until conversation. This intentionally uses semantic field names, following TypeSafe's guidance, rather than asking Jev to decode the legacy OpenAI shorthand or do route arithmetic. The camera rules control measures the benefit of information separately from the combined tour construction and Jev selection policy; it does not isolate the model from the tour proposer.

The adapter follows Jev's explicit `choice` after checking that it names an offered feasible tour. Reported probabilities are kept unchanged. A choice below the reported maximum, or probabilities that do not sum to one, produces a diagnostic warning rather than stopping service or silently selecting a different tour. Low confidence alone never stops a run. Unknown tour IDs, malformed probability values, and invalid usage still pause with a field-specific error.

Jev errors pause visibly with no rules fallback. HTTP 429 and 529 retry with bounded exponential backoff and Retry-After; 401/422 stop for correction. The entire restaurant holds while requests or cooldowns are pending; changing playback speed does not pretend to measure deployment throughput. The activity log includes wall-clock latency, and reports explicitly state zero simulated inference delay. Requests still in flight when cancelled may be billed.

Known-price estimates use the documented `jev-1.13.0` rate of $0.042 per million input tokens, with output free (checked 2026-09-20). Unknown returned versions are counted in `unknownPriceCalls` and excluded from the dollar estimate, not assumed free. Actual provider usage/billing is authoritative. No live account or credential is shipped; integration tests mock the documented TypeSafe contract.

Sources: [quickstart](https://docs.typesafe.ai/introduction/quickstart), [HTTP API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [state guidance](https://docs.typesafe.ai/concepts/state), [models and pricing](https://docs.typesafe.ai/models). The supplied TypeSafe skill informed this adapter.

## Diagnostic reports and compact legacy prompts

Both three-condition diagnostic modes provide **Copy diagnostic report**. The text includes scenario/layout fingerprints, completed and pending wait distributions, per-server work, actual actions around long greeting delays, offered-versus-selected greetings, and token/latency distributions. Jev reports also include up to three exact request/response samples. Export JSON retains bounded detailed traces (4,000 plans/actions/interactions each and three selected exact prompt samples); totals cover the whole run. Stop saves the partial active run as well as completed baselines. Unfinished or unmatched runs are clearly labeled. These diagnostics explain behavior without assuming Jev must improve it.

Legacy OpenAI requests use `bistro-rows-v1`: a shared column legend, compact rows, shared reason strings, unique destinations, and a directed travel matrix. All candidate IDs and observations remain available. The activity monitor distinguishes character reductions from provider-reported token usage.

Offline measurement using `o200k_base`, including visible instructions/state/output schema: for seed 42, 24 tables, 2 servers, 55 parties/hour and a 15-minute arrival window, 281 sampled decisions averaged 4,295 -> 2,503 input tokens (41.7% reduction); maximum 9,319 -> 3,783. Default-load samples averaged 1,283 -> 1,047 (18.4%). A deterministic rules planner supplied the sampled trajectories; this is not billed API usage or evidence of equal LLM decision quality. Benchmark script: `work/compact-payload-benchmark.ts` (local work artifact).

## Guest requests and information boundaries

Guests signal for attention; servers must walk to the service point before a timed conversation reveals a private question, early dessert-menu request, or bill request. A local server notices a wave only within the same visibility rules as other local evidence (room, range, facing while walking, and opaque screens). Carrying food/drinks and an active service interaction prevent immediate diversion. The itinerary is reconsidered after the conversation. A visible accident can be classified remotely, allowing a camera-assisted server to bring supplies on the first visit; an opaque request initially produces only an investigation task. Voice hints share the learned reason after the conversation, without turning it into visual evidence. With voice hints off, that reason remains in the responding server's memory. Speech bubbles explain the specific request only during actual table contact; at a distance the guest signals and has thoughts. A raised arm makes that signal visible even with bubbles disabled.

Default extra request chance is **20% per party**, with a conditional mix of 10% fork drops, 10% spills, and 80% ordinary questions. This gives nominal opportunities of 2%, 2%, and 16% of parties, before eligibility checks; it is **not empirical restaurant data**. There is at most one extra request per party. Change the chance in New restaurant or disable extra requests; routine dessert offers and bill requests remain. Dessert interest already follows the normal post-main offer, rather than generating a random dessert demand mid-course.

After the final course, guests wait 12–35 seeded seconds before signalling for the bill. The server learns the request at the table, presents a bill (6 seconds, abstract mobile POS), guests review it for 12–40 seeded seconds, then visibly offer payment. Payment is a separate service action. This applies equally to local, camera-rules, and LLM-proxy runs. The comparison includes signal-to-response and signal-to-resolution waits alongside food and water metrics.

The service sequence is informed by operator guidance such as the [Reading Country Club server training manual](https://readingcountryclub.com/wp-content/uploads/sites/131/2025/09/Server-Training.pdf), which covers acknowledging requests, checking tables, consolidating trips, dessert and payment. Such guidance supports the sequence, **not the numerical rates or durations**. This remains an uncalibrated discrete-event model; it cannot establish real Jev benefits without observations of actual service, parameter calibration, and validation on held-out services. Perfect room-wide camera classification is still an explicit assumption. Do not tune the baseline to manufacture a camera advantage; use paired seeds and examine cases where cameras or the proxy fail to improve service.

## Deliberate abstractions

- Kitchen capacity is unlimited. Food is not spoiled and there are no cook or equipment queues.
- Initial water is already at the table. Water pitchers hold four glass-equivalents. Clean trays carry at most four dishes or cocktails; used place settings have a separate four-unit limit and cannot mix with clean delivery loads. Glassware/linen clearing is abstracted within a used place setting.
- Servers can share an aisle; there is no pedestrian collision avoidance.
- Guests walk at 1.1 m/s; servers walk at 1.25 m/s. Restroom visits have a seeded trigger after seating and 45–120 seconds inside, plus route travel time. There is at most one visit per diner, when an eligible dining stage is reached. Restroom capacity and queues are abstracted. A companion can place an order for an absent diner; solo guests must return to order.
- Rooms have assumed full camera coverage. Local human scans obey room boundaries and opaque dividers; camera classification errors and camera frusta are not yet modeled.
- Guest speech is scripted from scenario events; no microphone or computer vision runs. The optional proxy receives preclassified observations only.
- Forks, cleaning items, and early dessert-menu requests require side-station supplies. Dessert ordering happens after mains; an early menu request does not itself order food. The scheduled dessert offer abstracts the server carrying menus.
- Every diner orders a main, courses are synchronized by party, and preferences are fixed at scenario creation. Shared dishes, mid-meal changes, repeat cocktail rounds, and split checks are not modeled.
- Queue abandonment occurs after 12 minutes; seated guests do not abandon meals.
- Table inspection is an omniscient debugging view, not the controller's evidence.

## Layout variation and future floors

The generated definition separates table footprints, service destinations, obstacles, and visibility occlusion. Both planners price travel using the same route geometry used by movement. A fountain changes paths without blocking sight; a divider blocks both where applicable. Station placement changes pickup/restock trip lengths rather than adding an artificial penalty.

This version is single-level. A future stair/elevator implementation belongs in the routing layer, with explicit links, traversal time, capacity, and animation. It must change both route cost and physical travel; adding only a scoring penalty would not be a fair simulation. Free-form editing can supply the same layout definition after connectivity validation.

## Validation

```sh
npm test
npm run build
```

Tests cover deterministic scenarios and replays, furniture-free reachability, full service completion, guest accounting, camera cadence, controller input isolation, invalid action rejection, and busy multiroom inventory invariants. Browser interaction checks are in `tests/browser.spec.ts` and use Playwright with an installed Edge browser:

```sh
# With npm run dev running on port 5173:
npx playwright test
```

Optional WebMCP tools are registered only when `document.modelContext` exists. They expose run readback and start/pause through the same UI actions.

## Project status

### OpenAI Jev proxy

Open **AI settings**, select **OpenAI - legacy stand-in**, paste an OpenAI API key, and choose **Save key**. The password field clears immediately. A random HttpOnly session cookie identifies a key held only in local server memory for up to 24 hours. Server restart or **Forget key** removes access. Keys never enter browser storage, simulation configuration, or exports. Saving does not validate model access or incur inference charges.

Choose GPT-5.4 nano (default), GPT-5 nano, or GPT-5.4 mini, and set the maximum API calls per run (default 500). Before starting a live service, select **With Jev proxy / OpenAI** in the sidebar. The proxy uses camera observations and the same feasible candidates and execution constraints as camera rules. Settings are captured at service start; reset to change controllers or model. The key can be replaced to recover authentication errors.

**Compare servers**, with **Diagnose all three - OpenAI stand-in**, runs three matched conditions: multi-stop/local rules, multi-stop/camera rules, and OpenAI/camera proxy. Start with one seed and a short arrival window. The table compares throughput, waits, walking, water, calls, and estimated cost. Export includes per-seed metrics, settings, tokens, and actual inference time. Stop prevents further decisions and retains completed runs plus the partial active run. Incomplete or unmatched runs are not full performance comparisons.

When there are multiple feasible actions, the engine suspends within its current tick. Nothing in the world advances until a validated response resumes that exact tick. No elapsed time accumulates for catch-up. Zero or one candidate needs no inference. Planned later stops are revalidated before execution. Prompts contain observations and feasible tasks, never future guest plans. HTTP lives outside the simulation engine.

The adapter uses the [OpenAI Responses structured-output API](https://developers.openai.com/api/docs/guides/structured-outputs) with `store: false`. GPT-5.4 models use reasoning effort `none`; GPT-5 nano uses `minimal`. Refusals, invalid responses, timeouts, billing errors, and call limits stop progress visibly. There is no rules fallback. Resume retries a failed live decision; a failed comparison retains partial results and must be restarted.

Temporary OpenAI rate limits are separate from remaining dollar credits. Recognized throttling errors (`rate_limit_exceeded`, `slow_down`, or `rate_limit_error`) retry up to three times while holding the same decision and the entire simulation clock. Cooldowns respect `Retry-After` (or reported reset intervals), use increasing delays with jitter, and appear in the sidebar and LLM activity with a countdown. Each attempt counts toward the call limit and receives its own 65-second connection deadline. A requested delay longer than two minutes stops for a later manual resume rather than retrying early. Quota, billing, project spending, organization usage, and unrecognized 429 errors do not automatically retry. Error codes, types, request IDs, selected rate-limit headers, and retry history are retained in LLM activity. See the [official OpenAI rate-limit guide](https://developers.openai.com/api/docs/guides/rate-limits).

Open **LLM activity** in the header or comparison window to watch requests without pausing the run. Each interaction shows server, model, seed/run, simulation timestamp, real elapsed time, instructions, observed state, feasible candidates, and the request body without authentication headers. Responses show the itinerary, token usage, provider wait, and available OpenAI request ID, response ID, output text, refusal, or incomplete-response details. The request waits for a complete response rather than streaming tokens. Internal model reasoning is not displayed.

Follow latest is enabled initially; turn it off or select a previous interaction to inspect history. The latest 200 interactions survive resets but are cleared on page reload; **Export interactions** saves them as JSON. A separate 65-second client deadline catches an unresponsive local connection, retaining the error and keeping simulation time frozen. Cancelling/resetting a live run or stopping a comparison marks pending interactions cancelled. Provider error messages are redacted to keep API keys out of the monitor and exports. Updating the local server clears memory-only API keys, so they may need to be entered again after development changes.

Costs are estimates using returned token usage and standard USD rates checked September 19, 2026: [GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano), [GPT-5 nano](https://developers.openai.com/api/docs/models/gpt-5-nano), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini). The call limit is not a dollar budget. Failed or cancelled requests may incur charges without returning usage. Automated tests use mocks; actual model access and planning quality require a user-key run.

Public repository on GitHub. No license has been chosen yet; all rights reserved until one is added. Public performance claims require controlled multi-seed evaluations and real-world calibration; a working API connection alone is not validation.
