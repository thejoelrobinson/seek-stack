# Reusable CPU workflows

Seek uses one versioned capability registry and durable runner for explicit Workflows runs, agent tool calls and schedules. Normal chat discovers a recipe during its existing model turn. No classification model runs before every request.

Workflows now includes shared-calendar availability and a grocery estimate from supplied prices. Results appear in normal task history with progress, cancellation, exceptions and downloadable JSON. Grocery estimates include known existing cart costs and show unknown prices explicitly. They do not contact or edit a retailer cart.

Work can compose pure recipes, test different examples, and save a tested candidate. The user enables it in Workflows. Candidate examples are supplemented by independent capability checks; they do not prove universal correctness. Versions are immutable.

## Contracts

- work-capabilities.js: typed registry, effect/resource declarations, bounded data, deadlines and registered verification.
- work-workflows.js: up to 32 sequential steps, typed inputs and references to previous outputs; no executable expressions or arbitrary source.
- workflows.sqlite: separate additive tables for versions, runs, steps, leases, fences and resource locks.
- work-workflow-runner.js: pure calculations checkpoint together; reads/writes retain individual boundaries. Interrupted writes reconcile provider state instead of replaying blindly.
- work-workflow-authority.js: wraps WorkAuthority. Reviewed adapters construct intents and receipts. No live write adapter is registered in this release; fixture tests exercise the write protocol.

Original deliverable checks still run before completion. A verified calculation cannot replace a requested external action or file. Evaluation cannot access real accounts; proactive tasks cannot write externally. Credentials stay in adapters. Large results are saved with bounded model summaries. CPU tasks do not reserve inference or the shared browser.

## Tools and routes

- work_workflows(query?): discover relevant recipes and capabilities.
- work_workflow_run(id, version?, input, requestId?): execute inside the current task. This verifies a substep, not the entire user ask.
- work_workflow_candidate(definition, examples): test a pure recipe and save it as tested; the model cannot enable itself.
- Legacy routine_* tools use the same durable service.
- GET /work/api/workflows: catalog/state and generated-runtime availability.
- POST /work/api/workflows/run: create a normal task; stable request IDs deduplicate submissions.
- POST /work/api/workflows/state: authenticated owner enables/disables a version.
- The old /work/api/routines/run URL now creates a durable task.

SEEK_WORKFLOWS=0 stops new admissions/tool runs; existing admitted runs stay recoverable. Disabling a version prevents fresh starts while dispatched steps remain reconcilable. Definitions, receipts and checkpoints are retained.

## Example recipe

```json
{
  "id":"sum_amounts",
  "version":1,
  "title":"Sum amounts in cents",
  "input":{"type":"object","properties":{"values":{"type":"array","items":{"type":"integer"},"maxItems":500}},"required":["values"],"additionalProperties":false},
  "steps":[{"id":"sum","capability":"data.sum_cents","version":1,"input":{"values":{"$ref":"input.values"}}}],
  "result":"sum"
}
```

Provide at least two different examples: values [100,250] expects totalCents 350; values [0,-50,75] expects 25. Dynamic provider outputs are validated at runtime before the next capability executes.

## Verification

npm test includes contracts, seeded invariants, real authority, leases, conflicting resources, cancellation, actual process exits/restarts, mounted HTTP routes, model-free runs, schedules and desktop/mobile browser flows.

```text
node test/benchmark-workflows.mjs workflow-benchmark.json
node test/benchmark-workflow-routing.mjs workflow-routing-results.json
```

The CPU benchmark runs 15 cases ten times and checks results independently. It excludes model/provider/queue/UI time. The routing smoke test uses an isolated local-model planning prompt plus coverage checks, stops for foreground Work, and is outside CI. It is not the full agent harness or a latency comparison.

Raw generated-code execution is disabled: no enforced isolated runtime is configured. Recipes compose reviewed code. Connected reads use Pipedream and must check pagination separately. Live retailer writes require an account-tested adapter and remain disabled. The planned inference-turn/end-to-end latency targets still require a paired full-agent benchmark.
