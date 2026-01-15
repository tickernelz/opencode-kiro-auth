# OpenCode Kiro Auth Plugin - Architecture

## Overview

The opencode-kiro-auth plugin provides authentication and request transformation for AWS Kiro (CodeWhisperer) API, enabling access to Claude models through OpenCode.

## Architecture Layers

### 1. Authentication Layer
- **Social OAuth**: Google OAuth with PKCE flow
- **IDC OAuth**: AWS OIDC (Builder ID) with device flow
- **Token Management**: Automatic refresh with 60s buffer
- **Multi-Account**: Support for multiple accounts with rotation

### 2. Request Transformation Layer
- **Input**: OpenAI-compatible format
- **Output**: AWS CodeWhisperer format
- **Features**:
  - Model mapping (OpenAI names → Kiro names)
  - Tool conversion (OpenAI tools → CodeWhisperer toolSpecification)
  - Message merging (adjacent same-role messages)
  - Thinking mode injection (configurable)
  - Multimodal support (images)

### 3. Response Parsing Layer
- **Input**: AWS Event Stream format
- **Output**: Claude SSE format
- **Features**:
  - Event stream parsing
  - Thinking block extraction
  - Tool call parsing (structured + bracket format)
  - Token usage extraction

### 4. Account Management Layer
- **Storage**: File-based with atomic writes
- **Rotation**: Sticky or round-robin strategies
- **Health Tracking**: Mark unhealthy accounts
- **Rate Limiting**: Per-account rate limit tracking
- **Quota Monitoring**: Usage tracking with recovery time

### 5. Error Handling Layer
- **Recoverable Errors**: Network, rate limit, token expiry
- **Unrecoverable Errors**: Quota exhausted, forbidden
- **Session Recovery**: Auto-resume on recoverable errors
- **Retry Logic**: Exponential backoff

### 6. Configuration Layer
- **Schema**: Zod-based validation
- **Priority**: Env vars > Project config > User config > Defaults
- **Options**: 17+ configuration options

## Data Flow

```
OpenCode Request
  ↓
Plugin Intercept (KIRO_API_PATTERN)
  ↓
Account Selection (getCurrentOrNext)
  ↓
Token Refresh (if expired)
  ↓
Request Transformation (OpenAI → CodeWhisperer)
  ↓
Kiro API Call
  ↓
Error Handling (401/402/403/429)
  ↓
Response Parsing (Event Stream → Claude)
  ↓
Usage Tracking (fetchUsageLimits)
  ↓
OpenCode Response
```

## Key Components

### AccountManager
- Manages multiple Kiro accounts
- Implements rotation strategies
- Tracks health and rate limits
- Persists to disk atomically

### ProactiveRefreshQueue
- Background token refresh
- Checks every 5 minutes (configurable)
- Refreshes tokens within 10-minute buffer
- Prevents request blocking

### SessionRecoveryHook
- Tracks session errors
- Determines recoverability
- Auto-resumes on recoverable errors
- Limits retry attempts (max 3)

### Request Transformer
- Converts OpenAI format to CodeWhisperer
- Handles tools, images, thinking mode
- Generates conversation IDs
- Builds proper headers

### Response Parser
- Parses AWS Event Stream
- Extracts thinking blocks
- Parses tool calls (2 formats)
- Deduplicates tool calls

## File Structure

```
src/
├── plugin.ts                 # Main plugin integration
├── constants.ts              # API endpoints, model mappings
├── kiro/
│   ├── oauth-social.ts       # Google OAuth flow
│   ├── oauth-idc.ts          # AWS OIDC flow
│   └── auth.ts               # Auth helpers
├── plugin/
│   ├── accounts.ts           # Account manager
│   ├── storage.ts            # File storage
│   ├── token.ts              # Token refresh
│   ├── request.ts            # Request transformation
│   ├── response.ts           # Response parsing
│   ├── streaming.ts          # SSE streaming
│   ├── usage.ts              # Usage tracking
│   ├── quota.ts              # Quota management
│   ├── recovery.ts           # Session recovery
│   ├── refresh-queue.ts      # Proactive refresh
│   ├── errors.ts             # Custom errors
│   ├── server.ts             # OAuth callback server
│   ├── cli.ts                # Interactive prompts
│   └── config/               # Configuration system
└── hooks/
    └── auto-update-checker/  # Update notifications
```

## Security

- PKCE for OAuth flows
- Atomic file writes with locking
- Token refresh with error handling
- No credentials in logs (unless debug)
- Secure storage in XDG config directory
