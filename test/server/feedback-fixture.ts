// Real HTTP and git, with gh's replies and every gist remote confined to this fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Feedback } from '../../dist/feedback.js';
import { Narrator } from '../../dist/narrate.js';
import { ReviewServer } from '../../dist/server.js';
import { stubGh, type GhReply } from '../helpers/gh.ts';
import { reviewClient } from '../helpers/http.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';

export const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
export const gistId = 'a123b456';
export const issueUrl = 'https://github.com/fixture/feedback/issues/5';
export const readyReplies: GhReply[] = [
  { match: ['--version'], stdout: 'gh version 2.93.0' },
  { match: ['api', '--hostname', 'github.com', 'user'], stdout: { login: 'octocat' } },
  { match: ['api', '--hostname', 'github.com', 'repos/acme/public'], stdout: { private: false } },
  { match: ['api', '--hostname', 'github.com', 'repos/acme/private'], stdout: { private: true } },
  { match: ['gist', 'create'], stdout: `https://gist.github.com/octocat/${gistId}` },
  { match: ['issue', 'create'], stdout: issueUrl },
  { match: ['gist', 'edit'], stdout: '' },
];
const author: Person = { name: 'Ada', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

export async function feedbackFixture(review: string | null = null, replies = readyReplies) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-feedback-test-'));
  const gh = stubGh(replies);
  const previous = { ...process.env };
  const env = {
    ...gh.env, UNTANGLE_CACHE: path.join(root, 'cache'), UNTANGLE_FEEDBACK_REPO: 'fixture/feedback',
    BROWSER: 'true', UNTANGLE_NO_ORCA: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${root}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://gist.github.com/',
    GIT_CONFIG_KEY_1: 'url./nonexistent/untangle-feedback/.insteadOf', GIT_CONFIG_VALUE_1: 'https://github.com/',
  };
  for (const key of Object.keys(process.env)) if (/^(ORCA_|CLAUDE|CODEX_)/.test(key) || key === 'BROWSER') delete process.env[key];
  Object.assign(process.env, env);
  fs.mkdirSync(env.UNTANGLE_CACHE);

  const files = path.join(root, 'files.jsonl');
  const delay = path.join(root, 'delay.json');
  const source = fileURLToPath(new URL('../helpers/gh-stub.mjs', import.meta.url));
  const wrapper = path.join(gh.binDir, 'feedback-gh.mjs');
  fs.writeFileSync(wrapper, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (fs.existsSync(${JSON.stringify(delay)})) {
  const prefix = JSON.parse(fs.readFileSync(${JSON.stringify(delay)}, 'utf8'));
  if (prefix.every((part, i) => args[i] === part)) await new Promise((r) => setTimeout(r, 30000));
}
const at = args.indexOf('--body-file');
if (at >= 0) fs.appendFileSync(${JSON.stringify(files)}, JSON.stringify({ file: args[at + 1], body: fs.readFileSync(args[at + 1], 'utf8') }) + '\\n');
if (args[0] === 'gist' && args[1] === 'create') fs.appendFileSync(${JSON.stringify(files)}, JSON.stringify({ file: process.cwd() + '/README.md', body: fs.readFileSync('README.md', 'utf8') }) + '\\n');
const child = spawnSync(process.execPath, [${JSON.stringify(source)}, ...args], { stdio: 'inherit' });
process.exit(child.status ?? 1);
`);
  fs.writeFileSync(path.join(gh.binDir, 'gh'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(wrapper)} "$@"\n`);

  const say = new Narrator({ quiet: true, verbose: false, color: false });
  const feedback = new Feedback({ review: review ? async () => review : null, broadcast: (value) => server.broadcast(value), pages: () => server.pageCount });
  const server: ReviewServer = new ReviewServer({ host: '127.0.0.1', port: 0, portExplicit: true, basePath: '/' }, say, {
    page: () => 'feedback', asset: () => null, call: (route, method, _query, body) => feedback.call(route, method, body),
  }, '', () => {});
  const url = await server.listen();
  const client = reviewClient(url);
  await client.open();
  let bare: TempRepo | null = null;
  const barePath = path.join(root, `${gistId}.git`);

  return {
    root, gh, client, url, feedback, env, barePath,
    files: (): Array<{ file: string; body: string }> => fs.existsSync(files) ? fs.readFileSync(files, 'utf8').trim().split('\n').map((s) => JSON.parse(s)) : [],
    delay(prefix: string[]) { fs.writeFileSync(delay, JSON.stringify(prefix)); },
    git(args: string[]) { return execFileSync('git', ['-C', barePath, ...args], { encoding: 'utf8' }).trim(); },
    blob(ref: string) { return execFileSync('git', ['-C', barePath, 'show', ref]); },
    gist(id = gistId) {
      bare = TempRepo.bare();
      const seed = TempRepo.create();
      try {
        seed.write('README.md', 'Feedback pictures\n');
        seed.commit({ subject: 'Start feedback pictures', author, committer: author });
        seed.remoteAdd('origin', bare.dir);
        seed.push('origin', 'main');
        fs.renameSync(bare.dir, path.join(root, `${id}.git`));
      } finally { seed.remove(); }
    },
    async remove() {
      await server.close();
      gh.remove();
      bare?.remove();
      fs.rmSync(root, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    },
  };
}
export type FeedbackFixture = Awaited<ReturnType<typeof feedbackFixture>>;
