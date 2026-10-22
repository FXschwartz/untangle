import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parse } from 'yaml';
import { runAsync } from '../../dist/exec.js';
import { feedbackFixture, type FeedbackFixture } from './feedback-fixture.ts';

let f: FeedbackFixture;
afterEach(async () => { await f?.remove(); });
const workflow = parse(fs.readFileSync(new URL('../../.github/workflows/feedback-labels.yml', import.meta.url), 'utf8'));

describe('Given a feedback issue opened by someone without repository access, ', () => {
  describe('when the workflow sees the bug marker, ', () => {
    it('then it creates the labels idempotently and applies them without executing the body.', async () => {
      f = await feedbackFixture(null, [
        { match: ['label', 'create'], stdout: '' },
        { match: ['api', '--method', 'POST'], stdout: [] },
      ]);
      const escaped = path.join(f.root, 'body-was-executed');
      const body = `$(touch ${escaped})\n<!-- untangle-feedback kind=bug -->`;
      await runAsync('bash', ['-e', '-c', workflow.jobs.label.steps[0].run], { env: { GH_REPO: 'fixture/feedback', ISSUE_NUMBER: '5', ISSUE_BODY: body } });
      assert.equal(fs.existsSync(escaped), false);
      assert.deepEqual(f.gh.calls().map((call) => call.args), [
        ['label', 'create', 'bug', '--repo', 'fixture/feedback', '--color', 'd73a4a', '--force'],
        ['label', 'create', 'from untangle', '--repo', 'fixture/feedback', '--color', '0e8a16', '--force'],
        ['api', '--method', 'POST', 'repos/fixture/feedback/issues/5/labels', '-f', 'labels[]=bug', '-f', 'labels[]=from untangle'],
      ]);
      assert.deepEqual(workflow.permissions, { issues: 'write' });
      assert.deepEqual(workflow.on, { issues: { types: ['opened'] } });
      assert.equal(workflow.jobs.label.steps.some((step: { uses?: string }) => step.uses), false);
    });
  });

  describe('when the workflow sees the idea marker, ', () => {
    it('then it labels the issue as an idea and from untangle.', async () => {
      f = await feedbackFixture(null, [
        { match: ['label', 'create'], stdout: '' },
        { match: ['api', '--method', 'POST'], stdout: [] },
      ]);
      await runAsync('bash', ['-e', '-c', workflow.jobs.label.steps[0].run], { env: { GH_REPO: 'fixture/feedback', ISSUE_NUMBER: '6', ISSUE_BODY: '<!-- untangle-feedback kind=idea -->' } });
      assert.equal(f.gh.calls()[0].args[2], 'idea');
      assert.deepEqual(f.gh.calls().at(-1)!.args.slice(-4), ['-f', 'labels[]=idea', '-f', 'labels[]=from untangle']);
    });
  });
});
