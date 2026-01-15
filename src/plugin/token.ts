import type { KiroAuthDetails, KiroAuthMethod, KiroRegion, RefreshParts } from './types';
import { KiroTokenRefreshError } from './errors';
import { decodeRefreshToken, encodeRefreshToken } from './accounts';

const SOCIAL_REFRESH_URL_TEMPLATE = 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken';
const IDC_REFRESH_URL_TEMPLATE = 'https://oidc.{{region}}.amazonaws.com/token';

export function buildRefreshUrl(region: KiroRegion, authMethod: KiroAuthMethod): string {
  const template = authMethod === 'social' ? SOCIAL_REFRESH_URL_TEMPLATE : IDC_REFRESH_URL_TEMPLATE;
  return template.replace('{{region}}', region);
}

export function parseRefreshResponse(
  response: any,
  authMethod: KiroAuthMethod
): { accessToken: string; refreshToken: string; expiresAt: number } {
  if (authMethod === 'social') {
    if (!response.accessToken) {
      throw new KiroTokenRefreshError('Invalid refresh response: Missing accessToken');
    }
    
    const expiresIn = response.expiresIn || 3600;
    const expiresAt = Date.now() + (expiresIn * 1000);
    
    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt,
    };
  } else {
    if (!response.accessToken && !response.access_token) {
      throw new KiroTokenRefreshError('Invalid refresh response: Missing access_token');
    }
    
    const accessToken = response.accessToken || response.access_token;
    const refreshToken = response.refreshToken || response.refresh_token;
    const expiresIn = response.expiresIn || response.expires_in || 3600;
    const expiresAt = Date.now() + (expiresIn * 1000);
    
    return {
      accessToken,
      refreshToken,
      expiresAt,
    };
  }
}

async function refreshSocialToken(
  refreshUrl: string,
  refreshToken: string
): Promise<any> {
  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      refreshToken,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    let errorData: any = {};
    
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText };
    }
    
    const errorCode = errorData.error || errorData.code || `HTTP_${response.status}`;
    const errorMessage = errorData.message || errorData.error_description || errorText;
    
    throw new KiroTokenRefreshError(
      `Social token refresh failed: ${errorMessage}`,
      errorCode,
      new Error(errorText)
    );
  }
  
  return response.json();
}

async function refreshIdcToken(
  refreshUrl: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<any> {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  
  const response = await fetch(refreshUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    let errorData: any = {};
    
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText };
    }
    
    const errorCode = errorData.error || errorData.code || `HTTP_${response.status}`;
    const errorMessage = errorData.message || errorData.error_description || errorText;
    
    throw new KiroTokenRefreshError(
      `IDC token refresh failed: ${errorMessage}`,
      errorCode,
      new Error(errorText)
    );
  }
  
  return response.json();
}

export async function refreshAccessToken(auth: KiroAuthDetails): Promise<KiroAuthDetails> {
  const refreshUrl = buildRefreshUrl(auth.region, auth.authMethod);
  const parts = decodeRefreshToken(auth.refresh);
  
  try {
    let responseData: any;
    
    if (auth.authMethod === 'social') {
      responseData = await refreshSocialToken(refreshUrl, parts.refreshToken);
    } else {
      if (!parts.clientId || !parts.clientSecret) {
        throw new KiroTokenRefreshError(
          'IDC token refresh requires clientId and clientSecret',
          'MISSING_CREDENTIALS'
        );
      }
      
      responseData = await refreshIdcToken(
        refreshUrl,
        parts.refreshToken,
        parts.clientId,
        parts.clientSecret
      );
    }
    
    const parsed = parseRefreshResponse(responseData, auth.authMethod);
    
    const updatedParts: RefreshParts = {
      refreshToken: parsed.refreshToken || parts.refreshToken,
      profileArn: responseData.profileArn || parts.profileArn,
      clientId: parts.clientId,
      clientSecret: parts.clientSecret,
      authMethod: auth.authMethod,
    };
    
    return {
      refresh: encodeRefreshToken(updatedParts),
      access: parsed.accessToken,
      expires: parsed.expiresAt,
      authMethod: auth.authMethod,
      region: auth.region,
      profileArn: responseData.profileArn || auth.profileArn,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      email: auth.email,
    };
  } catch (error) {
    if (error instanceof KiroTokenRefreshError) {
      throw error;
    }
    
    throw new KiroTokenRefreshError(
      `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      'UNKNOWN_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}
