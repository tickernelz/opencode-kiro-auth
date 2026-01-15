import { createInterface, type Interface } from 'node:readline';
import type { KiroAuthMethod, KiroRegion } from './types';
import * as logger from './logger';

let rl: Interface | null = null;

function getReadline(): Interface {
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    rl.on('SIGINT', () => {
      logger.log('Received SIGINT, closing readline');
      closeReadline();
      process.exit(130);
    });
  }
  
  return rl;
}

function closeReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const readline = getReadline();
    readline.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

function clearLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
}

export async function promptAuthMethod(): Promise<KiroAuthMethod> {
  console.log('\nSelect authentication method:');
  console.log('  1. Social (GitHub, Google, etc.)');
  console.log('  2. IDC (Identity Center)');
  
  while (true) {
    const answer = await question('\nEnter your choice (1 or 2): ');
    
    if (answer === '1' || answer.toLowerCase() === 'social') {
      clearLine();
      return 'social';
    }
    
    if (answer === '2' || answer.toLowerCase() === 'idc') {
      clearLine();
      return 'idc';
    }
    
    console.log('Invalid choice. Please enter 1 or 2.');
  }
}

export async function promptRegion(): Promise<KiroRegion> {
  console.log('\nSelect AWS region:');
  console.log('  1. us-east-1 (default)');
  console.log('  2. us-west-2');
  
  while (true) {
    const answer = await question('\nEnter your choice (1 or 2, default: 1): ');
    
    if (!answer || answer === '1' || answer.toLowerCase() === 'us-east-1') {
      clearLine();
      return 'us-east-1';
    }
    
    if (answer === '2' || answer.toLowerCase() === 'us-west-2') {
      clearLine();
      return 'us-west-2';
    }
    
    console.log('Invalid choice. Please enter 1 or 2.');
  }
}

export async function promptConfirmation(message: string): Promise<boolean> {
  while (true) {
    const answer = await question(`${message} (y/n): `);
    const lower = answer.toLowerCase();
    
    if (lower === 'y' || lower === 'yes') {
      clearLine();
      return true;
    }
    
    if (lower === 'n' || lower === 'no') {
      clearLine();
      return false;
    }
    
    console.log('Invalid input. Please enter y or n.');
  }
}

export function displayAuthUrl(url: string): void {
  console.log('\n' + '='.repeat(70));
  console.log('Authentication Required');
  console.log('='.repeat(70));
  console.log('\nPlease open the following URL in your browser to authenticate:\n');
  console.log(`  ${url}\n`);
  console.log('Waiting for authentication to complete...');
  console.log('='.repeat(70) + '\n');
}

export function cleanup(): void {
  closeReadline();
}
