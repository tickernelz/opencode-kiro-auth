# Audit Plan: PR #19

PR: https://github.com/tickernelz/opencode-kiro-auth/pull/19
Title: refactor: single-window IDC auth with JSON API and token selection fixes

This PR is large. We will not attempt to "re-merge" it as-is. We will decompose it.

---

## What We Need From This Audit

1) A complete change list (every behavioral change as a single bullet).
2) A mapping from each change to exactly one concern bucket.
3) A decision per change: keep / revert / re-implement as separate PR.

---

## Fast Metadata Capture

Run and paste into the audit notes:

- `gh pr view 19 --repo tickernelz/opencode-kiro-auth --json title,mergedAt,files,commits,url`
- `gh pr diff 19 --repo tickernelz/opencode-kiro-auth`

Extract:

- Files changed list
- Commits list
- Any review comments and maintainer concerns

---

## Decomposition Checklist (Do in order)

### A) Plugin wiring / OpenCode integration

Questions:
- Did PR #19 change plugin hook declarations (`package.json opencode.hooks`)?
- Did it change config hook behavior?
- Did it change provider wiring (baseURL/fetch)?

Artifacts:
- If yes, list exact keys and intended behavior.

### B) Auth (IDC)

Questions:
- Did it change the IDC auth UX (single window)?
- Did it change how tokens are stored or refreshed?
- Did it change the Start URL behavior (`builder_id_start_url`)?

Artifacts:
- List exact files:
  - `src/core/auth/idc-auth-method.ts`
  - `src/plugin/server.ts`
  - `src/kiro/oauth-idc.ts`
- For each file: what the public behavior change is.

### C) Token refresh / token selection

Questions:
- Did it change token selection rules (codewhisperer vs kirocli)?
- Did it change refresh endpoints/regions?

Artifacts:
- Files likely:
  - `src/plugin/token.ts`
  - `src/plugin/sync/idc-region.ts`
  - `src/plugin/sync/kiro-cli.ts`

### D) Request shape / protocol

Questions:
- Did it change request payload fields sent to CodeWhisperer/Q?
- Did it change tool/function calling payload handling?

Artifacts:
- Files likely:
  - `src/plugin/request.ts`
  - `src/core/request/request-handler.ts`
  - `src/infrastructure/transformers/history-builder.ts`

### E) Rotation / health state machine

Questions:
- Did it change health permanence rules?
- Did it change when accounts become healthy again?
- Did it change selection ordering?

Artifacts:
- Files likely:
  - `src/plugin/accounts.ts`
  - `src/core/account/account-selector.ts`
  - `src/core/request/error-handler.ts`

### F) Storage and sync

Questions:
- Did it change sqlite schema or merge behavior?
- Did it change how kiro-cli sync overwrites state?

Artifacts:
- Files likely:
  - `src/plugin/storage/sqlite.ts`
  - `src/plugin/storage/locked-operations.ts`
  - `src/plugin/sync/kiro-cli.ts`

---

## Output: Split Recommendations

Once the checklist above is done, create a table:

- Change summary
- Bucket
- Proposed PR (name)
- Risk
- Verification (exact commands)

This table is copied into `docs/plans/05-split-pr-catalog.md`.
