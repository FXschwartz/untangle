import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duration, parseArgs, parseCommand, UsageError, type Options } from '../../dist/args.js';

function shown(options: Options): string {
  return [
    `target ${options.target}`,
    `autoclose ${options.autoclose}`,
    `base ${options.base ?? 'none'}`,
    `basePath ${options.basePath}`,
    `chains ${options.chains}`,
    `editor ${options.editor ?? 'none'}`,
    `export ${options.exportTo ?? 'none'}`,
    `host ${options.host}`,
    `port ${options.port}`,
    `portExplicit ${options.portExplicit}`,
    `noCache ${options.noCache}`,
    `color ${options.color}`,
    `open ${options.open}`,
    `quiet ${options.quiet}`,
    `verbose ${options.verbose}`,
    `version ${options.version}`,
    `help ${options.help}`,
  ].join('\n');
}

describe('Given no arguments, ', () => {
  it(
    'when the flags are read, '
    + 'then the defaults review the current directory on port 7778, chains following the commits, open it, and stop once it closes.',
    () => {
      assert.equal(shown(parseArgs([])), [
        'target .',
        'autoclose true',
        'base none',
        'basePath /',
        'chains history',
        'editor none',
        'export none',
        'host 127.0.0.1',
        'port 7778',
        'portExplicit false',
        'noCache false',
        'color true',
        'open true',
        'quiet false',
        'verbose false',
        'version false',
        'help false',
      ].join('\n'));
    },
  );
});

describe('Given flags for a quiet review written to a file, ', () => {
  const argv = [
    '-autoclose=false',
    '-base', 'main',
    '-base-path', 'rev',
    '-chains', 'structure',
    '-editor', 'code -g {file}:{line}:{col}',
    '-export', 'out.html',
    '-host', '127.0.0.1',
    '-port', '0',
    '-no-cache',
    '-no-color',
    '-no-open',
    '-quiet',
    'feature',
  ];

  it(
    'when the flags are read, '
    + 'then each flag replaces its default.',
    () => {
      assert.equal(shown(parseArgs(argv)), [
        'target feature',
        'autoclose false',
        'base main',
        'basePath /rev/',
        'chains structure',
        'editor code -g {file}:{line}:{col}',
        'export out.html',
        'host 127.0.0.1',
        'port 0',
        'portExplicit true',
        'noCache true',
        'color false',
        'open false',
        'quiet true',
        'verbose false',
        'version false',
        'help false',
      ].join('\n'));
    },
  );
});

describe('Given -- before a value that starts with a dash, ', () => {
  it(
    'when the flags are read, '
    + 'then the value is the directory.',
    () => {
      assert.equal(parseArgs(['--', '-nope']).target, '-nope');
    },
  );
});

describe('Given an unknown flag, ', () => {
  it(
    'when the flags are read, '
    + 'then the flag is refused.',
    () => {
      assert.throws(() => parseArgs(['-nope']), (error: unknown) => error instanceof UsageError && error.message === 'flag provided but not defined: -nope');
    },
  );
});

describe('Given -chains with a value that is neither history nor structure, ', () => {
  it(
    'when the flags are read, '
    + 'then the value is refused.',
    () => {
      assert.throws(() => parseArgs(['-chains', 'commits']), (error: unknown) => error instanceof UsageError && error.message === 'invalid value "commits" for flag -chains: history or structure');
    },
  );
});

describe('Given -v, ', () => {
  it(
    'when the flags are read, '
    + 'then the version is asked for.',
    () => {
      assert.equal(parseArgs(['-v']).version, true);
    },
  );
});

describe('Given -version, ', () => {
  it(
    'when the flags are read, '
    + 'then the version is asked for.',
    () => {
      assert.equal(parseArgs(['-version']).version, true);
    },
  );
});

describe('Given the agent’s commands, ', () => {
  it(
    'when watch is given its flags, the review’s and a pull request, '
    + 'then its own flags are read and the review’s are kept for the review it starts.',
    () => {
      const c = parseCommand(['watch', '-agent', 'Codex', '-timeout', '9m', '-base', 'main', '-no-open', 'https://github.com/acme/app/pull/7']);
      assert.deepEqual(c.cmd === 'watch' && [c.opts.target, c.given, c.agent, c.timeout, c.forward], ['https://github.com/acme/app/pull/7', true, 'Codex', 540_000, ['-base=main', '-no-open']]);
    },
  );

  it(
    'when watch is given nothing, '
    + 'then it watches the current directory, as long as it takes.',
    () => {
      const c = parseCommand(['watch']);
      assert.deepEqual(c.cmd === 'watch' && [c.opts.target, c.given, c.agent, c.timeout, c.forward], ['.', false, null, 0, []]);
    },
  );

  it(
    'when reply’s text starts with a dash, '
    + 'then the text is the rest of the line, after the note.',
    () => {
      assert.deepEqual(parseCommand(['reply', '-resolve', 'N2', '-1', 'is', 'the', 'sentinel']), { cmd: 'reply', review: null, agent: null, resolve: true, note: 2, text: '-1 is the sentinel' });
    },
  );

  it(
    'when reply names no note, '
    + 'then it is refused.',
    () => {
      assert.throws(() => parseCommand(['reply', 'soon']), (error: unknown) => error instanceof UsageError && error.message === 'soon is not a note: say which, as N2 or 2');
    },
  );

  it(
    'when reply has no text and doesn’t resolve, '
    + 'then it is refused.',
    () => {
      assert.throws(() => parseCommand(['reply', '2']), (error: unknown) => error instanceof UsageError && error.message === 'what to answer? untangle reply <N> <text>, or -resolve alone');
    },
  );

  it(
    'when notes and stop are given a review, '
    + 'then they are about it.',
    () => {
      assert.deepEqual([parseCommand(['notes', '-all', '-review', '../app']), parseCommand(['stop'])], [{ cmd: 'notes', review: '../app', all: true }, { cmd: 'stop', review: null }]);
    },
  );

  it(
    'when a directory is named like a command, '
    + 'then ./ reaches it as a review.',
    () => {
      const c = parseCommand(['./watch']);
      assert.deepEqual(c.cmd === 'review' && c.opts.target, './watch');
    },
  );

  it(
    'when watch is given a timeout that isn’t a duration, '
    + 'then it is refused.',
    () => {
      assert.throws(() => parseCommand(['watch', '-timeout', 'ten']), (error: unknown) => error instanceof UsageError && error.message === 'invalid value "ten" for flag -timeout: parse error');
    },
  );
});

describe('Given durations as Go writes them, ', () => {
  it('when they are read, then each is its milliseconds.', () => {
    assert.deepEqual(['0', '300ms', '90s', '1h30m', '1.5m'].map(duration), [0, 300, 90_000, 5_400_000, 90_000]);
  });
});
