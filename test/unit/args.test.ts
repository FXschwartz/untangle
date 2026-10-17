import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, UsageError, type Options } from '../../dist/args.js';

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
