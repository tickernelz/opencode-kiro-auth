# PR Plan 1: Remove Dead Code (extractProfileArnFromAccessToken)

## Objective
Remove the unused helper `extractProfileArnFromAccessToken` to reduce noise and avoid reviewer confusion.

## Why (Problem)
Maintainer feedback: the function is defined but unused. Keeping it invites confusion and implies incomplete logic.

## Scope (Strict)
- Only delete unused function + any now-unused imports.
- No behavior changes.

## Target Files
- `src/plugin/sync/kiro-cli.ts`

## Implementation Steps
1) Confirm no references
   - Search for `extractProfileArnFromAccessToken` usage.
2) Delete the function definition.
3) Remove any unused imports introduced solely for that function.
4) Build.

## Verification
- `bun install`
- `bun run build`

## Risks
- None functionally (should be dead code). Risk is accidental removal of a referenced symbol; mitigated by step (1).

## Rollback
- Revert commit.
