# PR Plan 4: Kiro-CLI Sync Must Not "Heal" Permanently Unhealthy Accounts

## Objective
Prevent `syncFromKiroCli()` from resetting health fields for accounts that are permanently unhealthy (e.g. suspended). Sync should update tokens/usage/email safely but must preserve permanent-unhealthy flags unless there is an explicit signal that suspension is cleared.

## Why (Problem)
Current sync/import logic can write `isHealthy: true` for imported accounts. In mixed-account setups, this can incorrectly rehabilitate a suspended account and reintroduce it into rotation.

## Scope (Strict)
- Only `syncFromKiroCli()` behavior.
- No changes to selection strategy.
- No changes to error classification.

## Target Files
- `src/plugin/sync/kiro-cli.ts`
- Possibly `src/plugin/storage/locked-operations.ts` (only if merge semantics override health)

## Implementation Approach

Before upserting an imported account, check whether an existing account matches and is permanently unhealthy.

If existing is permanently unhealthy:
- update safe fields only (tokens/expires/client creds/usage/last_sync)
- do not flip `isHealthy` true
- do not clear `unhealthyReason`
- do not reset `failCount`

This must be deterministic and narrow.

## Matching Strategy
Use the same identifiers used elsewhere (in order):
- profileArn match (if present)
- auth_method + client_id match (for IDC)
- deterministic account id (only if email is stable)

## Implementation Steps
1) Determine existing match row before upsert.
2) If existing indicates permanent unhealthy reason:
   - build an upsert payload that preserves the health fields.
3) If not permanent:
   - keep current behavior.
4) Build.

## Verification (Manual)
1) Create a permanently unhealthy Desktop account (suspended) in DB.
2) Run sync (triggered by auth init or explicitly).
3) Assert:
   - DB preserves `unhealthy_reason` and `is_healthy=0`
   - rotation still skips the account.

## Verification (Automated)
Add a unit test around sync merge logic (may require mocking kiroDb layer):
- given an existing permanently unhealthy entry, ensure sync does not flip isHealthy.

## Risks
- If sync legitimately represents an unsuspended state, this will delay recovery. That is acceptable until an explicit unsuspend signal is defined.

## Rollback
- Revert commit.
