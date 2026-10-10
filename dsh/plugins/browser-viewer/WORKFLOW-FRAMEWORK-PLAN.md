# Reusable workflow framework: implementation and test plan

Status: proposed implementation plan, October 9, 2026. This document does not
implement or deploy the framework. The existing CPU routines remain prototypes.

## Outcome

Ordinary chat, saved workflows and scheduled runs use one task execution path.
The model interprets intent and resolves exceptions. Validated capabilities do
repeatable work on the CPU. Explicit saved runs need no inference; natural-language
requests use the existing model turn to select a workflow and bind its inputs.
No separate classification model is added. Unknown requests keep the normal agent
path, and workflow construction never blocks an unrelated task.

The first release provides validated recipes composed from reviewed capabilities.
A later release can generate reusable transformations in an enforced isolated
runtime. It must not run arbitrary generated JavaScript in the web server.

## Existing foundations and changes required

- `work-routines.js`: retain calendar/grocery calculations as initial capabilities;
  replace the name-based conditional dispatcher with a registry.
- `work-server.js` / WorkEngine: integrate workflow runs before creating an agent
  session; preserve normal tasks, replies, schedules, cancellation and completion.
- `work-database.js`: add separately versioned workflow tables and transactional
  lease/checkpoint operations. Preserve existing task history and schema support.
- `work-authority.js` / `work-connector-actions.js`: reuse authorization,
  duplicate suppression and receipts for every external write. Recovery must
  reconcile uncertain writes rather than replay them.
- `work-results.js`: store full outputs with bounded previews and provenance;
  never feed a whole catalog into the model or sum a truncated result.
- `work-tool-scope.js` / `work-tool-policy.js`: enforce task restrictions inside
  the capability broker, including evaluation and proactive runs. Hiding a tool
  from the model is insufficient when a workflow invokes it internally.
- `work-product.js` / `work-client.js`: replace the JSON grocery form with normal
  inputs, shared task progress and readable results. Preserve saved prompt templates.
- `work-evals.js`: extend the local grocery fixture and calendar fixtures to
  exercise real workflows with independent state-based outcome checks.
- `work-telemetry.js`: record routing, execution, verification and end-to-end time,
  model turns/tokens, exceptions and recovery. Calculation duration is not the
  task duration.

## Core contracts

### Capability registry

Introduce `work-capabilities.js`. Each reviewed capability has an immutable
name/version, input/output schemas, effect classification (`pure`, `read`,
`write`), allowed resources/accounts, timeout/size/concurrency limits, execution
function and verification policy. Write capabilities declare a reconciliation
strategy. Credential access stays inside adapters, never in recipe inputs.

Validate incoming and outgoing data at the broker boundary. A capability cannot
silently change effect classification or acquire an undeclared resource. Errors
have stable codes: invalid_input, missing_input, decision_required, login_required,
rate_limited, provider_changed, uncertain_write, verification_failed, cancelled.

### Workflow recipe

Introduce `work-workflows.js`. A recipe contains:

- ID, immutable version and content hash; lifecycle draft/tested/enabled/disabled.
- Input schema, defaults with provenance and preconditions.
- A bounded list of version-pinned capability steps.
- Typed references to inputs and earlier step outputs; no executable expressions.
- Limited declarative conditions, bounded batch work and exception handling.
- Expected result and independently registered verification requirements.
- Required capabilities/resources and execution budget.

Start with sequential execution plus batches within capabilities. Add independent
parallel branches only when a measured workflow needs them. No unrestricted loops,
recursive workflows, shell interpolation or general-purpose expression language.
The initial recipe limit is 32 steps; operation-specific row/time caps are enforced
by the registry rather than chosen by the model.

The model supplies structured recipes; code validates them. Route selection is
not authority. A workflow's saved permissions are a ceiling, not permission to
perform a new external action. Bind the task's current human instruction and
account identity again before each write.

### Runner and persistence

Introduce `work-workflow-runner.js` and `work-workflow-store.js`. Persist definitions,
versions, runs, step states, pinned input hashes, output references, leases and
receipt references. Use additive tables with their own migration version.

A run maps onto the existing task UI/statuses. Internally track ready, running,
needs_input, needs_decision, verifying, succeeded, failed, cancelled and uncertain.
Succeeded requires verified outcomes. An unavailable provider is not an empty result.

Use a transactional lease per run and serialize conflicting writes per account/cart.
Do not hold WorkEngine's global operation queue or a SQLite transaction while
waiting for a provider, user reply or model. Persist short state transitions, then
execute asynchronous work outside those critical sections.

Reuse request IDs for submission deduplication; intentional new runs get new IDs.
Pin workflow versions for active runs. Store large data once by reference; verify
that references belong to the run/task. Reads may retry with capped backoff and
provider retry hints. Writes use the authority broker and provider reconciliation.
Exactly-once delivery across arbitrary providers is not promised.

Cancellation prevents subsequent work and aborts supported requests. A write already
in flight may still finish; keep its outcome uncertain until reconciled. Never
report that cancellation undid a completed external change.

## Build phases and exit gates

### 0. Baseline and repair prototype semantics

Capture current agent-only results and times against fixtures before changing
routing. Freeze expected calendar windows and cart contents separately from the
implementation. Add strict date parsing (including impossible dates), explicit DST
policy, aggregate quantity limits and input-shape checks.

Separate grocery additions subtotal from final cart subtotal. Account for existing
and unrelated lines when evaluating a cart budget. Unknown prices/fees remain
unknown; an additions-only estimate must not imply the whole cart fits a budget.
Current inputs are supplied snapshots, not live provider data.

Gate: prototype behavior and reference answers are unambiguous; existing tests
remain passing; no live behavior changes.

### 1. Registry and validated recipes

Wrap calendar availability and grocery calculations in the registry. Implement
input/output validation, references, capability/resource checks and immutable
versioning. Use one direct `workflow_run` tool with a selected recipe/schema instead
of placing every workflow schema in every model request. Preserve legacy routine
tools as compatibility shims during migration.

Gate: invalid recipes fail before any adapter runs; seeded generated valid inputs
pass independent invariants; task ownership and policy are enforced on every step.

### 2. Durable runner integrated with WorkEngine

Implement additive database migration, run leases, result references, cancellation,
exception/resume handling and outcome verification. All entry points create normal
tasks and invoke the same runner. Remove the direct HTTP shortcut that bypasses
task history. Prevent CPU tasks from unnecessarily occupying the model/GPU queue.
Use configured concurrency limits so CPU workflows cannot monopolize the web process.

Gate: restart and duplicate-submission tests pass at each execution boundary;
normal agent tasks still work; CPU runs create no inference sessions, including
automatic titles or suggestions.

### 3. Routing and user experience

Explicit saved workflow selections bind inputs directly. For natural-language
requests, add only relevant recipe metadata to the existing planning context.
The same turn can select a recipe or ordinary agent execution. Validate its choice
and bindings against current task constraints and preconditions; do not rely on
a model's self-reported confidence score.

Ambiguous input uses the existing question flow. A provider exception resumes
only the affected step after its dependencies are revalidated. Permit one bounded
model repair attempt per exception episode; repeated failure needs a different
approach or attention, not an endless retry loop. The normal agent fallback gets
durable completed-step evidence and must not replay external writes.

Replace raw JSON results with event/conflict/free-window cards and grocery quantity,
cost and exception summaries. Keep JSON as an optional export. Saving/running a
workflow is optional and never required to use normal chat.

Gate: desktop/mobile UI tests pass; exact saved runs require zero model calls;
unknown requests take the existing path without an extra classification call.

### 4. Fresh adapters and live cart execution

Implement `calendar.fetch` using the shared store first. Add connected-provider
calendar adapters separately, with explicit account/source coverage and pagination.
Implement a retailer adapter through a supported API or the authorized browser
controller. Do not invent a private API or claim support until the actual account
flow is verified. Prefer stable product IDs and semantic page elements; changed
contracts/selectors must raise provider_changed.

Grocery recipe: fetch current catalog/cart -> compute target quantities -> obtain
any needed decision -> refresh/revalidate price and stock -> authorize -> set target
quantities -> read back and verify. Preserve unrelated cart items. External edits
during the run cause a conflict/replan, not a silent overwrite. Stock, login and
substitution exceptions should be handled without repeating completed work.

Checkout is a separate capability and is outside this release. Live tests stop at
cart editing, use a dedicated test cart/account where available, and preserve
preexisting contents. No purchases or messages are sent by CI.

Gate: local real-browser adapter tests pass including lost responses and layout
changes; target live provider/account is demonstrated separately. A failed live
adapter test disables that adapter, not the whole task system.

### 5. Learning and generated code

After successful tasks, propose recipe candidates off the critical path. Reuse
existing capabilities first. Record source task, assumptions and input requirements;
do not turn a recorded click sequence into a universally valid automation.

For missing pure transformations, generate source, fixtures and a declared output
contract. Test against independent reference checks and held-out inputs. Candidate
tests alone are insufficient evidence. Pin the source hash and dependency versions.
Promote only passing candidates; immutable enabled versions retain provenance.

Choose and verify an OS-enforced isolation backend before enabling generated source.
A Node worker, subprocess or vm alone is not that boundary. Require restricted
filesystem, no ambient host credentials/network, CPU/memory/output limits and child
process cleanup. If isolation is unavailable, fail closed for generated execution
and continue with reviewed capabilities. External actions remain brokered; generated
code cannot inherit direct connectors or expand its declared capabilities.

Gate: isolation escape/resource tests pass on the actual host, independent correctness
tests pass, and generated candidates cannot publish themselves or alter verifiers.
Recipe composition can ship earlier while generated-source execution remains off.

## Test matrix

| Layer | Required evidence |
| --- | --- |
| Schemas/registry | Reject unknown steps, cycles/forward refs, incompatible schemas, oversized data, unsafe keys, unsupported versions, undeclared resources and capabilities. No adapter invocation on rejection. |
| Calendar | Recurrence across DST, nonexistent/repeated local time, all-day boundaries, timezone changes, adjacent/nested/overlapping events, cancelled occurrences, empty calendars and range limits. Compare with independent expected intervals. |
| Grocery | Exact-ID merging, duplicate catalog rejection, safe-integer/quantity limits, pantry/cart deductions, unknown availability, stock changes, unit mismatch, unrelated lines and full-cart budget semantics. Rerunning against the resulting cart adds nothing. |
| Runner | Lease contention, parallel duplicate requests, partial completion, pinned versions, cancelled tasks, late provider replies, deadline exhaustion, output persistence and restart recovery. Read-only parallelism cannot corrupt another task. |
| Authority | Task/child/eval/proactive scope, stale approval, changed recipient/account/product/price/quantity, revoked access and cancellation before writes. External content cannot supply authorization or alter recipes. |
| Provider recovery | Pagination, stale snapshot, 401/login, 429/retry hints, malformed outputs, timeout before/after provider commit, mismatched receipts, failed readback, concurrent human cart edits and changed browser layout. No blind write retry. |
| Model routing | Real-model paraphrases, corrections, unavailable adapters, ambiguous intent, untrusted content injection and unrelated requests. Assert selected path, bound inputs and final state, not just plausible wording. |
| UI/API | Real authenticated routes, CSRF checks, duplicate clicks, progress, stop, exception/resume, reload, schedules, legacy templates, keyboard access, desktop/mobile layouts and escaped provider text. |
| Generated runtime | Attempts to read host secrets, escape paths/symlinks, make undeclared network requests, spawn children, exhaust CPU/memory or flood output. Unsupported isolation fails closed. |

Extend Node test suites using FakeHarness, temporary SQLite databases, a seeded
clock/RNG and fake adapters. Extend the existing CDP UI tests and grocery fixture
for real browser behavior. Test the real mountWork routes, not only mocked UI APIs.
Keep CI fixtures local with an outbound-network deny/fail assertion.

Create separate suites: workflow-contracts, workflow-runner, workflow-recovery,
workflow-policy, workflow-api, workflow-ui and workflow-routing. Add generated-runtime
tests only when that backend exists. Register deterministic suites in run-tests.mjs;
run real-model benchmarks separately so timing variation does not make CI flaky.

## Fault injection sequence

For every write-capable step, kill/restart execution after:

1. Input binding and precondition validation.
2. Authorization recorded, before dispatch.
3. Dispatch, before the provider receives it.
4. Provider commits, before returning a response.
5. Receipt received, before local receipt/checkpoint commit.
6. Local commit, before UI acknowledgement.
7. Verification fails or the user cancels mid-flight.

Each recovered run must show the correct provider state, correct uncertainty,
no duplicate mutation, and no skipped verification. If the adapter cannot establish
what happened, stop for reconciliation rather than pretend it succeeded.

## Performance evaluation and release thresholds

Use at least 15 fixed cases across calendar, grocery, exceptions and ordinary agent
tasks. Run at least 10 paired repetitions per case, interleaving baseline/candidate
order on the same machine/model/settings. Report cold and warm runs separately.
Reset provider fixture state identically. Use realistic controlled provider latency;
report adapter time separately from runner/routing overhead. Expand samples before
drawing conclusions from close results or noisy tail percentiles.

Report end-to-end p50/p95 time, inference turns/tokens, verified outcomes, time to
first progress, fallback rate, redundant provider calls, memory and event-loop delay.
Use explicit workflow IDs and natural-language entry separately.

Proposed gates (targets, not measured claims):

- All deterministic correctness, authority and recovery tests pass; no unauthorized
  or duplicated writes in the fault-injection corpus.
- All explicit fixture workflow cases finish verified with zero model inference.
- At least 50% fewer model turns and 30% lower median end-to-end latency for eligible
  natural-language cases, without lower verified success on the fixed corpus.
- Ordinary agent tasks have no extra model call and at most 5% median/p95 overhead;
  if noise obscures this, increase the paired sample size.
- Runner-only overhead stays below 50 ms p95 for a ten-step pure fixture on this
  host, excluding adapter/model time. Measure normal UI responsiveness under load.

Maintain out-of-scope/negative cases: a cart recipe must not route a purchase-history
report, checkout, calendar change or arbitrary research request. Release gates require
zero incorrect routing in the declared deterministic negative corpus, with additional
held-out real-model paraphrases reported independently rather than claiming universal
routing accuracy.

## Rollout and rollback

1. Feature flag off by default; validate migrations and all existing app tests.
2. Shadow route/plan generation using already captured or fixture data; perform no
   duplicate writes, extra private-data reads or foreground model calls.
3. Enable explicit read-only runs and calendar chat routing.
4. Enable grocery plans and local fixture cart execution.
5. Enable one verified live retailer adapter for authorized cart edits.
6. Enable candidate recipe learning; generated-source execution waits for its own gate.

Pin active versions. Disable flags to stop new workflow admission and use the normal
agent path for new tasks; never automatically replay an in-flight external write.
Keep durable receipts/checkpoints on rollback. Old binaries must ignore additive
workflow tables safely; unresolved writes remain visible for reconciliation. Test
the rollback against populated databases and an uncertain-write fixture.

Deploy through the existing release script only when the app's idle/service checks
pass. Do not bypass active work to release. Verify the deployed version, public
authenticated UI, a read-only calendar run, and one fixture cart run before enabling
live writes. Record the release and measurements; a green unit suite alone is not
evidence that the public app or retailer adapter works.

## Deliverables

- Registry, recipe validator, durable runner/store and WorkEngine integration.
- Shared-calendar recipe and verified grocery fixture adapter/recipe.
- Normal chat and workflow UI with human-readable results and recovery controls.
- Deterministic contract/policy/recovery/API/UI suites and paired benchmark report.
- Feature flags, additive migration, backward compatibility and exercised rollback.
- Separately gated live retailer adapter, recipe learning and isolated generated code.
