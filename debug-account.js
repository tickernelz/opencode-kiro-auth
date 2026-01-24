#!/usr/bin/env bun

// Debug script to check stored account details
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

function getBaseDir() {
  const p = process.platform;
  if (p === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
}

const dbPath = join(getBaseDir(), 'kiro.db');

try {
  const db = new Database(dbPath, { readonly: true });
  
  console.log('\n=== Stored Accounts ===\n');
  console.log(`Database: ${dbPath}\n`);
  
  const accounts = db.prepare('SELECT * FROM accounts').all();
  
  if (accounts.length === 0) {
    console.log('No accounts found in database.');
  } else {
    accounts.forEach((acc, idx) => {
      console.log(`Account ${idx + 1}:`);
      console.log(`  ID: ${acc.id}`);
      console.log(`  Email: ${acc.email}`);
      console.log(`  Auth Method: ${acc.auth_method}`);
      console.log(`  Region: ${acc.region}`);
      console.log(`  Client ID: ${acc.client_id ? acc.client_id.substring(0, 20) + '...' : 'N/A'}`);
      console.log(`  Profile ARN: ${acc.profile_arn || 'N/A'}`);
      console.log(`  Is Healthy: ${acc.is_healthy === 1 ? 'Yes' : 'No'}`);
      console.log(`  Unhealthy Reason: ${acc.unhealthy_reason || 'N/A'}`);
      console.log(`  Access Token: ${acc.access_token ? acc.access_token.substring(0, 30) + '...' : 'N/A'}`);
      console.log(`  Expires At: ${acc.expires_at ? new Date(acc.expires_at).toISOString() : 'N/A'}`);
      console.log(`  Token Expired: ${acc.expires_at && Date.now() >= acc.expires_at ? 'YES' : 'No'}`);
      console.log('');
    });
    
    console.log('\n=== Expected API Endpoint ===');
    const region = accounts[0]?.region || 'us-east-1';
    console.log(`https://q.${region}.amazonaws.com/generateAssistantResponse`);
    console.log('');
  }
  
  db.close();
  
} catch (error) {
  console.error('Error reading database:', error.message);
  console.error('\nDatabase path:', dbPath);
}
