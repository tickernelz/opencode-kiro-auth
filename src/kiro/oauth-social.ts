import { generatePKCE } from '@openauthjs/openauth/pkce';
import type { KiroRegion } from '../plugin/types';
import { KIRO_AUTH_SERVICE, KIRO_CONSTANTS } from '../constants';

export interface KiroSocialAuthorization {
  url: string;
  verifier: string;
  region: KiroRegion;
}

export interface KiroSocialTokenResult {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  email: string;
  profileArn: string;
  region: KiroRegion;
  authMethod: 'social';
}

export async function authorizeKiroSocial(region?: KiroRegion): Promise<KiroSocialAuthorization> {
  const effectiveRegion = region || KIRO_CONSTANTS.DEFAULT_REGION;
  
  const pkce = await generatePKCE();
  const verifier = pkce.verifier;
  const challenge = pkce.challenge;
  
  const state = Buffer.from(JSON.stringify({ 
    verifier, 
    region: effectiveRegion 
  })).toString('base64url');
  
  const authServiceEndpoint = KIRO_AUTH_SERVICE.ENDPOINT.replace('{{region}}', effectiveRegion);
  const redirectUri = 'http://localhost:8080/callback';
  
  const params = new URLSearchParams({
    idp: 'Google',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: state,
    prompt: 'select_account',
  });
  
  const url = `${authServiceEndpoint}/login?${params.toString()}`;
  
  return {
    url,
    verifier,
    region: effectiveRegion,
  };
}

export async function exchangeKiroSocial(code: string, state: string): Promise<KiroSocialTokenResult> {
  const decodedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
  const { verifier, region } = decodedState;
  
  if (!verifier || !region) {
    throw new Error('Invalid state parameter');
  }
  
  const authServiceEndpoint = KIRO_AUTH_SERVICE.ENDPOINT.replace('{{region}}', region);
  const redirectUri = 'http://localhost:8080/callback';
  
  const tokenResponse = await fetch(`${authServiceEndpoint}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': KIRO_CONSTANTS.USER_AGENT,
    },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  
  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${errorText}`);
  }
  
  const tokenData = await tokenResponse.json();
  
  if (!tokenData.accessToken || !tokenData.refreshToken || !tokenData.profileArn) {
    throw new Error('Invalid token response: missing required fields');
  }
  
  const expiresIn = tokenData.expiresIn || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  
  const email = tokenData.email || 'unknown@kiro.dev';
  
  return {
    refreshToken: tokenData.refreshToken,
    accessToken: tokenData.accessToken,
    expiresAt,
    email,
    profileArn: tokenData.profileArn,
    region,
    authMethod: 'social',
  };
}
