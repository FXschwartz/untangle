// Command-line flags, written and printed the way Go's flag package does (as px0's are):
// -name value, -name=value, --name, and booleans as -name or -name=false.

interface Flag {
  name: string;
  type: 'string' | 'int' | 'bool';
  usage: string;
  default?: string | number;
}

const FLAGS: Flag[] = [
  { name: 'base', type: 'string', usage: 'compare with this branch or commit instead of the pull request’s base' },
  { name: 'base-path', type: 'string', usage: 'base URL path prefix to serve endpoints and assets from (e.g. /rev-123/)' },
  { name: 'chains', type: 'string', usage: 'what chains follow: "history", the commits that started each change, or "structure", the code alone', default: 'history' },
  { name: 'editor', type: 'string', usage: 'open locations with this command, or this URL, where {file}, {line} and {col} are replaced (e.g. "code -g {file}:{line}:{col}"); VS Code\'s vscode:// link when omitted' },
  { name: 'export', type: 'string', usage: 'write the review to this HTML file, to share it read-only, and exit' },
  { name: 'host', type: 'string', usage: 'address to bind', default: '127.0.0.1' },
  { name: 'no-cache', type: 'bool', usage: 'build the review again, even when an analysis of the same commits is cached' },
  { name: 'no-color', type: 'bool', usage: 'disable colour output' },
  { name: 'no-open', type: 'bool', usage: 'do not launch a browser' },
  { name: 'port', type: 'int', usage: 'port to listen on (0 picks a free one)', default: 7778 },
  { name: 'quiet', type: 'bool', usage: 'suppress narration; print only the review’s URL' },
  { name: 'v', type: 'bool', usage: 'print version and exit (shorthand)' },
  { name: 'verbose', type: 'bool', usage: 'log the language server, pub get and requests to the terminal' },
  { name: 'version', type: 'bool', usage: 'print version and exit' },
];

export interface Options {
  target: string;
  base: string | null;
  basePath: string;
  chains: 'history' | 'structure';
  editor: string | null;
  exportTo: string | null;
  host: string;
  port: number;
  portExplicit: boolean;
  noCache: boolean;
  color: boolean;
  open: boolean;
  quiet: boolean;
  verbose: boolean;
  version: boolean;
  help: boolean;
}

export class UsageError extends Error {}

export function usage(version: string): string {
  const lines = [
    `untangle ${version} - review a pull request chain by chain`,
    '',
    'usage:',
    '  untangle [flags] [directory]',
    '  untangle [flags] <pr-url>',
    '',
    'A directory reviews its branch’s pull request, or else what the branch adds to the default branch.',
    'A pull request URL is cloned into the cache first. The review opens in your browser.',
    '',
    'flags:',
  ];
  for (const f of FLAGS) {
    const def = f.default !== undefined ? ` (default ${typeof f.default === 'string' ? JSON.stringify(f.default) : f.default})` : '';
    if (f.name.length === 1 && f.type === 'bool') lines.push(`  -${f.name}\t${f.usage}${def}`);
    else lines.push(`  -${f.name}${f.type === 'bool' ? '' : ' ' + f.type}`, `    \t${f.usage}${def}`);
  }
  return lines.join('\n') + '\n';
}

export function parseArgs(argv: string[]): Options {
  const values = new Map<string, string | boolean>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { rest.push(arg); continue; }
    const body = arg.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const name = eq < 0 ? body : body.slice(0, eq);
    if (name === 'h' || name === 'help') { values.set('help', true); continue; }
    const flag = FLAGS.find((f) => f.name === name);
    if (!flag) throw new UsageError(`flag provided but not defined: -${name}`);
    if (flag.type === 'bool') {
      const v = eq < 0 ? 'true' : body.slice(eq + 1);
      if (!/^(true|false|1|0)$/.test(v)) throw new UsageError(`invalid boolean value "${v}" for -${name}`);
      values.set(name, v === 'true' || v === '1');
    } else {
      const v = eq >= 0 ? body.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new UsageError(`flag needs an argument: -${name}`);
      if (flag.type === 'int' && !/^\d+$/.test(v)) throw new UsageError(`invalid value "${v}" for flag -${name}: parse error`);
      values.set(name, v);
    }
  }
  if (rest.length > 1) throw new UsageError(`one directory or pull request URL at a time (got ${rest.length})`);
  const str = (k: string) => (values.has(k) ? String(values.get(k)) : null);
  const bool = (k: string) => values.get(k) === true;
  let basePath = str('base-path') || '/';
  if (!basePath.startsWith('/')) basePath = '/' + basePath;
  if (!basePath.endsWith('/')) basePath += '/';
  const port = values.has('port') ? Number(values.get('port')) : 7778;
  if (port > 65535) throw new UsageError(`invalid value "${port}" for flag -port: out of range`);
  const chains = str('chains') || 'history';
  if (chains !== 'history' && chains !== 'structure') throw new UsageError(`invalid value "${chains}" for flag -chains: history or structure`);
  return {
    target: rest[0] || '.',
    base: str('base'),
    basePath,
    chains,
    editor: str('editor'),
    exportTo: str('export'),
    host: str('host') || '127.0.0.1',
    port,
    portExplicit: values.has('port'),
    noCache: bool('no-cache'),
    color: !bool('no-color'),
    open: !bool('no-open'),
    quiet: bool('quiet'),
    verbose: bool('verbose'),
    version: bool('v') || bool('version'),
    help: bool('help'),
  };
}
