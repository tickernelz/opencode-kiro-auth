#!/usr/bin/env bun

// Test script to simulate an AWS Q API request using stored credentials
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import crypto from 'crypto';

function getBaseDir() {
  const p = process.platform;
  if (p === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
}

const dbPath = join(getBaseDir(), 'kiro.db');

try {
  const db = new Database(dbPath, { readonly: true });
  
  // Get the Identity Center account
  const account = db.prepare('SELECT * FROM accounts WHERE auth_method = ? LIMIT 1')
    .get('identity-center');
  
  if (!account) {
    console.error('No Identity Center account found in database');
    process.exit(1);
  }
  
  console.log('Found account:', account.email);
  console.log('Region:', account.region);
  console.log('Token expires:', new Date(account.expires_at).toISOString());
  console.log('Token expired:', Date.now() >= account.expires_at ? 'YES' : 'No');
  console.log('');
  
  db.close();
  
  // Check if token is expired
  if (Date.now() >= account.expires_at) {
    console.error('ERROR: Access token is expired. Please re-authenticate.');
    process.exit(1);
  }
  
  // Build the API request
  const region = account.region;
  const url = `https://q.${region}.amazonaws.com/generateAssistantResponse`;
  
  // Create a minimal request body (similar to what the plugin sends)
  const conversationId = crypto.randomUUID();
  const requestBody = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: conversationId,
      currentMessage: {
        userInputMessage: {
          content: 'Hello, this is a test message',
          modelId: 'CLAUDE_SONNET_4_5_20250929_V1_0',
          origin: 'AI_EDITOR'
        }
      }
    }
  };
  
  // Generate machine ID (same as plugin)
  const machineId = crypto
    .createHash('sha256')
    .update(account.profile_arn || account.client_id || 'KIRO_DEFAULT_MACHINE')
    .digest('hex');
  
  const kiroVersion = '0.7.5';
  const nodeVersion = process.version.replace('v', '');
  const osP = process.platform;
  const osR = process.release;
  const osN = osP === 'win32' ? `windows#${osR}` : osP === 'darwin' ? `macos#${osR}` : `${osP}#${osR}`;
  const userAgent = `aws-sdk-js/1.0.0 ua/2.1 os/${osN} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`;
  
  console.log('Making request to:', url);
  console.log('Conversation ID:', conversationId);
  console.log('');
  
  // Make the request
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${account.access_token}`,
      'amz-sdk-invocation-id': crypto.randomUUID(),
      'amz-sdk-request': 'attempt=1; max=1',
      'x-amzn-kiro-agent-mode': 'vibe',
      'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
      'user-agent': userAgent,
      'Connection': 'close'
    },
    body: JSON.stringify(requestBody)
  });
  
  console.log('Response Status:', response.status, response.statusText);
  console.log('');
  
  // Get response headers
  console.log('Response Headers:');
  response.headers.forEach((value, key) => {
    console.log(`  ${key}: ${value}`);
  });
  console.log('');
  
  // Get response body
  const responseText = await response.text();
  
  if (response.ok) {
    console.log('SUCCESS! Response:');
    try {
      const json = JSON.parse(responseText);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(responseText);
    }
  } else {
    console.log('ERROR Response Body:');
    try {
      const json = JSON.parse(responseText);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(responseText);
    }
  }
  
} catch (error) {
  console.error('Error:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
