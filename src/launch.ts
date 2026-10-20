// Starts a review for untangle watch, then exits at once, saying the review's process id: the
// review is no one's child. An agent that stops a command ends everything under it, and the review
// belongs to its page, not to the watch that started it.
//
//   node launch.js <log> <cli.js> [flags] -- <target>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [log, ...argv] = process.argv.slice(2);
const fd = fs.openSync(log, 'a', 0o600);
const child = spawn(process.execPath, argv, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
// A review that didn't start leaves no process id: the watch says so.
child.on('error', () => {});
process.stdout.write(String(child.pid ?? ''));
child.unref();
