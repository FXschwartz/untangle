#!/usr/bin/env node
// A stand-in for mergiraf. It records its arguments and writes either a clean
// copy of the snapshot side or conflict markers, so a replay can be hermetic.
import fs from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.MERGIRAF_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + '\n');

let out = '';
for (let i = 0; i < args.length; i += 1) if (args[i] === '-o') out = args[i + 1];
if (!out) process.exit(1);

if (process.env.MERGIRAF_MODE === 'conflict') {
  fs.writeFileSync(out, '<<<<<<< ours\n=======\ntheirs\n>>>>>>>\n');
} else {
  // merge <base> <ours> <theirs> -o <out> -p <path>. Theirs is the snapshot.
  fs.copyFileSync(args[3], out);
}
