import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it, mock } from 'node:test';
import { Narrator } from '../../dist/narrate.js';

function running(terminal: boolean) {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { value: terminal, configurable: true });
  let output = '';
  mock.method(process.stderr, 'write', (chunk: string) => { output += chunk; return true; });
  const narrator = new Narrator({ quiet: false, verbose: false, color: false });
  narrator.step('language server');
  output = '';
  return {
    narrator,
    output: () => output,
    remove() {
      narrator.finish();
      mock.reset();
      mock.timers.reset();
      if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
      else Reflect.deleteProperty(process.stderr, 'isTTY');
    },
  };
}

type Running = ReturnType<typeof running>;

describe('Given a running step on a terminal, ', () => {
  let run: Running;

  before(() => { run = running(true); });
  after(() => run.remove());

  describe('when a second passes, ', () => {
    let status = '';
    let output = '';

    before(() => {
      mock.timers.tick(1000);
      status = JSON.stringify(run.narrator.status.steps[0]);
      output = run.output();
    });

    it('then the serialized status carries the elapsed millisecond count.', () => {
      assert.equal(status, '{"label":"language server","state":"running","ms":1000,"notes":[]}');
    });

    it('then the terminal redraws with the elapsed second.', () => {
      assert.equal(output, '\r\x1b[K  … language server  1 s');
    });
  });
});

describe('Given a running step on a pipe, ', () => {
  let run: Running;

  before(() => { run = running(false); });
  after(() => run.remove());

  describe('when a second passes, ', () => {
    let status = '';
    let output = '';

    before(() => {
      mock.timers.tick(1000);
      status = JSON.stringify(run.narrator.status.steps[0]);
      output = run.output();
    });

    it('then the serialized status carries the elapsed millisecond count.', () => {
      assert.equal(status, '{"label":"language server","state":"running","ms":1000,"notes":[]}');
    });

    it('then no further output is written to the pipe.', () => {
      assert.equal(output, '');
    });
  });
});

describe('Given a step finished after one second, ', () => {
  let run: Running;

  before(() => {
    run = running(false);
    mock.timers.tick(1000);
    run.narrator.finish();
  });
  after(() => run.remove());

  describe('when five more seconds pass, ', () => {
    let status = '';

    before(() => {
      mock.timers.tick(5000);
      status = JSON.stringify(run.narrator.status.steps[0]);
    });

    it('then it stays done at one second.', () => {
      assert.equal(status, '{"label":"language server","state":"done","ms":1000,"notes":[]}');
    });
  });
});

describe('Given a step that failed after one second, ', () => {
  let run: Running;

  before(() => {
    run = running(false);
    mock.timers.tick(1000);
    run.narrator.fail('analysis failed');
  });
  after(() => run.remove());

  describe('when five more seconds pass, ', () => {
    let status = '';

    before(() => {
      mock.timers.tick(5000);
      status = JSON.stringify(run.narrator.status.steps[0]);
    });

    it('then it stays failed at one second.', () => {
      assert.equal(status, '{"label":"language server","state":"failed","ms":1000,"notes":[]}');
    });
  });
});

describe('Given a step ended by the review becoming ready after one second, ', () => {
  let run: Running;

  before(() => {
    run = running(false);
    mock.timers.tick(1000);
    run.narrator.ready('http://localhost/');
  });
  after(() => run.remove());

  describe('when five more seconds pass, ', () => {
    let status = '';

    before(() => {
      mock.timers.tick(5000);
      status = JSON.stringify(run.narrator.status.steps[0]);
    });

    it('then it stays done at one second.', () => {
      assert.equal(status, '{"label":"language server","state":"done","ms":1000,"notes":[]}');
    });
  });
});

describe('Given a script with only a narration timer, ', () => {
  let script = '';

  before(() => {
    script = `import { Narrator } from ${JSON.stringify(new URL('../../dist/narrate.js', import.meta.url).href)};\nnew Narrator({ quiet: true, verbose: false, color: false }).step('waiting');\n`;
  });

  describe('when the script runs, ', () => {
    let exit = '';

    before(() => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
      exit = `${child.status}\n${child.signal}\n${child.stderr}`;
    });

    it('then the timer lets the process exit cleanly.', () => {
      assert.equal(exit, '0\nnull\n');
    });
  });
});
