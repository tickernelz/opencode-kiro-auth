# OpenCode Kiro Auth Plugin

[![npm version](https://img.shields.io/npm/v/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)

OpenCode plugin for AWS Kiro (CodeWhisperer) providing access to Claude Sonnet and Haiku
models with substantial trial quotas.

## Features

- **Multiple Auth Methods**: Supports AWS Builder ID (IDC), IAM Identity Center (custom
  Start URL), and Kiro Desktop (CLI-based) authentication.
- **Auto-Sync Kiro CLI**: Automatically imports and synchronizes active sessions from
  your local `kiro-cli` SQLite database.
- **Gradual Context Truncation**: Intelligently prevents error 400 by reducing context
  size dynamically during retries.
- **Intelligent Account Rotation**: Prioritizes multi-account usage based on lowest
  available quota.
- **Interactive Account Manager**: An `opencode auth login` menu to list accounts with
  live status/usage, add accounts, refresh quotas on demand, and delete individual
  accounts or all of them.
- **High-Performance Storage**: Efficient account and usage management using native Bun
  SQLite.
- **Native Thinking Mode**: Streams Kiro's native reasoning to OpenCode's thinking
  block, with the reasoning flags declared on every thinking model, so it renders
  without any model configuration.
- **Kiro Effort Mapping**: Maps OpenCode thinking budgets to Kiro's native effort
  levels automatically, across the full `low`–`max` ladder.
- **Automated Recovery**: Exponential backoff for rate limits and automated token
  refresh.

## Installation

Add the plugin to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@zhafron/opencode-kiro-auth"]
}
```

That is the whole configuration. The plugin registers the `kiro` provider and
advertises every model Kiro exposes, including a `-thinking` companion for each
model that supports reasoning effort. Run `/models` to pick one.

Defining `provider.kiro.models` yourself replaces the plugin's registry entirely.
Only do that to rename or restrict models, and see the reasoning flags below if
any of them are `-thinking` models.

### Thinking Effort Configuration

Every effort-capable Claude model gets a `-thinking` companion, already carrying
the reasoning flags and an effort ladder as variants. Nothing to configure: pick a
`-thinking` model and cycle its variants to change reasoning depth.

Each `-thinking` entry declares two fields that OpenCode needs in order to render
reasoning:

```json
{
  "reasoning": true,
  "interleaved": { "field": "reasoning_content" }
}
```

Both are required. `reasoning` declares the capability, and `interleaved.field`
tells OpenCode that reasoning arrives in the non-standard `reasoning_content`
delta this plugin emits. If either is missing, OpenCode silently drops every
reasoning chunk and no thinking block appears.

If you override `provider.kiro.models` in your own config, you replace the
plugin's registry wholesale — copy both fields onto any `-thinking` model you
define, or reasoning will stop rendering.

Reasoning itself comes from the API: Kiro streams `reasoningContentEvent` on
thinking models, and the plugin forwards each one as a `reasoning_content` delta.
Nothing needs to be enabled for that. Models that instead inline reasoning as
`<thinking>` tags in their answer are still handled, via a fallback scraper.

Variants set `thinkingConfig.thinkingBudget`, which the plugin maps to Kiro's
native `effort` field. Bands are scaled to Kiro's real thinking ceiling
(1024-128000 on opus-4.8/opus-5), so every effort level including `xhigh` is
reachable from a budget alone:

| OpenCode budget | Kiro effort |
| --------------- | ----------- |
| `<= 16384` | `low` |
| `<= 32768` | `medium` |
| `<= 65536` | `high` |
| `<= 98304` | `xhigh` |
| `> 98304` | `max` |

`xhigh` is only available on opus-4.7, opus-4.8, opus-5 and sonnet-5. Those models
get a five-variant ladder; the rest get four, and a budget in the `xhigh` band is
clamped to `max`.

Kiro's GPT-5.6 tiers are not advertised. They configure reasoning through
`reasoning.effort` / `reasoning.mode` instead of `output_config.effort`, so they
need a separate request path.

Use `~/.config/opencode/kiro.json` for plugin-wide behavior such as auth sync,
account selection, retry limits, and `auto_effort_mapping`. A top-level `effort`
setting is a global override for all supported models, not a per-model setting.

## Setup

1. **Authentication via Kiro CLI (Recommended)**:
   - Perform login directly in your terminal using `kiro-cli login`.
   - The plugin automatically bootstraps a minimal `kiro` placeholder in
     OpenCode's `auth.json` when it detects the Kiro CLI database, then imports
     and synchronizes your active session on startup.
   - For AWS IAM Identity Center (SSO/IDC), the plugin imports both the token and device
     registration (OIDC client credentials) from the `kiro-cli` database.
2. **Direct Authentication**:
   - Run `opencode auth login`.
   - Select `Other`, type `kiro`, and press enter.
   - You'll be prompted for your **IAM Identity Center Start URL** and **IAM Identity
     Center region** (`sso_region`).
     - Leave it blank to sign in with **AWS Builder ID**.
     - Enter your company's Start URL (e.g. `https://your-company.awsapps.com/start`) to
       use **IAM Identity Center (SSO)**.
   - Note: the TUI `/connect` flow currently does **not** run plugin OAuth prompts
     (Start URL / region), so Identity Center logins may fall back to Builder ID unless
     you use `opencode auth login` (or preconfigure defaults in
     `~/.config/opencode/kiro.json`).
   - For **IAM Identity Center**, you may also need a **profile ARN** (`profileArn`).
     - If `kiro-cli` is installed and you've selected a profile once
       (`kiro-cli profile`), the plugin auto-detects it.
     - Otherwise, set `idc_profile_arn` in `~/.config/opencode/kiro.json`.
   - A browser window will open directly to AWS' verification URL (no local auth
     server). If it doesn't, copy/paste the URL and enter the code printed by OpenCode.
   - You can also pre-configure defaults in `~/.config/opencode/kiro.json` via
     `idc_start_url` and `idc_region`.
3. Configuration will be automatically managed at `~/.config/opencode/kiro.db`.

### Managing accounts

Run `opencode auth login`, select `kiro`, then choose **Manage accounts (list · quotas ·
delete)** to open an interactive menu:

- **Add account** — starts the AWS Builder ID device flow and adds the account to the
  rotation pool. (For IAM Identity Center with a Start URL / profile ARN, use the
  dedicated login methods listed below the menu instead.)
- **Check quotas (refresh all)** — refreshes each account's token if needed and fetches
  live usage, printing `used/limit (%)` per account.
- **Per-account actions** — select an account to view its status/usage/region and delete
  it.
- **Delete all accounts** — clears every stored account (asks for confirmation).

The menu requires an interactive terminal. In non-interactive contexts (SSH pipes, CI) it
falls back to the plain add-account flow.

## Local plugin development

The simplest way to test local changes is to point OpenCode directly at your local repo
path in `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["/path/to/opencode-kiro-auth"]
}
```

Then build and restart OpenCode to pick up changes:

```bash
npm run build
```

## Troubleshooting

### Error: Status: 403 (AccessDeniedException / User is not authorized)

If you're using **IAM Identity Center** (a custom Start URL), the Q Developer /
CodeWhisperer APIs typically require a **profile ARN**.

This plugin reads the active profile ARN from your local `kiro-cli` database
(`state.key = api.codewhisperer.profile`) and sends it as `profileArn`.

Fix:

1. Run `kiro-cli profile` and select a profile (e.g. `QDevProfile-us-east-1`).
2. Retry `opencode auth login` (or restart OpenCode so it re-syncs).

### Error: No accounts

This happens when the plugin has no records in `~/.config/opencode/kiro.db`.

1. Ensure `kiro-cli login` succeeds.
2. Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro.json`.
3. Retry the request; the plugin will attempt a Kiro CLI sync when it detects zero
   accounts.

### Note: `/connect` vs `opencode auth login`

If you need to enter provider-specific values for an OAuth login (like IAM Identity
Center Start URL / region), use `opencode auth login`. The current TUI `/connect` flow
may not display plugin OAuth prompts, so it can’t collect those inputs.

Note for IDC/SSO (ODIC): the plugin may temporarily create an account with a placeholder
email if it cannot fetch the real email during sync (e.g. offline).
It will replace it with the real email once usage/email lookup succeeds.

### Kiro CLI (Google/GitHub OAuth) users: plugin sync does not start

If you authenticated via `kiro-cli login` using Google or GitHub OAuth (not AWS Builder
ID or IAM Identity Center), OpenCode still needs a stored `kiro` auth entry before it
will call the plugin loader.

The plugin now creates that minimal placeholder automatically when it detects the local
Kiro CLI database. Restart OpenCode after `kiro-cli login`; the loader should then run
and sync your actual tokens into `kiro.db`. The placeholder values are not used for API
calls.

If bootstrap is skipped because `auth.json` is malformed, fix the JSON first. The plugin
will not overwrite malformed auth files because they may contain other provider
credentials.

**Important:** Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro.json`
and that `kiro-cli login` succeeds.

The plugin supports extensive configuration options.
Edit `~/.config/opencode/kiro.json`:

```json
{
  "auto_sync_kiro_cli": true,
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "idc_start_url": "https://your-company.awsapps.com/start",
  "idc_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 20,
  "request_timeout_ms": 120000,
  "token_expiry_buffer_ms": 120000,
  "usage_sync_max_retries": 3,
  "usage_tracking_enabled": true,
  "auto_effort_mapping": true,
  "enable_log_api_request": false
}
```

### Configuration Options

- `auto_sync_kiro_cli`: Automatically sync sessions from Kiro CLI (default: `true`).
- `account_selection_strategy`: Account rotation strategy (`sticky`, `round-robin`,
  `lowest-usage`).
- `default_region`: AWS region (`us-east-1`, `us-west-2`).
- `idc_start_url`: Default IAM Identity Center Start URL (e.g.
  `https://your-company.awsapps.com/start`). Leave unset/blank to default to AWS Builder
  ID.
- `idc_region`: IAM Identity Center (SSO OIDC) region (`sso_region`). Defaults to
  `us-east-1`.
- `rate_limit_retry_delay_ms`: Delay between rate limit retries (1000-60000ms).
- `rate_limit_max_retries`: Maximum retry attempts for rate limits (0-10).
- `max_request_iterations`: Maximum loop iterations to prevent hangs (10-1000).
- `request_timeout_ms`: Request timeout in milliseconds (60000-600000ms).
- `token_expiry_buffer_ms`: Token refresh buffer time (30000-300000ms).
- `usage_sync_max_retries`: Retry attempts for usage sync (0-5).
- `auth_server_port_start`: Legacy/ignored (no local auth server).
- `auth_server_port_range`: Legacy/ignored (no local auth server).
- `usage_tracking_enabled`: Enable usage tracking and toast notifications.
- `auto_effort_mapping`: Automatically map OpenCode thinking budgets to Kiro effort
  levels for supported models (default: `true`).
- `enable_log_api_request`: Enable detailed API request logging. Request logs
  include the resolved `additionalModelRequestFields`, so this is how you confirm
  which effort level actually went out on the wire.

## Storage

**Linux/macOS:**

- SQLite Database: `~/.config/opencode/kiro.db`
- Plugin Config: `~/.config/opencode/kiro.json`

**Windows:**

- SQLite Database: `%APPDATA%\opencode\kiro.db`
- Plugin Config: `%APPDATA%\opencode\kiro.json`

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for
providing the foundational Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes.
It is an independent implementation and is not affiliated with, endorsed by, or
supported by Amazon Web Services (AWS) or Anthropic.
Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.
