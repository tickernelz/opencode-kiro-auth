# PR Plan 2: Treat Suspension as Truly Permanent (No Auto-Rehab)

## Objective
Ensure an account marked as suspended is never auto-rehabilitated (never becomes healthy again automatically) and is always skipped during rotation when any usable account exists.

## Why (Problem)
Maintainer report: with 2 accounts (IDC + Desktop), one Desktop is suspended and should be skipped, but becomes healthy or is not reliably marked unhealthy.

This indicates a classification mismatch: "Account Suspended" may not be treated as a permanent error by the generic permanence check.

## Scope (Strict)
- Only change suspension permanence classification.
- Do NOT change selection strategy.
- Do NOT change kiro-cli sync logic.

## Target Files
- `src/plugin/health.ts`
- (possibly) `src/core/request/error-handler.ts` (only if suspension reason string differs)

## Hypothesis to Validate
If `unhealthy_reason` is set to a suspension marker but `isPermanentError(unhealthy_reason)` returns false, then:
- success-path logic can reset `fail_count` and flip the account to healthy
- time-based recovery logic can revive it

## Implementation Options

Choose the smallest valid option:

Option A (preferred): Expand permanent reasons list
- In `isPermanentError(reason)`, treat "Account Suspended" (and/or the exact suspension marker used) as permanent.

Option B: Normalize suspension reason
- Ensure error handler writes a stable canonical reason string (e.g. "TEMPORARILY_SUSPENDED" or "ACCOUNT_SUSPENDED") that `isPermanentError` recognizes.

## Implementation Steps
1) From logs/DB, extract the exact `unhealthy_reason` string for suspension.
2) Add it to `isPermanentError` matching.
3) Build.

## Verification (Manual)
Test matrix (minimal):
1) Mixed accounts: one healthy + one suspended
   - Run 5 times: `opencode run -m kiro/claude-haiku-4-5 "ping"`
   - Assert:
     - suspended account is never selected while healthy exists
     - suspended account never flips `is_healthy` to 1 automatically

2) Single suspended account only
   - Assert:
     - the system fails fast with "all accounts unhealthy" rather than looping/rehabilitating.

## Verification (Automated)
Add a unit test around `isPermanentError`:
- input: the suspension reason string
- expected: true

## Risks
- Over-broad match could treat non-suspension as permanent. Mitigate by matching the exact canonical string.

## Rollback
- Revert commit.
