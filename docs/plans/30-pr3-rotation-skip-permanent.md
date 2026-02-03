# PR Plan 3: Rotation Must Skip Permanently Unhealthy Accounts

## Objective
Even if a permanently-unhealthy account’s persisted fields are inconsistent (e.g. is_healthy=1 but unhealthy_reason indicates permanent), the selector must never choose it when another usable account exists.

## Why (Problem)
Maintainer report describes selection behavior: suspended account should be skipped from the start.
If the DB state is partially inconsistent (common during migrations/sync), a defensive selection filter prevents accidental selection.

## Scope (Strict)
- Only selection/filtering logic.
- No changes to how accounts become unhealthy.
- No changes to sync or token refresh.

## Target Files
- `src/core/account/account-selector.ts`
- (if needed) `src/plugin/accounts.ts` only for shared helpers

## Implementation Approach

Add an explicit guard in the selection filter:

- If `isPermanentError(unhealthy_reason)` is true, treat the account as not selectable regardless of `isHealthy`.

This makes selection deterministic even if the DB row says `is_healthy=1` incorrectly.

## Implementation Steps
1) Add the guard early in the filtering logic:
   - If permanent -> return false
2) Ensure the existing time-based revival logic does not apply to permanent reasons.
3) Build.

## Verification (Manual)
1) Mixed accounts: healthy + suspended
   - Run repeated requests and confirm the selector never chooses suspended.
2) Corrupt/inconsistent row test (manual DB edit in local dev only)
   - set `is_healthy=1` but keep `unhealthy_reason="Account Suspended"`
   - confirm selector still skips it.

## Verification (Automated)
Add unit tests for selector filtering given a list of accounts:
- (healthy, no reason)
- (isHealthy true, but permanent unhealthyReason)
Expected: only the truly healthy one is returned.

## Risks
- Might reduce compatibility if some providers rely on isHealthy only; mitigated by limiting to permanent reasons only.

## Rollback
- Revert commit.
