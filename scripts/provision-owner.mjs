import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pg from 'pg';
import { provisionFirstOwner } from '../src/server/owner-bootstrap.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the intended PostgreSQL database in a protected shell.');
if (process.env.ZEZO_CONFIRM_FIRST_OWNER !== 'CREATE_FIRST_OWNER') {
  throw new Error('Set ZEZO_CONFIRM_FIRST_OWNER=CREATE_FIRST_OWNER for this one-time administrative operation.');
}
if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('Owner provisioning requires an interactive terminal so the password is not piped or echoed.');

function readHidden(prompt) {
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = chunk => {
      const input = chunk.toString('utf8');
      if (input === '\u0003') {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        reject(new Error('Cancelled.'));
        return;
      }
      if (input === '\r' || input === '\n') {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        resolve(value);
        return;
      }
      if (input === '\u007f' || input === '\b') value = value.slice(0, -1);
      else if (input >= ' ' && input !== '\u007f') value += input;
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'zezo-owner-bootstrap-cli' });
try {
  const name = await rl.question('Owner full name: ');
  const username = await rl.question('Owner username: ');
  const email = await rl.question('Owner email (optional): ');
  rl.close();
  const password = await readHidden('New Owner password (input hidden): ');
  const confirmation = await readHidden('Repeat password (input hidden): ');
  const confirmText = await readHidden('Type CREATE FIRST OWNER to continue: ');
  if (password !== confirmation) throw new Error('Passwords did not match.');
  if (confirmText.trim() !== 'CREATE FIRST OWNER') throw new Error('Confirmation did not match; no account was created.');

  await client.connect();
  const account = await provisionFirstOwner({ client, name, username, email, password });
  stdout.write(`Created the initial Owner account for username ${account.username}. A password change and MFA setup are required at first sign-in.\n`);
} finally {
  await client.end().catch(() => {});
}
