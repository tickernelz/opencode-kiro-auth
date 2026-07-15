# OpenCode Kiro Auth Plugin

[![npm version](https://img.shields.io/npm/v/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)

OpenCode provider plugin for Kiro and Amazon Q Developer authentication. It exposes
Kiro-supported models through OpenCode while using AWS Builder ID, IAM Identity Center,
or an existing `kiro-cli` session for credentials.

## Requirements

- OpenCode `>= 1.15.0`
- Bun, as used by OpenCode plugin runtime
- `kiro-cli` recommended for the most reliable IAM Identity Center profile selection

## Install

Recommended install:

```bash
opencode plugin @zhafron/opencode-kiro-auth --global
```

OpenCode's plugin installer reads this package's server and TUI entrypoints and updates
both config files. If you configure it manually, add the server plugin to
`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@zhafron/opencode-kiro-auth"]
}
```

And add the TUI plugin to `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@zhafron/opencode-kiro-auth"]
}
```

The plugin registers provider ID `kiro`, sets `@ai-sdk/openai-compatible`, and injects
the current built-in model catalog. You normally do not need to copy model definitions
into your OpenCode config.

## Models

The plugin injects the default Kiro model catalog automatically. Do not add model
definitions to your OpenCode config unless you are intentionally overriding local
display metadata.

The catalog includes Claude Sonnet 5 and all three GPT-5.6 tiers: `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-5.6-luna`. Each GPT-5.6 model has a 272K context window;
their Kiro credit multipliers are 2.4x, 1.2x, and 0.6x respectively.

For models that support configurable effort, the plugin exposes native OpenCode model
variants. Use your configured variant-cycle keybinding to switch levels. GPT-5.6 Sol,
Terra, and Luna and Opus 4.7/4.8 expose `low`, `medium`, `high`, `xhigh`, and `max`;
Opus 4.6 and Sonnet 4.6 expose `low`, `medium`, `high`, and `max`. Kiro's UI label
`Min` corresponds to the API value `low`.

For compatibility with older configs, the request layer still converts historical
aliases where possible, including dotted Claude IDs, hyphenated Claude IDs,
`*-thinking` IDs, and older `*-1m` IDs. These fallbacks are only for existing configs;
new installs should use the injected provider catalog.

## Authentication

### Recommended: sync from Kiro CLI

1. Run `kiro-cli login`.
2. If you use IAM Identity Center, verify the selected Amazon Q Developer or
   CodeWhisperer profile with `kiro-cli whoami --format json`.
3. Start OpenCode.

When `auto_sync_kiro_cli` is enabled, the plugin reads the local `kiro-cli` SQLite
session, imports access/refresh tokens and OIDC client credentials, imports the active
profile ARN, and creates the minimal OpenCode auth placeholder needed for provider
loader startup.

### Direct OpenCode login

Run:

```bash
opencode auth login --provider kiro
```

Choose `AWS Builder ID / IAM Identity Center`.

- Leave Start URL blank for AWS Builder ID.
- Enter your IAM Identity Center Start URL for organization SSO, for example
  `https://d-xxxxxxxxxx.awsapps.com/start`.
- Enter the IAM Identity Center region, also called `sso_region`.
- For IAM Identity Center, set a profile ARN if usage or generation returns 403.

The plugin uses the IAM Identity Center device authorization flow, opens the AWS
verification page directly, caches OIDC public-client registration securely under
`~/.config/opencode`, and refreshes access tokens without starting a local callback
server.

## Configuration

User config lives at `~/.config/opencode/kiro.json`. A default file is created
automatically.

```json
{
  "auto_sync_kiro_cli": true,
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "idc_start_url": "https://d-xxxxxxxxxx.awsapps.com/start",
  "idc_region": "us-east-1",
  "idc_profile_arn": "arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX",
  "usage_tracking_enabled": true,
  "sdk_endpoint_mode": "auto",
  "auto_effort_mapping": false,
  "request_timeout_ms": 120000
}
```

Environment overrides:

- `KIRO_IDC_START_URL`
- `KIRO_IDC_REGION`
- `KIRO_IDC_PROFILE_ARN`
- `KIRO_DEFAULT_REGION`
- `KIRO_AUTO_SYNC_KIRO_CLI`
- `KIRO_ACCOUNT_SELECTION_STRATEGY`
- `KIRO_USAGE_TRACKING_ENABLED`
- `KIRO_SDK_ENDPOINT_MODE` (`auto`, `kiro-runtime`, or `legacy-q`)
- `KIRO_ENABLE_LOG_API_REQUEST`
- `KIRO_AUTO_EFFORT_MAPPING`

## TUI Usage Panel

The package exposes a separate TUI plugin at `@zhafron/opencode-kiro-auth/tui`.
When the package is listed in `tui.jsonc`, OpenCode resolves that subpath automatically.

The TUI plugin reads `~/.config/opencode/kiro.db` in readonly mode, refreshes every 15
seconds, and shows:

- `Kiro`
- `Account: <email>`, disabled by default
- `Plan: <plan>`, for example `Plan: KIRO PRO+`
- `Credits: <used> / <limit>`, with used credits shown to two decimals

Optional display fields can be configured in `tui.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "@zhafron/opencode-kiro-auth",
      {
        "show_account_email": true,
        "show_plan": true,
        "show_credits": true
      }
    ]
  ]
}
```

`show_account_email` defaults to `false`; `show_plan` and `show_credits` default to
`true`.

OpenCode only shows the session sidebar automatically when the terminal is wider than
120 columns. On narrower terminals, use the sidebar toggle from the command palette.
The Kiro section is hidden for sessions whose active message provider is not `kiro`.
If `kiro.db` contains multiple healthy Kiro credential rows, the panel shows the latest
healthy row by `last_used`. With a single logged-in account, this matches the active
account. OpenCode's TUI plugin API exposes session provider metadata, but not the exact
Kiro account selected by the server plugin for the current request, so the displayed
quota is best-effort only when multiple healthy credentials are stored.
The TUI does not read access tokens, refresh tokens, client secrets, or OIDC
credentials.

If the panel is empty:

1. Confirm the TUI config contains the plugin:

   ```jsonc
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["@zhafron/opencode-kiro-auth"]
   }
   ```

2. Confirm usage tracking is enabled in `~/.config/opencode/kiro.json`.
3. Run one Kiro request or restart OpenCode so the server plugin can sync quota.
4. Check `~/.config/opencode/kiro.db` for an `accounts` row with `used_count`,
   `limit_count`, and `subscription_plan`.

## Troubleshooting

### No accounts

Run `kiro-cli login`, verify IAM Identity Center state with
`kiro-cli whoami --format json`, and keep `auto_sync_kiro_cli` enabled. The plugin
imports CLI credentials during startup.

### 403 AccessDeniedException

IAM Identity Center accounts commonly require a Q Developer or CodeWhisperer profile
ARN. Inspect the active profile with:

```bash
kiro-cli whoami --format json
```

Then restart OpenCode, or set `idc_profile_arn` in `~/.config/opencode/kiro.json`.

### Stale `kiro-auth` provider config

Older versions used provider ID `kiro-auth`. Current versions use `kiro`. The plugin
migrates an existing `kiro-auth` auth entry to `kiro` when possible, but your OpenCode
config should use `kiro` going forward.

### Logs

Plugin logs are written to:

```text
~/.config/opencode/kiro-logs/plugin.log
```

OpenCode logs are written to:

```text
~/.local/share/opencode/log
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```
