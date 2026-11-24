# OrchestrOS remove-ai-slop audit

Audit date: 11 October 2026. Skill: [remove-ai-slop](../../../.claude/skills/remove-ai-slop/SKILL.md).

**Implementation update:** All eight findings below have now been addressed. See [applied fixes and verification](verification.md) for the final behavior and check results. This report and its original captures document the pre-fix baseline.

The main repairs concern truthful operational state, rather than a wholesale visual redesign. Eight quality findings are supported by component output, service behavior, or contradictory repository documentation. No hard copy bans were confirmed in the inspected states. Appearance-dependent conclusions remain unconfirmed because the browser connector exposed no browsers.

| Priority | Finding | Impact | Confidence | Repair cost |
| --- | --- | --- | --- | --- |
| 1 | Q1: Limited job rows presented as global state | A running job can disappear from worker/pipeline summaries | High; service reproduction | Medium |
| 2 | Q2: Missing job metrics shown as zero | Failed or pending reads look like measured inactivity | High; React output | Small |
| 3 | Q3: Round Robin implies time slicing | Operators can expect container preemption that is not implemented | High; copy and scheduler behavior | Small |
| 4 | Q4: History discards timestamps and obscures reservation meaning | Irregular samples appear evenly spaced; host use and reserved limits can be confused | High; SVG output and data contract | Medium |
| 5 | Q5: Empty chart promises automatic sampling | Disabled sampling is described as active | High; configuration contract | Small |
| 6 | Q6: Health indicator never refreshes | Startup failures and successes persist after service state changes | High; effect lifecycle | Small |
| 7 | Q7: Architecture copy guarantees agreement | Independent reads, limited rows, and loading fallbacks contradict the claim | High; source and Q1/Q2 | Small |
| 8 | Q8: README calls implemented recovery future work | Setup guidance disagrees with server behavior | High; source and current guides | Small |

## Copy manifest coverage

**Scope:** Representative review of the English, single-page operator dashboard: shared header/footer, `/#console`, `/#pipeline`, `/#job-queue`, `/#monitoring`, selected-job inspector, cleanup controls, monitoring tools, and architecture disclosure. These hash targets are sections of one page, not separate page roles. The product serves local orchestration demonstrations and inspection of scheduling/resource accounting. An academic/study audience is inferred from the README and operating guides; a separate brand brief is unknown.

**Supporting evidence:** README, `docs/README.md`, `docs/architecture.md`, `docs/decision.md`, `docs/flow.md`, frontend components, theme/font setup, API helpers, polling code, and the relevant scheduling, monitoring, orchestration and startup services. [`../legacy-architecture.png`](../legacy-architecture.png) was inspected as an older architecture asset; it is archived and is not a current dashboard or architecture reference. The CSS describes a supplied console reference, but the original current-console reference was unavailable.

**Sampling rationale:** The dashboard has one page role but several consequential states. All major component families were inspected, with fixture branches chosen to expose loading, failure, filtering, selected-job transitions and partial metric reads. Repeated worker instances and sibling cleanup states share their source components.

**Captured component states:**

| Component | States captured |
| --- | --- |
| App | Initial server markup; effects have not run |
| ControlPanel | Idle, Round Robin, auto-running, generating, stopping, clearing generated, clearing finished |
| JobDetail | Unselected, queued, scheduled without worker, reserved, running, completed, failed |
| JobQueue | Empty, populated, filtered zero, limited recent rows |
| WorkerGrid | Idle, busy |
| PipelineView | Empty, selected running, terminated |
| ActivityLog | Empty, reported action, reported error |
| MonitoringView | Loading, initial read failure, overview with metrics pending, overview with metrics failed, empty samples, one sample, uneven history spacing, snapshot saving |

[Copy captures](copy-captures.json) contain **35 static React captures**, **1,191 text-node instances**, **100 accessible-label/title instances**, and **272 distinct strings**, including fixture values. These are extraction counts, not a claim of 272 unique authored messages. Source-decision counts across interpolation branches and backend messages are not fully quantified. Every actionable decision below has a source location; state and interpolation context are recorded in the captures. No locale catalog was found in the frontend.

**Limits:** No current browser screenshots, layout/computed styles, viewport comparisons, keyboard interaction, hydration, or live service transitions were observed. React server rendering evaluates actual component branches but does not run effects or establish visual appearance. Captured markup includes options and closed disclosures; it is not evidence that all extracted strings appear simultaneously. Fixture names, dates, IDs, counts, outcomes and backend errors are explicitly synthetic audit data. Dynamic backend messages, every arrival/type combination, every validation response, permission-limited states, all terminal variants, and live database/Docker flows were not exhaustively captured. Historical academic proposal files and unrelated backend logic were outside the copy audit.

Baseline: **0 confirmed hard bans**, **8 quality findings**, **0 confirmed high/medium visual slop findings**. The absence of browser evidence prevents a clean visual verdict.

## Hard slop — remove

None confirmed within the inspected states. No exposed placeholder text, fabricated testimonials or content-free hero were found. Necessary acronyms, status values, instructional empty states and technical explanations are not treated as slop.

## Contextual signals and copy convergence

**C1 — Repeated uppercase section tags. CANDIDATE — render confirmation unavailable.**

Source: `frontend/src/styles.css:218`, shared `.eyebrow`; `ControlPanel.jsx:47`, `PipelineView.jsx:35`, `WorkerGrid.jsx:9`, `JobDetail.jsx:36`, `JobQueue.jsx:36`, `ActivityLog.jsx:14`, `MonitoringPanel.jsx:138`.

The accent background, weight 600, and uppercase treatment repeat across component families. However, tags such as “Job detail” and “Logical workers” provide stable section identity while adjacent headings show a selected job or describe content. Heuristic: +2 repetition, -2 concrete navigation/identity function = **0, LOW**. No score for visual dominance or harm without a browser. This is an observation, not a removal verdict. Preserve the tags unless the current render demonstrates redundant emphasis; do not delete operational status badges.

**CC1 — Shared section-label + task-heading pattern. LOW confidence, preserve pending rendered review.**

Instances: “Control panel” / “Operate the orchestrator”; “Logical workers” / “Capacity and running containers”; “Job detail” / dynamic job name; “Activity” / “What the backend reported”. These are related dashboard jobs, not a sales template imposed on pricing, documentation or onboarding. +2 repetition, -2 functional same-role justification = **0**. No copy convergence repair is justified by repetition alone.

**O1 — Pause scope could be clearer.** `ControlPanel.jsx:220` says “Pause Orchestrator”; `OrchestratorConsole.jsx:211` clears the browser timer while running work continues. The existing label accurately refers to orchestration, so this is not a hard ban. A useful optional hint beside the run controls is: “Pause stops new run requests. Containers already running continue.” Evidence: `docs/flow.md`, section 4, and the auto-run effect. This is a clarity improvement, excluded from the eight defect count.

## Quality defects

### Q1. Limited recent jobs presented as global pipeline and worker activity

Sources: `frontend/src/api.js:58` requests `limit=120`; `backend/src/modules/orchestrator/orchestrator.repository.js:24` applies `take: limit`; `orchestrator.service.js:307`, `:334`, `:338`, `:342`, `:434` and `:438` derive stage/activity totals from those limited rows. `PipelineView.jsx:36` says “Where every job is”; `WorkerGrid.jsx:40` can say “No container running”.

**Evidence:** [Isolated service reproduction](limited-state-reproduction.json) invokes the actual `OrchestratorService.state` with 120 recent completed rows, global counts of 199 completed and 1 running, and a busy worker with reserved capacity. It returns `totals.jobs = 200`, `statusCounts.RUNNING = 1`, but `totals.runningContainers = 0`, `activeReservations = 0`, and `worker.runningJobs = []`. This is fixture evidence of the aggregation defect, not a statement about the user's current jobs.

**Before:** “Where every job is”, followed by stage counts for at most 120 recent jobs; global-sounding reservation/container footnote; “No container running” when a running job falls outside that slice.

**After:** Keep the recent-row limit for the job table, but obtain pipeline totals, active reservations and worker running jobs from global repository queries. Then use “Job pipeline” as the section heading. If scoped counts are intentionally retained, label them “Pipeline for the latest 120 jobs” and label every dependent count/list with the same scope; do not infer that no container is running from an incomplete list.

**Impact:** Monitoring and orchestration sections can disagree about active work. **Provenance:** verified service behavior. **Recommendation:** global aggregation in repositories, with a bounded-history regression check; preserve existing job claims and resource transactions.

### Q2. Pending or failed throughput reads display measured zero

Sources: `frontend/src/MonitoringPanel.jsx:217`, `:221`; independent requests at `:97` onward; `frontend/src/monitoring.poller.js`.

**Evidence:** With overview available and `jobs = null`, actual React output is `Finished: 0`, `Per minute: 0`, `Success rate: -`. The same zero output remains when the error is “Job timings: Fixture request timed out”. Independent polling makes this a real supported branch.

**Before:** `jobs?.terminalInWindow ?? 0` and `jobs?.completionsPerMinute ?? 0`.

**After:** Display “—” until job metrics have arrived. During initial loading, add “Loading job metrics…”; after that channel fails, add “Job metrics unavailable. Use Refresh now to retry.” Retain a returned zero when an actual successful response reports zero. Existing stale data should retain its last successful timestamp and be identified as stale rather than replaced by zero.

**Impact:** Users cannot distinguish inactivity from a failed measurement. **Provenance:** verified React output. **Recommendation:** track channel status separately from metric values.

### Q3. Round Robin's option promises quantum-based rotation

Sources: `frontend/src/components/ControlPanel.jsx:22`, `:173`; `backend/src/modules/scheduler/scheduler.policies.js:55`; `scheduler.service.js:29`; `Readme.md:90` and `docs/architecture.md:153`.

**Before:** “Round Robin - rotate by quantum”; “Time quantum (s)”.

**After:** “Round Robin - order by scheduling rounds”; “Recorded time quantum (s)”, plus a conditional hint: “The quantum is recorded for study runs. Running containers are not paused or resumed.”

**Evidence:** The scheduler sorts by `schedulingRounds` and stores the quantum. The current execution path does not consume it to preempt a container. The repository documents pause/resume as planned.

**Impact:** Users may choose a policy expecting behavior it cannot perform. **Provenance:** contradicted capability implication. **Recommendation:** repair the option and nearby conditional explanation; retain the API enum and scheduler implementation.

### Q4. History chart discards time spacing and does not identify reserved capacity precisely

Sources: `frontend/src/MonitoringPanel.jsx:56`, `:60`, `:73`, `:237`; `backend/src/modules/monitoring/monitoring.metrics.js:100`; `monitoring.service.js:138`; `monitoring.repository.js:185`.

**Before:** `x = index * step`; “Recorded utilization”; accessible label “Cluster utilization over the last 60 minutes”; unlabelled horizontal grid lines.

**Evidence:** Fixture timestamps at 11:00:00, 11:00:15 and 12:00:00 produce equally spaced x values of 0, 300 and 600 in the actual SVG (`M0.0,72.0 L300.0,45.0 L600.0,81.0` for CPU). The API supplies `capturedAt`, but chart placement ignores it. Resource ratios come from reserved counters, not measured host usage. The 600-row request limit also does not guarantee a full 60 minutes of samples: with three workers it can contain about 200 sampling passes. No exact live span was measured.

**After:** “Recorded CPU and memory reservations”; accessible label “Recorded CPU and memory reservations as percentages of worker capacity”. Scale x positions from the returned timestamps, show the actual start/end time labels and 0–100% reservation scale, and explain gaps. Supply a text summary or accessible timestamp/value table. Keep the already distinct solid/dashed series.

**Impact:** Sample gaps can be misread as steady progression, and limits can be mistaken for measured host utilization. Missing units and numerical chart alternatives are quality/accessibility concerns, not evidence of AI authorship. **Provenance:** verified SVG/data-contract behavior. **Recommendation:** truthful time and reservation labels; browser verification required for final readability.

### Q5. Empty-history copy assumes the sampler is enabled

Sources: `frontend/src/MonitoringPanel.jsx:48`; `backend/src/modules/monitoring/monitoring.routes.js:24`; `backend/src/config/env.js:44`; `docs/architecture.md`, Monitoring.

**Before:** “No samples recorded yet. The sampler writes one every few seconds.”

**After, smallest repair:** “No recorded samples in this window. Use Save snapshot in Monitoring tools to record one now.”

**Evidence:** The backend supports interval 0 and exposes `periodicSamplingEnabled` and `sampleIntervalSeconds` at `/api/monitoring/config`. The frontend does not fetch that configuration. Zero returned points may also mean an empty query window, not that samples were never recorded.

**Impact:** Users can wait for an automatic event that will never occur. **Provenance:** contradicted when the sampler is disabled. **Recommendation:** use the neutral window-specific text, or read configuration and display the actual interval only when automatic sampling is enabled.

### Q6. Footer health and the initial health error are frozen at mount

Source: `frontend/src/App.jsx:54` through `:69` and `:154`.

**Before:** A one-time health fetch populates “API online · database connected” or “API unavailable · database checking”; the error advises checking backend/MySQL. No subsequent health read occurs.

**After:** Refresh health on a bounded interval, cancel pending reads on unmount, and retain a last-checked time. Prefer “API unavailable · database unknown” when the API cannot supply a database result; “checking” should identify an actual pending check. Clear the startup error after a successful health response.

**Evidence:** The health effect has an empty dependency list and no timer or retry; orchestrator and monitoring polling do not update `health` or its error. Live transitions were not browser-tested, but the missing refresh mechanism is explicit in source.

**Impact:** The page may continue advertising availability after a service fails or retain an obsolete error after it recovers. **Provenance:** verified source lifecycle. **Recommendation:** refresh status, or explicitly label it as a startup check rather than live health.

### Q7. Architecture disclosure promises that displayed numbers cannot disagree

Source: `frontend/src/App.jsx:132`.

**Before:** “Every number on this page is read back from those same records, so it cannot disagree with them.”

**After:** “The dashboard reads job and resource records from MySQL. Panels refresh independently, and the job table shows recent updates.”

**Evidence:** `OrchestratorConsole` polls every three seconds. Monitoring polls independent channels at two/five-second intervals after each request. Q1 demonstrates differing aggregation scopes; Q2 demonstrates a number invented as a loading fallback. Database origins alone do not establish simultaneous agreement.

**Impact:** An absolute consistency claim overstates the actual UI guarantees. **Provenance:** contradicted. **Recommendation:** narrow the sentence to the implemented mechanism; preserve the transaction explanation.

### Q8. README lists automatic crash recovery as unfinished

Sources: `README.md:85`; `backend/src/server.js:9`, `:36`, `:40`; `docs/flow.md:180`; `docs/architecture.md:238`.

**Before:** “Automatically recovering work after the backend crashes.” under “What is still planned”.

**After:** Remove that planned item. Add under current capabilities: “Recover untracked executions after a restart and during periodic reconciliation.” Retain “Worker-level failure recovery” as future work where appropriate.

**Evidence:** Startup calls `executionService.recover`; a periodic reconciliation timer calls it again. The current operating/architecture guides already describe settling exited or missing containers and resuming tracking of live ones. Recovery was not exercised against Docker in this audit.

**Impact:** The introductory guide contradicts the dashboard's capabilities and current technical guides. **Provenance:** contradicted by implementation. **Recommendation:** synchronize the README with the existing recovery scope without promising worker failover.

## Decisions to preserve

- **P1 — Compact operator layout.** Controls lead the page; no full-screen marketing hero obstructs the main task. Source structure confirms this; spacing and overflow still need browser checks.
- **P2 — Explicit operational nouns.** Generate Workload, Start container, Cancel job, Clear finished jobs, Save snapshot and the stage notes name actions and domain objects.
- **P3 — Logical-worker explanation.** “Workers are scheduling slots on the same computer” and “reserved limits, not actual RAM usage” prevent a common misunderstanding.
- **P4 — Coherent type roles.** Locally hosted Inter serves interface copy and Roboto Mono serves identifiers and metrics. A common font is not itself a defect. No third unrelated visible family was introduced in source.
- **P5 — Semantic actions and status colors.** Primary, stop, demo and quiet actions have separate treatments; pills represent statuses and filters. Their shared geometry is not proof of a starter recipe.
- **P6 — Actual sequential content.** Numbered generator/scheduler/placement/run controls and pipeline stages explain an ordered process, so numbered steps are justified.
- **P7 — Separate chart strokes and reservation labels.** CPU/memory use distinct strokes as well as color; gauges provide numerical text and accessible labels. Improve Q4 without discarding this distinction.
- **P8 — Focus and reduced-motion rules.** Focus-visible styles and a reduced-motion media query already exist. Preserve them and check their rendered behavior when a browser becomes available.
- **P9 — Calibrated reproducibility copy.** “The same seed and settings reproduce job specifications and workload checksums. Timing can vary.” names the relevant constraint rather than promising identical timings.
- **P10 — Existing footer phrase.** “Local compute. Persistent state.” states two actual product characteristics. Its cadence alone does not make it content-free copy.

## Validation and disposition

- `npm run dev:frontend` started successfully; HTTP GET `/` returned 200. The audit-started process was stopped afterward.
- `npm run build` passed backend syntax checks and the frontend production build.
- `npm run test --workspace frontend` passed all four existing polling tests.
- Actual React component rendering completed for the 35 recorded fixture captures. The missing-metrics and uneven-time-spacing findings were checked in generated markup.
- An isolated call to the actual orchestration state service reproduced the limited/global counter discrepancy without connecting to MySQL or Docker.

The initial run was diagnosis-only; the findings above describe that baseline. Implementation and subsequent test/database verification are recorded separately in [applied fixes and verification](verification.md). Browser layout checks remain unavailable, and the project is not declared visually clean.
