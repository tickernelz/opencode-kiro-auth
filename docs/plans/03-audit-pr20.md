# Audit Plan: PR #20

PR: https://github.com/tickernelz/opencode-kiro-auth/pull/20
Title: fix(kiro): align CodeWhisperer requests, improve region handling and sync

Maintainer feedback: too many changes at once; hard to verify.

---

## What We Need From This Audit

1) Identify every behavior change and classify it.
2) Determine which changes are strictly required for:
   - request schema correctness
   - region correctness
   - sync correctness
   - health/rotation invariants
3) Convert into small PR candidates.

---

## Known Change Signal (Must confirm)

From PR diff excerpt:

- Added helper `extractProfileArnFromAccessToken` in `src/plugin/sync/kiro-cli.ts`.
- Maintainer flagged it as unused.

This is a strong indicator PR #20 mixed experiments and fixes.

---

## Audit Steps

1) Capture metadata
- `gh pr view 20 --repo tickernelz/opencode-kiro-auth --json title,mergedAt,files,commits,url`

2) Extract full diff
- `gh pr diff 20 --repo tickernelz/opencode-kiro-auth`

3) Build the change list
- For each hunk: convert to a single-sentence “Change List” entry.

4) Bucket each entry
Use the concern buckets in `docs/plans/01-pr-history-and-split-roadmap.md`.

5) Identify conflicts
Specifically look for any of:
- “sync/import sets isHealthy true”
- “success-path resets fail_count/unhealthy_reason”
- region derived from profileArn vs IDC region

---

## Output: Candidate Split PRs

Populate these candidate PRs (names are placeholders):

- PR: remove dead code
  - scope: delete unused helper(s) only

- PR: request schema alignment only
  - scope: only the minimal payload shape changes

- PR: region selection only
  - scope: region regex + normalizeRegion + region derivation rules

- PR: kiro-cli sync behavior only
  - scope: dedupe and overwrite rules

- PR: health/rotation invariants only
  - scope: permanent vs temporary + selection rules

Each must be described as one invariant.
