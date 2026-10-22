import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../../dist/exec.js';

describe('Given a command run with input, ', () => {
  let tmp = '';
  let previous: string | undefined;
  let read = '';
  let left: string[] = [];

  before(() => {
    // Its input goes through a temporary folder of this test's own, to see what it leaves there.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-exec-'));
    previous = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    read = run('sh', ['-c', 'if [ -f /dev/stdin ]; then echo a file; else echo a pipe; fi; cat'], { input: 'one\ntwo\n' });
    left = fs.readdirSync(tmp);
  });

  after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('then it reads it from a file, to its end: no pipe is left for it to wait on.', () => {
    assert.equal(read, 'a file\none\ntwo\n');
  });

  it('then the file is gone once the command ends.', () => {
    assert.deepEqual(left, []);
  });

  describe('when the command fails, ', () => {
    it('then it throws what the command said, and the file is gone too.', () => {
      assert.throws(() => run('sh', ['-c', 'cat >/dev/null; echo broke >&2; exit 3'], { input: 'one\n' }), /failed \(exit 3\): broke$/);
      assert.deepEqual(fs.readdirSync(tmp), []);
    });
  });
});
