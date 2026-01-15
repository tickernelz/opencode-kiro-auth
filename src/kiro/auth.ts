import type { KiroAuthDetails, RefreshParts } from '../plugin/types';
import { KIRO_CONSTANTS } from '../constants';

export function parseRefreshParts(refresh: string): RefreshParts {
  const parts = refresh.split('|');
  
  if (parts.length < 2) {
    throw new Error('Invalid refresh token format');
  }

  const refreshToken = parts[0]!;
  const authMethod = parts[parts.length - 1]!;

  if (authMethod === 'social') {
    if (parts.length !== 3) {
      throw new Error('Invalid social auth refresh token format');
    }
    const profileArn = parts[1]!;
    return {
      refreshToken,
      profileArn,
      authMethod: 'social',
    };
  } else if (authMethod === 'idc') {
    if (parts.length !== 4) {
      throw new Error('Invalid IDC auth refresh token format');
    }
    const clientId = parts[1]!;
    const clientSecret = parts[2]!;
    return {
      refreshToken,
      clientId,
      clientSecret,
      authMethod: 'idc',
    };
  }

  throw new Error(`Unknown auth method: ${authMethod}`);
}

export function accessTokenExpired(auth: KiroAuthDetails): boolean {
  if (!auth.access || !auth.expires) {
    return true;
  }
  
  const now = Date.now();
  const expiryWithBuffer = auth.expires - KIRO_CONSTANTS.ACCESS_TOKEN_EXPIRY_BUFFER_MS;
  
  return now >= expiryWithBuffer;
}

export function validateAuthDetails(auth: KiroAuthDetails): boolean {
  if (!auth.refresh || !auth.authMethod || !auth.region) {
    return false;
  }

  if (auth.authMethod === 'social') {
    return !!auth.profileArn && !!auth.refresh;
  } else if (auth.authMethod === 'idc') {
    return !!auth.clientId && !!auth.clientSecret && !!auth.refresh;
  }

  return false;
}

export function encodeRefreshToken(parts: RefreshParts): string {
  if (parts.authMethod === 'social') {
    if (!parts.profileArn) {
      throw new Error('Missing profileArn for social auth');
    }
    return `${parts.refreshToken}|${parts.profileArn}|social`;
  } else if (parts.authMethod === 'idc') {
    if (!parts.clientId || !parts.clientSecret) {
      throw new Error('Missing clientId or clientSecret for IDC auth');
    }
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`;
  }

  throw new Error(`Unknown auth method: ${parts.authMethod}`);
}
