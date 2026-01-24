# OpenCode Kiro Auth Plugin
[![npm version](https://img.shields.io/npm/v/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@zhafron/opencode-kiro-auth)](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)

OpenCode plugin for AWS Kiro (CodeWhisperer) providing access to Claude Sonnet and Haiku models with substantial trial quotas.

## Features

- **Multiple Authentication Methods**: AWS Builder ID (personal) and AWS SSO (enterprise)
- AWS Builder ID (IDC) authentication with seamless device code flow
- AWS SSO (IAM Identity Center) for enterprise users with organization identity providers
- Intelligent multi-account rotation prioritized by lowest usage
- Automated token refresh and rate limit handling with exponential backoff
- Native thinking mode support via virtual model mappings
- Decoupled storage for credentials and real-time usage metadata
- Configurable request timeout and iteration limits to prevent hangs
- Automatic port selection for auth server to avoid conflicts
- Usage tracking with automatic retry on sync failures

## Installation

Add the plugin to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@zhafron/opencode-kiro-auth"],
  "provider": {
    "kiro": {
      "models": {
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
```

## Setup

### AWS Builder ID (Personal)

1. Run `opencode auth login`.
2. Select `Other`, type `kiro`, and press enter.
3. Select `AWS Builder ID (IDC)`.
4. Follow the terminal instructions to complete the AWS Builder ID authentication.
5. Configuration template will be automatically created at `~/.config/opencode/kiro.json` on first load.

### AWS SSO (Enterprise/Organization)

For organizations using AWS IAM Identity Center with corporate identity providers (Okta, Azure AD, etc.).

#### Prerequisites

1. Your organization must have IAM Identity Center enabled
2. You need your organization's SSO start URL (e.g., `https://my-org.awsapps.com/start`)
3. Your admin must grant you appropriate permissions (e.g., PowerUserAccess)

#### Finding Your SSO Start URL

You can find your SSO start URL in one of these ways:
- Contact your AWS administrator
- Check your AWS access portal URL
- Find it in IAM Identity Center console under Settings → AWS access portal URL

#### Configuration (Optional)

You can pre-configure your SSO start URL in `~/.config/opencode/kiro.json`:

```json
{
  "sso_start_url": "https://my-org.awsapps.com/start",
  "sso_region": "us-east-1"
}
```

#### Login

1. Run `opencode auth login`.
2. Select `Other`, type `kiro`, and press enter.
3. Select `AWS SSO (IAM Identity Center)`.
4. Enter your SSO start URL when prompted (if not pre-configured).
5. Complete authentication in your browser using your organization's identity provider.

### Multi-Account Support

Both authentication methods support multiple accounts:
- Mix and match Builder ID and SSO accounts
- Automatic rotation based on usage and rate limits
- Each account tracked independently

## Configuration

The plugin supports extensive configuration options. Edit `~/.config/opencode/kiro.json`:

```json
{
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 100,
  "request_timeout_ms": 300000,
  "token_expiry_buffer_ms": 120000,
  "usage_sync_max_retries": 3,
  "auth_server_port_start": 19847,
  "auth_server_port_range": 10,
  "usage_tracking_enabled": true,
  "enable_log_api_request": false,
  "sso_start_url": "https://my-org.awsapps.com/start",
  "sso_region": "us-east-1"
}
```

### Configuration Options

- `account_selection_strategy`: Account rotation strategy (`sticky`, `round-robin`, `lowest-usage`)
- `default_region`: AWS region (`us-east-1`, `us-west-2`)
- `rate_limit_retry_delay_ms`: Delay between rate limit retries (1000-60000ms)
- `rate_limit_max_retries`: Maximum retry attempts for rate limits (0-10)
- `max_request_iterations`: Maximum loop iterations to prevent hangs (10-1000)
- `request_timeout_ms`: Request timeout in milliseconds (60000-600000ms)
- `token_expiry_buffer_ms`: Token refresh buffer time (30000-300000ms)
- `usage_sync_max_retries`: Retry attempts for usage sync (0-5)
- `auth_server_port_start`: Starting port for auth server (1024-65535)
- `auth_server_port_range`: Number of ports to try (1-100)
- `usage_tracking_enabled`: Enable usage tracking and toast notifications
- `enable_log_api_request`: Enable detailed API request logging
- `sso_start_url`: (Optional) Pre-configure your organization's SSO start URL
- `sso_region`: (Optional) AWS region for SSO authentication

### Environment Variables

All configuration options can be overridden via environment variables:

- `KIRO_ACCOUNT_SELECTION_STRATEGY`
- `KIRO_DEFAULT_REGION`
- `KIRO_RATE_LIMIT_RETRY_DELAY_MS`
- `KIRO_RATE_LIMIT_MAX_RETRIES`
- `KIRO_MAX_REQUEST_ITERATIONS`
- `KIRO_REQUEST_TIMEOUT_MS`
- `KIRO_TOKEN_EXPIRY_BUFFER_MS`
- `KIRO_USAGE_SYNC_MAX_RETRIES`
- `KIRO_AUTH_SERVER_PORT_START`
- `KIRO_AUTH_SERVER_PORT_RANGE`
- `KIRO_USAGE_TRACKING_ENABLED`
- `KIRO_ENABLE_LOG_API_REQUEST`
- `KIRO_SSO_START_URL`
- `KIRO_SSO_REGION`

## Storage

**Linux/macOS:**
- Credentials: `~/.config/opencode/kiro-accounts.json`
- Usage Tracking: `~/.config/opencode/kiro-usage.json`
- Plugin Config: `~/.config/opencode/kiro.json`

**Windows:**
- Credentials: `%APPDATA%\opencode\kiro-accounts.json`
- Usage Tracking: `%APPDATA%\opencode\kiro-usage.json`
- Plugin Config: `%APPDATA%\opencode\kiro.json`

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for providing the foundational Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes. It is an independent implementation and is not affiliated with, endorsed by, or supported by Amazon Web Services (AWS) or Anthropic. Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.
