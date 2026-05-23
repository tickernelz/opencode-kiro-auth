# Kiro TUI Usage Panel

This package contains two OpenCode plugin entrypoints:

- `.` -> server/auth provider entrypoint, loaded from `opencode.jsonc`
- `./tui` -> terminal UI entrypoint, loaded from `tui.jsonc`

OpenCode intentionally separates server/runtime config from TUI config. Installing this
package with `opencode plugin @zhafron/opencode-kiro-auth --global` should patch both
files because the package manifest exposes `exports["./tui"]`.

## Required Config

Manual installs need both files.

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@zhafron/opencode-kiro-auth"]
}
```

`~/.config/opencode/tui.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@zhafron/opencode-kiro-auth"]
}
```

## Data Source

The panel reads `~/.config/opencode/kiro.db` in readonly mode. It does not read tokens
or secrets into the UI. The fields used are:

- `email`
- `auth_method`
- `region`
- `used_count`
- `limit_count`
- `subscription_plan`
- `is_healthy`
- `last_sync`
- `last_used`

The reader handles older databases without `subscription_plan` and falls back to
`Q Developer` for IDC accounts.

`subscription_plan` is the cached value returned by the remote Kiro
`getUsageLimits` response. The plugin reads known subscription title/tier fields from
that response and preserves the qualified remote label, so a remote value like
`KIRO PRO+` renders as `KIRO PRO+`.

## Rendering Slots

The TUI plugin only registers:

- `sidebar_content`: a compact quota panel in the session sidebar

OpenCode only auto-displays the session sidebar when the terminal is wider than 120
columns. On narrower terminals the user can toggle it from the command palette.

The sidebar intentionally renders only:

- `Kiro`
- `Plan: <plan>`
- `Requests: <used.toFixed(2)> / <limit>`

The panel is hidden for sessions whose model-bearing messages are not from the `kiro`
provider. Empty sessions fall back to the configured default model.

## Build Detail

OpenTUI Solid cannot be emitted by plain `tsc` with an `@opentui/solid/jsx-runtime`
import because that subpath is types-only in `@opentui/solid@0.2.15`. The package build
runs `scripts/build-tui.ts` after declaration emit to rewrite `dist/tui.js` with
OpenTUI's Bun Solid transform. The script fails if the runtime-unsafe JSX import
appears in the generated file.

## Validation Checklist

1. `bun test src/__tests__/tui-usage.test.ts`
2. `bun run check`
3. `scripts/opencode_plugin_hotswap.sh`
4. Start OpenCode with a wide terminal and an existing session:

   ```bash
   stty cols 160 rows 40
   opencode -s <session-id> --print-logs --log-level INFO
   ```

5. Confirm the sidebar includes `Kiro`, `Plan: <plan>`, and
   `Requests: <used.toFixed(2)> / <limit>`.
6. Confirm the home or session prompt does not show a Kiro quota badge.
