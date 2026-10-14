// The generated-file patterns that apply to a commit: node generated_globs.js <repo> <commit>
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const DEPS = process.env.BCR_DEPS || path.join(__dirname, 'node_modules');
const YAML = require(DEPS + '/yaml');
const { generatedGlobs } = require('./adapters.js');
const [repo, rev] = process.argv.slice(2);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
const paths = git('ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean);
let review = {};
try { review = YAML.parse(git('show', `${rev}:.review.yaml`)) || {}; } catch {}
process.stdout.write(JSON.stringify(generatedGlobs(paths, review).map(([g]) => g)));
