import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

function run(flag: string): string {
  return execFileSync(process.execPath, [cli, flag], { encoding: 'utf8' });
}

describe('Given the untangle command, ', () => {
  it('when -h is asked, then the usage lists the flags.', () => {
    const text = run('-h');
    assert.equal(text.startsWith('untangle ') && text.includes('usage:') && text.includes('  -port int') && text.includes('-no-open'), true);
  });

  it('when -help is asked, then the usage lists the flags.', () => {
    const text = run('-help');
    assert.equal(text.startsWith('untangle ') && text.includes('A pull request URL is cloned into the cache first.'), true);
  });

  it('when -v is asked, then the version and the platform are printed.', () => {
    const text = run('-v');
    assert.equal(/^untangle \d+\.\d+\.\d+ \([a-z0-9]+\/[a-z0-9]+\)\n$/.test(text), true);
  });
});
