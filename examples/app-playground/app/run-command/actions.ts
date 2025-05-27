'use server';

import { execSync } from 'child_process';

export async function submit(command: string) {
  'use server';
  // this is just for debugging purposes in example app
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  try {
    const output = execSync(command).toString();
    return output;
  } catch (error) {
    // Format error message for better readability
    if (error instanceof Error) {
      return `Error executing command: ${command}\n${error.message}`;
    }
    return `Unknown error executing command: ${command}`;
  }
}
