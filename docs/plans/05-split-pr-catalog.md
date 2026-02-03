# Split PR Catalog (Planned)

This file is the single source of truth for “how many PRs” and what each PR does.
It must only contain scoped, reviewable PRs.

---

## PR 1: Dead Code Cleanup

- Solves: reviewer noise / unused helpers
- Invariant: no behavior changes
- Files: (example) `src/plugin/sync/kiro-cli.ts`

---

## PR 2: Plugin Wiring (Hooks)

- Solves: file-plugin installs where config hook is implemented but not invoked
- Invariant: if plugin implements `config`, OpenCode will invoke it because it is declared in `opencode.hooks`
- Files: `package.json`

---

## PR 3: Suspension Permanence (Health)

- Solves: suspended accounts should never auto-rehabilitate
- Invariant: suspension reason is permanent everywhere
- Files: `src/plugin/health.ts` (and only if needed, `src/core/request/error-handler.ts` for canonical reason)

---

## PR 4: Rotation Guardrails

- Solves: selection picks suspended/permanent accounts incorrectly
- Invariant: permanently unhealthy accounts are never selected while any usable account exists
- Files: `src/core/account/account-selector.ts`

---

## PR 5: Kiro-CLI Sync Preserve Permanent

- Solves: sync healing permanently unhealthy accounts
- Invariant: sync does not flip permanent unhealthy to healthy without explicit unsuspend signal
- Files: `src/plugin/sync/kiro-cli.ts` (and only if unavoidable, `src/plugin/storage/locked-operations.ts`)

---

## PR 6: Tests for Invariants

- Solves: lack of regression protection
- Invariant: test suite enforces PR3–PR5 invariants
- Files: `test/*`

---

## Mapping to Historical PRs

As we audit PR #19/#20/#24, we will add a “Moved from PR #X” note under each PR here.
