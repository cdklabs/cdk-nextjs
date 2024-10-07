'use server';

import { execSync } from 'child_process';

export async function submit(command: string) {
  'use server';
  // this is just for debugging purposes in example app
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const output = execSync(command).toString();
  return output;
}
