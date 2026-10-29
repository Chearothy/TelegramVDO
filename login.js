'use strict';
// One-time login. Saves TG_SESSION straight into your .env file (it is NOT printed, so it can't leak in screenshots).
const envInfo = require('./loadenv');
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = function (q) { return new Promise(function (r) { rl.question(q, r); }); };

(async function () {
  const apiId = Number(process.env.TG_API_ID || await ask('api_id (from my.telegram.org): '));
  const apiHash = process.env.TG_API_HASH || await ask('api_hash: ');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: function () { return ask('Phone number with country code (+855...): '); },
    phoneCode: function () { return ask('Code Telegram sent you: '); },
    password: function () { return ask('2-step password (press Enter if none): '); },
    onError: function (e) { console.log('Error:', e.message); }
  });
  if (!process.env.TG_API_ID) envInfo.save('TG_API_ID', String(apiId));
  if (!process.env.TG_API_HASH) envInfo.save('TG_API_HASH', apiHash);
  const file = envInfo.save('TG_SESSION', client.session.save());
  console.log('\nLogged in. The session was saved into:\n  ' + file + '\nNothing to copy. Now run: npm start\n');
  process.exit(0);
})();
