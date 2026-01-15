# OpenCode Kiro Auth Plugin - Setup Guide

## Installation

```bash
npm install opencode-kiro-auth
```

## Configuration

Create configuration file at `~/.config/opencode/kiro.json` or `.opencode/kiro.json`:

```json
{
  "thinking_enabled": false,
  "account_selection_strategy": "sticky",
  "proactive_token_refresh": true,
  "session_recovery": true,
  "default_region": "us-east-1"
}
```

## Authentication Methods

### Google OAuth (Social)
1. Run OpenCode with Kiro plugin
2. Select "Google OAuth (Social)" method
3. Choose region (us-east-1 or us-west-2)
4. Open browser URL displayed
5. Complete Google OAuth flow
6. Account will be saved automatically

### AWS Builder ID (IDC)
1. Run OpenCode with Kiro plugin
2. Select "AWS Builder ID (IDC)" method
3. Choose region (us-east-1 or us-west-2)
4. Open browser URL displayed
5. Complete AWS OIDC flow
6. Account will be saved automatically

## Supported Models

- claude-opus-4-5
- claude-opus-4-5-20251101
- claude-haiku-4-5
- claude-sonnet-4-5
- claude-sonnet-4-5-20250929
- claude-sonnet-4-20250514
- claude-3-7-sonnet-20250219

## Features

- Multi-account rotation with automatic failover
- Proactive token refresh (background)
- Session recovery on errors
- Usage tracking and quota monitoring
- Rate limit handling with exponential backoff
- Thinking mode support (configurable)
- Streaming and non-streaming responses

## Environment Variables

All configuration options can be overridden via environment variables:

- `KIRO_DEBUG=true` - Enable debug logging
- `KIRO_THINKING_ENABLED=true` - Enable thinking mode
- `KIRO_DEFAULT_REGION=us-west-2` - Set default region
- `KIRO_ACCOUNT_SELECTION_STRATEGY=round-robin` - Change account strategy

## Storage Locations

- Accounts: `~/.config/opencode/kiro-accounts.json`
- Recovery state: `~/.config/opencode/kiro-recovery.json`
- Configuration: `~/.config/opencode/kiro.json` or `.opencode/kiro.json`
