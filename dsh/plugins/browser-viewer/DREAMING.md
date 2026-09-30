# Nightly learning in Seek

## Research, September 27, 2026

Meta's [How We Designed Muse](https://introducing.muse.ai/) documents persistent,
editable memory, scheduled background work, proactive suggestions and custom tools.
Its [technical safety article](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
describes custom skills, crons, isolated storage and separate permission enforcement.
These public documents do not specify a nightly learning algorithm or nightly model
weight updates. This implementation is Seek's own memory consolidation loop, inspired
by those documented capabilities. It is not a reproduction of Meta's internal system.

## Operation

- Defaults to 03:00 in the server's IANA time zone. Settings live in
  `DSH_WORK_HOME/dreaming.json` (normally `~/.dsh/work/dreaming.json`).
- A 30-second server timer starts one reflection per calendar day after the set time.
  Missed runs catch up while the server is online. Three failed runs exhaust that
  day's automatic retries; manual retry remains available. No OS wake timer is installed.
- Busy Work tasks and finance categorization defer reflection. New foreground work
  cancels in-flight model requests. Completed six-window batches remain saved.
- Each run reviews at most 24 new 1,800-character user-message windows. Remaining
  history stays pending for the next run. It never loads raw finance data or pages.
- Extraction and a separate critique use the configured Seek model router, with
  thinking disabled and bounded output. The same model provides both passes; this
  is an evidence filter, not an independent guarantee of correctness.
- A candidate needs an exact quote from an original user message, a valid schema,
  and critique confidence of at least 0.9. The original message, not a prior model
  summary, must support the entire note. Credential-like messages are excluded.
- Workflow lessons can become active automatically. Preferences and conflicts
  need review because the workspace may be shared by multiple people.
- Duplicates gain supporting evidence; existing memories cannot be their own
  evidence. Unconfirmed notes older than 90 days return to review. Paused notes
  never auto-reactivate. Maximum 100 notes and 30 journal entries.
- Editing, pausing and forgetting are available in Memory & preferences > Dreaming.
  Forgetting removes the stored quote and note and keeps only suppression hashes.
  Original conversations are not deleted. Existing model-session history cannot
  be retroactively erased; subsequent retrieval uses the current memory state.
- New task context retrieves up to five relevant notes within a 2,600-character
  budget. `work_memory_search` supports later recall; `work_recall` returns relevant
  notes with the durable checkpoint. Current requests and verified data prevail.

This improves future behavior through context and corrections. It does not train
model weights, autonomously modify application code, grant permissions, or execute
actions proposed during reflection. API routes inherit the Work app's authentication
and trusted-host checks. Shared-workspace members share learning settings and memory.

## Files

- `lib/work-dreaming.js`: scheduling, evidence checks, persistence, retrieval.
- `lib/work-dreaming-client.js`, `lib/work-dreaming.css`: controls and journal.
- `lib/work-server.js`: lifecycle, API routes, tools and task context integration.
- `lib/work-extras.js`: cancellable model requests.
