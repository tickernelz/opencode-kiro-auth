# Production Readiness Report

Date: 2026-05-23
Branch scope: Kiro auth provider, streaming, model catalog, quota storage, and OpenCode TUI integration.

## Completed Improvements

- Replaced duplicated thinking-stream parsing with one shared state machine.
- Ensured thinking content is emitted before answer text when Kiro returns
  `<thinking>...</thinking>` blocks.
- Added safeguards for split tags, quoted literal tags, missing tags, and final-buffer
  flush behavior.
- Added SDK endpoint mode configuration:
  - `auto` tries the AWS SDK default CodeWhisperer Streaming endpoint first.
  - fallback uses the legacy `q.{region}.amazonaws.com/generateAssistantResponse`
    endpoint for compatible endpoint/socket failures.
  - 429 rate limits do not trigger endpoint fallback.
- Updated the model catalog to match current Kiro documentation, including recent Claude
  and open-weight models.
- Added quota/subscription persistence through the account database.
- Added a minimal TUI usage panel in the session sidebar.
- Added a dedicated OpenTUI Solid build step for `dist/tui.js`; the production build
  now fails if the emitted TUI artifact imports the types-only JSX runtime.
- Added tests for streaming thinking order, model resolution, package TUI manifest,
  endpoint fallback, and TUI quota data.
- Upgraded `@opencode-ai/plugin` to `^1.15.10`.
- Kept `solid-js` pinned to `1.9.12` because `@opentui/solid@0.2.15` requires that
  exact peer version.

## Security And Safety Notes

- The TUI opens the Kiro database readonly and renders only for Kiro sessions.
- The TUI only reads account metadata and quota fields. It does not read access tokens,
  refresh tokens, client secrets, or OIDC credentials.
- Request logging remains opt-in through `KIRO_ENABLE_LOG_API_REQUEST`.
- `npm audit` currently reports zero vulnerabilities.
- `npm ls --depth=0` reports no extraneous top-level packages after pruning.

## Verification Evidence

- Unit tests:
  - `src/__tests__/streaming-thinking.test.ts`
  - `src/__tests__/sdk-endpoint-fallback.test.ts`
  - `src/__tests__/model-resolution.test.ts`
  - `src/__tests__/constants.test.ts`
  - `src/__tests__/tui-usage.test.ts`
  - `src/__tests__/package-manifest.test.ts`
- Gates to run before PR:
  - `npm audit`
  - `npm ls --depth=0`
  - `bun run check`
  - `git diff --check`
  - `npm pack --dry-run --ignore-scripts`
- Live checks performed on the branch:
  - Kiro Sonnet thinking output produced a reasoning part before text.
  - New open-weight model slugs reached the Kiro API and returned output.
  - The local Kiro database stored `subscription_plan` and quota counts.
  - OpenCode TUI loaded `@zhafron/opencode-kiro-auth` from the cache after hot-swap.
  - Wide-terminal sidebar rendered the cached Kiro plan and request quota with no email,
    progress bar, or sync-age lines.
  - The home/session prompt quota badge and login top-right usage notification were
    removed.

## PR Notes

The most important reviewer-facing detail is that OpenCode uses separate server and TUI
plugin configs. The package exposes both entrypoints, but users who configure manually
must list the plugin in both `opencode.jsonc` and `tui.jsonc`. The README now documents
that explicitly.
