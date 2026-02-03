# PR History Audit + Split Roadmap (PRs #19, #20, #24)

This document exists to prevent repeating the same mistake: bundling multiple behavior changes into a single PR without a clear separation of concerns.

We had 3 upstream PRs merged:

- PR #19: https://github.com/tickernelz/opencode-kiro-auth/pull/19
- PR #20: https://github.com/tickernelz/opencode-kiro-auth/pull/20
- PR #24: https://github.com/tickernelz/opencode-kiro-auth/pull/24

Maintainer feedback: changes were not sufficiently targeted, and rotation/health behavior became confusing to verify.

---

## Objective

1) Audit all changes from PRs #19/#20/#24 and classify them by concern.
2) Define a new split strategy: multiple narrow PRs where each PR has exactly one invariant it enforces.
3) Ensure each PR is independently reviewable and testable.

---

## Step 1: Audit the Historical PRs

For each PR (#19/#20/#24):

1) Capture metadata
   - PR title + summary
   - list of files changed
   - key behavioral changes claimed
   - any discussion notes and maintainer concerns

2) Extract an explicit "Change List"
   - Write each change as a single sentence with:
     - What changed
     - Why it was changed
     - What behavior is expected to change

3) Map each change to one concern bucket (below).

4) Identify conflicts between changes
   - Example: "sync sets isHealthy true" vs "suspension must stay unhealthy"

---

## Known Scope Snapshot (Initial Inputs)

This section is a starting point; it must be verified during the audit.

PR #19 (large, multi-file):
- touches auth flow, region validation, request handling, storage, sync, tests, docs.
- changed files include:
  - `src/core/auth/idc-auth-method.ts`
  - `src/plugin/server.ts`
  - `src/plugin/token.ts`
  - `src/plugin/request.ts`
  - `src/core/request/request-handler.ts`
  - `src/core/request/error-handler.ts`
  - `src/plugin/accounts.ts`
  - `src/plugin/sync/kiro-cli.ts`
  - `src/plugin/sync/idc-region.ts`
  - plus config, storage, and multiple tests.

PR #20 (sync/request/region alignment bundle):
- at minimum adds `extractProfileArnFromAccessToken` in `src/plugin/sync/kiro-cli.ts` (later flagged unused).

PR #24 (small, targeted):
- `package.json`: add `"config"` to `opencode.hooks`.
- `src/plugin/sync/kiro-cli.ts`: tighten skip-import condition based on `fail_count` and `unhealthy_reason`.

---

## Audit Output Artifacts (Files we will produce)

During the audit we will keep these files updated:

- `docs/plans/02-audit-pr19.md`
- `docs/plans/03-audit-pr20.md`
- `docs/plans/04-audit-pr24.md`
- `docs/plans/05-split-pr-catalog.md`


## Concern Buckets (Use these labels)

Every change must map to exactly one:

1) Plugin wiring (OpenCode integration)
   - e.g. `package.json` opencode hooks registration, provider baseURL/fetch wiring

2) Auth flows
   - IDC / Builder ID
   - Desktop
   - Token refresh

3) Request shape / protocol
   - CodeWhisperer request schema alignment

4) Account selection / rotation
   - selection strategy (sticky/rr/lowest-usage)
   - skip logic
   - invariants

5) Account health state machine
   - isHealthy/failCount/unhealthyReason/recoveryTime
   - permanent vs temporary
   - suspension handling

6) Sync (kiro-cli)
   - import rules
   - overwrite rules
   - dedupe/merge rules

7) Observability
   - logs
   - debug artifacts

---

## Step 2: Decide What We Are Actually Fixing (Problem Statements)

We should produce a list of problems (not solutions). Example list:

P1) File-based plugin installs can fail because `config` hook is implemented but not registered in `opencode.hooks`.
P2) Suspended accounts must never be selected while a healthy account exists.
P3) Suspended accounts must not be auto-rehabilitated by generic success/recovery logic.
P4) kiro-cli sync must not overwrite permanently-unhealthy state.

Each problem statement becomes exactly one PR (or an issue if too large).

---

## Step 3: Split Roadmap (How many PRs + what each does)

We will keep PRs small and single-purpose. Proposed set (minimum viable):

1) PR-A: Plugin wiring only
   - Solves: P1
   - Changes: `package.json` hooks registration and/or config hook activation
   - Verification: reproduce `undefined/chat/completions` without baseURL; confirm fixed.

2) PR-B: Health permanence for suspension only
   - Solves: P3
   - Changes: permanence classification for the suspension reason string
   - Verification: suspended account never flips healthy.

3) PR-C: Rotation guardrails only
   - Solves: P2
   - Changes: selection filter hard-excludes permanently unhealthy accounts
   - Verification: mixed accounts always pick healthy.

4) PR-D: kiro-cli sync overwrite rules only
   - Solves: P4
   - Changes: do not heal permanent unhealthy during sync
   - Verification: sync does not change suspension status.

Optional PRs (nice-to-have, only after the above are stable):

5) PR-E: Remove dead code / cleanup
   - Example: remove unused helpers

6) PR-F: Add tests for invariants
   - Prefer adding tests as part of PR-B/C/D when it’s small; otherwise a single focused test PR.

---

## Step 4: How We Validate the Split

For each PR, include:

- a single invariant statement
- a minimal reproduction
- an explicit verification matrix row
- a rollback statement (revert commit)

If a change cannot be described as exactly one invariant, it must be split further.
