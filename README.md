# OpenCode Kiro Auth Plugin

OpenCode plugin for AWS Kiro (CodeWhisperer) providing access to Claude Sonnet and Haiku models with substantial trial quotas.

## Features

- **Multiple Auth Methods**: Supports AWS Builder ID, AWS Identity Center, and Kiro Desktop (CLI-based) authentication.
- **Auto-Sync Kiro CLI**: Automatically imports and synchronizes active sessions from your local `kiro-cli` SQLite database.
- **Gradual Context Truncation**: Intelligently prevents error 400 by reducing context size dynamically during retries.
- **Intelligent Account Rotation**: Prioritizes multi-account usage based on lowest available quota.
- **High-Performance Storage**: Efficient account and usage management using native Bun SQLite.
- **Native Thinking Mode**: Full support for Claude reasoning capabilities via virtual model mappings.
- **Automated Recovery**: Exponential backoff for rate limits and automated token refresh.

## Installation

This plugin is not published to npm. Follow these steps to install it locally:

### Step 1: Clone the Repository

```bash
git clone https://github.com/jtdelia/opencode-kiro-auth.git
cd opencode-kiro-auth
```

### Step 2: Install Dependencies

```bash
npm install
# or
bun install
```

### Step 3: Build the Plugin

```bash
npm run build
# or
bun run build
```

This will compile the TypeScript code and generate the `dist` directory with the compiled JavaScript files.

### Step 4: Link the Plugin Globally

```bash
npm link
```

This creates a symlink in your global `node_modules` directory, making the plugin available system-wide. The plugin will be safely stored in `~/.config/opencode/node_modules` (or equivalent on your system) and won't be affected if you delete the cloned repository.

### Step 5: Configure OpenCode

Add the plugin to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["opencode-kiro-auth"],
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

### Step 6: Restart OpenCode

After updating your configuration, restart OpenCode or reload the window to load the plugin.

### Updating the Plugin

To update the plugin after pulling new changes:

```bash
cd opencode-kiro-auth
git pull
npm install  # Install any new dependencies
npm run build  # Rebuild the plugin
```

The linked plugin will automatically use the updated version.

### Uninstalling

To remove the plugin:

```bash
npm unlink -g opencode-kiro-auth
```

Then remove the plugin entry from your `opencode.json`.

## Setup

### Authentication Methods

The plugin supports three authentication methods:

1. **AWS Builder ID** - Personal AWS account for individual developers
2. **AWS Identity Center** - Organization-managed authentication with custom identity providers
3. **Kiro CLI Sync** - Automatic import of sessions from `kiro-cli`

### Option 1: Authentication via Kiro CLI (Recommended)

- Perform login directly in your terminal using `kiro-cli login`.
- The plugin will automatically detect and import your session on startup.

### Option 2: Direct Authentication with AWS Builder ID

1. Run `opencode auth login`.
2. Select `Other`, type `kiro`, and press enter.
3. When prompted, select **AWS Builder ID** (option 1).
4. Follow the browser authentication flow.
5. Your account will be stored and automatically refreshed.

### Option 3: Direct Authentication with AWS Identity Center

For organizations using AWS Identity Center with custom identity providers:

1. Run `opencode auth login`.
2. Select `Other`, type `kiro`, and press enter.
3. When prompted, select **AWS Identity Center** (option 2).
4. Enter your organization's Identity Center start URL:
   - Format: `https://your-org.awsapps.com/start`
   - Must use HTTPS protocol
   - Obtain this URL from your AWS administrator
5. Enter the AWS region (default: `us-east-1`):
   - Supported regions: `us-east-1`, `us-west-2`
   - Press Enter to use the default
6. Complete the browser authentication flow with your organization's identity provider.
7. Your account will be stored with automatic token refresh.

### Finding Your Identity Center Start URL

If you're unsure of your organization's Identity Center start URL:

1. Contact your AWS administrator or IT department
2. Check your organization's AWS documentation
3. Look for emails from AWS with subject "AWS IAM Identity Center access portal"
4. The URL typically follows the pattern: `https://[subdomain].awsapps.com/start`

### Configuration Storage

Configuration will be automatically managed at `~/.config/opencode/kiro.db`.

## Configuration

The plugin supports extensive configuration options. Edit `~/.config/opencode/kiro.json`:

```json
{
  "auto_sync_kiro_cli": true,
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
  "enable_log_api_request": false
}
```

### Configuration Options

- `auto_sync_kiro_cli`: Automatically sync sessions from Kiro CLI (default: `true`).
- `account_selection_strategy`: Account rotation strategy (`sticky`, `round-robin`, `lowest-usage`).
- `default_region`: AWS region (`us-east-1`, `us-west-2`).
- `rate_limit_retry_delay_ms`: Delay between rate limit retries (1000-60000ms).
- `rate_limit_max_retries`: Maximum retry attempts for rate limits (0-10).
- `max_request_iterations`: Maximum loop iterations to prevent hangs (10-1000).
- `request_timeout_ms`: Request timeout in milliseconds (60000-600000ms).
- `token_expiry_buffer_ms`: Token refresh buffer time (30000-300000ms).
- `usage_sync_max_retries`: Retry attempts for usage sync (0-5).
- `auth_server_port_start`: Starting port for auth server (1024-65535).
- `auth_server_port_range`: Number of ports to try (1-100).
- `usage_tracking_enabled`: Enable usage tracking and toast notifications.
- `enable_log_api_request`: Enable detailed API request logging.

## Storage

**Linux/macOS:**
- SQLite Database: `~/.config/opencode/kiro.db`
- Plugin Config: `~/.config/opencode/kiro.json`

**Windows:**
- SQLite Database: `%APPDATA%\opencode\kiro.db`
- Plugin Config: `%APPDATA%\opencode\kiro.json`

## Troubleshooting

### Authentication Issues

**Start URL Validation Errors**:
- Ensure your Identity Center start URL uses HTTPS protocol
- Verify the URL format: `https://[subdomain].awsapps.com/start`
- Contact your AWS administrator if you're unsure of the correct URL

**Region Configuration**:
- Only `us-east-1` and `us-west-2` are currently supported
- Press Enter to use the default region (`us-east-1`)
- Verify with your AWS administrator which region your Identity Center uses

**Token Refresh Failures**:
- The plugin automatically refreshes expired tokens
- If refresh fails, try re-authenticating: `opencode auth login`
- Check that your Identity Center account is still active

### Account Management

**List all accounts**:
```bash
sqlite3 ~/.config/opencode/kiro.db "SELECT email, auth_method, region FROM accounts;"
```

**Remove a specific account**:
```bash
sqlite3 ~/.config/opencode/kiro.db "DELETE FROM accounts WHERE email = 'your-email@example.com';"
```

**Check account health**:
```bash
sqlite3 ~/.config/opencode/kiro.db "SELECT email, is_healthy, unhealthy_reason FROM accounts;"
```

### Additional Resources

For detailed Identity Center setup instructions, see:
- [Identity Center Setup Guide](.kiro/specs/aws-identity-center-auth/IDENTITY_CENTER_SETUP.md)
- [Manual Testing Guide](.kiro/specs/aws-identity-center-auth/MANUAL_TESTING_GUIDE.md)

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for providing the foundational Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes. It is an independent implementation and is not affiliated with, endorsed by, or supported by Amazon Web Services (AWS) or Anthropic. Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.
