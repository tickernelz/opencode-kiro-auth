# Audit Plan: PR #24

PR: https://github.com/tickernelz/opencode-kiro-auth/pull/24
Title: fix: add missing config hook and improve kiro-cli sync conditions

This PR is small and targeted, but it still affects two different concerns.

---

## Changes (As merged)

1) Plugin wiring
- `package.json`: add `"config"` to `opencode.hooks`

2) Sync overwrite rules
- `src/plugin/sync/kiro-cli.ts`: only skip token import if:
  - existing is healthy
  - not expired
  - same region
  - fail_count == 0
  - unhealthy_reason empty

---

## Why We Still Split It

Even if each change is small, they belong to separate concerns:

- Hook registration is OpenCode integration wiring.
- Sync skip logic is token state management.

Maintainer requested “auth only / targeted fix only”.

---

## Split Outcome

This PR should be split into two PRs in a rework series:

PR-24A: opencode hook registration only
- touches: `package.json`
- invariant: OpenCode invokes plugin config hook when present

PR-24B: kiro-cli sync skip logic only
- touches: `src/plugin/sync/kiro-cli.ts`
- invariant: unhealthy accounts are re-synced rather than kept stale

---

## Verification

PR-24A:
- Repro: run with file plugin entry and no explicit provider baseURL
- Verify: no `undefined/chat/completions`

PR-24B:
- Repro: set an account with unhealthy_reason + fail_count > 0 and confirm sync re-import updates it
