import { generatePKCE } from '@openauthjs/openauth/pkce';
import type { KiroRegion } from '../plugin/types';
import { KIRO_AUTH_SERVICE, KIRO_CONSTANTS } from '../constants';

export interface KiroIDCAuthorization {
  url: string;
  verifier: string;
  region: KiroRegion;
  deviceCode?: string;
  userCode?: string;
}

export interface KiroIDCTokenResult {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  email: string;
  clientId: string;
  clientSecret: string;
  region: KiroRegion;
  authMethod: 'idc';
}

export async function authorizeKiroIDC(region?: KiroRegion): Promise<KiroIDCAuthorization> {
  const effectiveRegion = region || KIRO_CONSTANTS.DEFAULT_REGION;
  
  const pkce = await generatePKCE();
  const verifier = pkce.verifier;
  
  const ssoOIDCEndpoint = KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT.replace('{{region}}', effectiveRegion);
  
  const registerResponse = await fetch(`${ssoOIDCEndpoint}/client/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_CONSTANTS.USER_AGENT,
    },
    body: JSON.stringify({
      clientName: 'Kiro IDE',
      clientType: 'public',
      scopes: KIRO_AUTH_SERVICE.SCOPES,
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    }),
  });
  
  if (!registerResponse.ok) {
    throw new Error(`Client registration failed: ${registerResponse.status}`);
  }
  
  const registerData = await registerResponse.json();
  const { clientId, clientSecret } = registerData;
  
  const deviceAuthResponse = await fetch(`${ssoOIDCEndpoint}/device_authorization`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_CONSTANTS.USER_AGENT,
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      startUrl: KIRO_AUTH_SERVICE.BUILDER_ID_START_URL,
    }),
  });
  
  if (!deviceAuthResponse.ok) {
    throw new Error(`Device authorization failed: ${deviceAuthResponse.status}`);
  }
  
  const deviceAuthData = await deviceAuthResponse.json();
  
  const state = Buffer.from(JSON.stringify({ 
    verifier, 
    region: effectiveRegion,
    clientId,
    clientSecret,
  })).toString('base64url');
  
  return {
    url: deviceAuthData.verificationUriComplete,
    verifier,
    region: effectiveRegion,
    deviceCode: deviceAuthData.deviceCode,
    userCode: deviceAuthData.userCode,
  };
}

export async function exchangeKiroIDC(code: string, state: string): Promise<KiroIDCTokenResult> {
  const decodedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
  const { verifier, region, clientId, clientSecret } = decodedState;
  
  if (!verifier || !region || !clientId || !clientSecret) {
    throw new Error('Invalid state parameter');
  }
  
  const ssoOIDCEndpoint = KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT.replace('{{region}}', region);
  
  const tokenResponse = await fetch(`${ssoOIDCEndpoint}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_CONSTANTS.USER_AGENT,
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      deviceCode: code,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  
  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`);
  }
  
  const tokenData = await tokenResponse.json();
  
  if (!tokenData.accessToken || !tokenData.refreshToken) {
    throw new Error('Invalid token response: missing required fields');
  }
  
  const expiresIn = tokenData.expiresIn || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  
  const email = 'builder-id@aws.amazon.com';
  
  return {
    refreshToken: tokenData.refreshToken,
    accessToken: tokenData.accessToken,
    expiresAt,
    email,
    clientId,
    clientSecret,
    region,
    authMethod: 'idc',
  };
}
