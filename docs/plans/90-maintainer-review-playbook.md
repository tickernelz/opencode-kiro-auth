# Maintainer Review Playbook (Targeted PRs)

## Objective
Keep the maintainer confident and unblocked: one concern per PR, minimal diffs, clear verification, zero surprise behavior changes.

---

## Pre-PR Checklist

1) Link to evidence
- Include a short reproduction section:
  - initial DB snapshot (non-secret fields)
  - command(s) to reproduce
  - expected vs actual

2) State the invariant the PR enforces
- Example: "A suspended account is never auto-rehabilitated and never selected while a healthy account exists."

3) Bound scope
- Explicitly list which files changed.
- Explicitly list what is NOT changed.

4) Keep commits clean
- Conventional commit style.
- No mixed refactors.

---

## PR Template (Copy/Paste)

Title: `fix(<area>): <short>`

Body:

1) Problem
- 2-4 lines only.

2) Fix
- exactly what changed.

3) Verification
- exact commands.
- exact scenarios (matrix row).

4) Risk
- 1-2 sentences.

---

## Review Strategy (In Order)

Start with the smallest PRs first:

1) PR: remove dead code
2) PR: classify suspension permanence
3) PR: selection/rotation guardrails
4) PR: sync preserves permanent-unhealthy

If we are responding to a regression report after PR merges, reference the historical PRs explicitly and state what subset you are changing:

- PR #19: https://github.com/tickernelz/opencode-kiro-auth/pull/19
- PR #20: https://github.com/tickernelz/opencode-kiro-auth/pull/20
- PR #24: https://github.com/tickernelz/opencode-kiro-auth/pull/24

Rationale: each PR can be reviewed in isolation.

---

## How to Address Common Feedback

### "Too many changes / confusing"
Response pattern:
- acknowledge
- restate scope
- offer to split further

### "Works for my Builder-ID use case"
Response:
- confirm no behavioral changes for builder-id-only path
- show the specific scenario matrix row that motivated the fix

### "Suspended should be skipped immediately"
Response:
- point to invariant
- show selection logic (or test) proving it

---

## Minimal Test Matrix (for every PR)

Each PR must state which rows it covers:

1) IDC only
2) Desktop only
3) Mixed IDC + Desktop (Desktop suspended)
4) Mixed IDC + Desktop (one quota exceeded)
5) Install mode: npm
6) Install mode: file:

---

## Note on OpenCode plugin hooks

If a PR relies on plugin hooks, ensure `package.json` includes the hook in `opencode.hooks`.
Without that, OpenCode will not invoke the hook even if it exists in code.
