# Investigation Plan: Account Health + Rotation Regression

Goal: produce concrete, replayable evidence for the claim:
"With 2 accounts (IDC + Desktop), one Desktop is suspended and should be skipped, but the plugin marks it healthy / rotates into it."

This plan is intentionally evidence-first and does not assume the root cause.

---

## Success Criteria (Binary)

We are done investigating when we can answer all of these with evidence:

1) Does the selector ever choose a suspended/permanently-unhealthy account while a healthy account exists?
2) Does any code path flip a suspended/permanently-unhealthy account back to healthy? If yes, which path and why?
3) Does kiro-cli sync overwrite health fields (is_healthy/fail_count/unhealthy_reason/recovery_time) in a way that violates the intended invariants?
4) Can we describe a minimal patch (single concern) that enforces the intended behavior without collateral changes?

5) Can we map the behavioral surface area introduced by PRs #19/#20/#24 into discrete, reviewable change buckets?

---

## Invariants (What must always be true)

Define these invariants explicitly; every proposed fix must preserve them:

1) Selection safety
   - If any account is usable (healthy and not rate-limited), the selector must not choose an account that is permanently unhealthy.

2) Permanent means permanent (for suspension)
   - A suspended account must not be auto-rehabilitated by generic recovery logic.
   - Rehabilitation requires explicit evidence that suspension is cleared (or a deliberate manual action), not just time passing or another account succeeding.

3) Sync cannot "heal" permanent
   - `syncFromKiroCli()` may update tokens/usage/email metadata, but must not flip permanent-unhealthy to healthy without explicit signal.

4) Rotation correctness
   - Multi-account rotation must skip dead/suspended accounts and keep picking valid accounts.

---

## Environment Snapshot (Record before testing)

Record these exact versions in the issue/PR description:

- `opencode --version`
- plugin commit SHA (`git rev-parse HEAD` in the plugin repo)
- `kiro-cli --version`
- OS version (macOS): `sw_vers`
- Current plugin install mode:
  - file plugin: `@zhafron/opencode-kiro-auth@file:/...`
  - npm plugin: `@zhafron/opencode-kiro-auth@x.y.z`

Also record config sources:

- `~/.config/opencode/opencode.json`
- `~/.config/opencode/kiro.json`

## Historical Context (What we are auditing)

We must treat these PRs as the change history to audit and re-split:

- PR #19: https://github.com/tickernelz/opencode-kiro-auth/pull/19
- PR #20: https://github.com/tickernelz/opencode-kiro-auth/pull/20
- PR #24: https://github.com/tickernelz/opencode-kiro-auth/pull/24

The investigation must end with an explicit classification of each change from those PRs into a single concern bucket.

---

## Data Sources (Evidence we will collect)

We will collect only non-secret, minimal data:

1) Account state table snapshot (pre/post each run)
   - File: `~/.config/opencode/kiro.db`
   - Query (no secrets):
     - `id, email, auth_method, region, is_healthy, fail_count, unhealthy_reason, recovery_time, rate_limit_reset, expires_at, last_sync`

2) Plugin request logs
   - Directory: `~/.config/opencode/kiro-logs/`
   - Capture last N request/response/error pairs while reproducing.

3) OpenCode logs
   - Directory: `~/.local/share/opencode/log/`
   - Capture the log file associated with the run.

4) High-level run behavior
   - The actual output of:
     - `opencode run -m kiro/claude-haiku-4-5 "ping" --format json --log-level ERROR`

---

## Reproduction Protocol

We want a minimal setup identical to maintainer's scenario:

### Precondition A: Two accounts exist

Confirm `~/.config/opencode/kiro.db` has at least:

- one IDC account
- one Desktop account

If not available:

- Perform `opencode auth login` for IDC
- Perform `kiro-cli login` for Desktop (if applicable)

### Precondition B: Desktop account is suspended

We do not fabricate suspension.
We only proceed when the maintainer can demonstrate a suspended Desktop account or we can reproduce it naturally.

Evidence of suspension should show up as:

- `unhealthy_reason` contains something like "Account Suspended" or another suspension signature
- OR a consistent API response reason that indicates suspension

---

## Execution Steps (Do not change code)

### Step 1: Baseline DB snapshot

Record DB rows BEFORE any test request.

### Step 2: Run a small request repeatedly

Run 5 times:

- `opencode run -m kiro/claude-haiku-4-5 "ping" --format json --log-level ERROR`

After each run:

- Snapshot DB rows again
- Save the latest `kiro-logs/*request.json` and `*response.json`

### Step 3: Determine selected account per request

If selection isn't directly logged, infer it from:

- Request `Authorization` source (if distinguishable without secrets)
- `email` fields logged by plugin (if present)
- Which account's usage/last_used changes

If not inferable, add a targeted logging PR later (separate PR).

---

## Code Path Audit Checklist (Read-only)

Review these state transitions:

1) Where does an account get marked unhealthy?
   - Check for all calls to `markUnhealthy(...)` and identify which reasons are used.

2) Where does an account get marked healthy again?
   - Look for code that:
     - sets `isHealthy = true`
     - clears `unhealthyReason`
     - resets `failCount`
     - clears `recoveryTime`

3) What does “permanent” mean?
   - Inspect `isPermanentError(reason)` and any bespoke flags.
   - Ensure suspension is treated consistently across all paths.

4) Does `syncFromKiroCli()` write health fields?
   - Identify whether it always sets `isHealthy: true` during import.
   - Identify whether it overwrites an existing permanent unhealthy entry.

---

## Root Cause Classification (We must end with exactly one)

Assign one (or more) of these, backed by evidence:

1) Classification bug
   - Suspension reason is not treated as permanent, allowing generic "success" or time-based revival.

2) Sync overwrite bug
   - kiro-cli sync is re-importing accounts and setting `isHealthy: true` even for permanently unhealthy accounts.

3) Selection filter bug
   - selector includes accounts it must exclude, or doesn't prioritize healthy accounts.

4) Persistence/merge bug
   - DB merge/upsert logic rehydrates suspended accounts incorrectly.

---

## Deliverable: Minimal Targeted Fix Proposal

For whichever root cause is confirmed, produce:

- a 1-sentence invariant the fix enforces
- a 3-5 line explanation of what changes and why
- a minimal reproduction description
- a minimal verification checklist
