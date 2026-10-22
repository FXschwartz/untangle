import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { feedbackFixture, gistId, issueUrl, picture, readyReplies, type FeedbackFixture } from './feedback-fixture.ts';

let f: FeedbackFixture;
afterEach(async () => { await f?.remove(); });
const report = { kind: 'bug', title: 'The review hangs', body: 'What happened.\n\n{{picture}}\n\nDetails.', picture, approved: true };
const user = ['api', '--hostname', 'github.com', 'user'];

describe('Given the feedback context, ', () => {
  describe('when gh knows the user and the repository is public, ', () => {
    it('then the context reports the versions, login and visibility and caches their answers.', async () => {
      f = await feedbackFixture('acme/public');
      const reply = await f.client.call('feedback');
      const data = reply.data as { repo: string; version: string; commit: string; gh: unknown; review: unknown; system: { gh: string; git: string }; draft: unknown };
      assert.equal(reply.status, 200);
      assert.equal(data.repo, 'fixture/feedback');
      assert.equal(data.version, '0.1.0');
      assert.match(data.commit, /^[a-f0-9]+$/);
      assert.equal(data.system.gh, '2.93.0');
      assert.match(data.system.git, /^\d/);
      assert.deepEqual(data.gh, { ready: true, login: 'octocat' });
      assert.deepEqual(data.review, { repo: 'acme/public', public: true });
      assert.equal(data.draft, null);
      const calls = f.gh.calls();
      await f.client.call('feedback');
      assert.deepEqual(f.gh.calls(), calls);
    });
  });

  describe('when the repository is private, ', () => {
    it('then the context explicitly keeps it private.', async () => {
      f = await feedbackFixture('acme/private');
      assert.deepEqual(((await f.client.call('feedback')).data as { review: unknown }).review, { repo: 'acme/private', public: false });
    });
  });

  describe('when gh is unavailable, ', () => {
    it('then the context keeps visibility unknown and offers GitHub instead of filing.', async () => {
      f = await feedbackFixture('acme/public', []);
      const data = (await f.client.call('feedback')).data as { gh: unknown; review: unknown; system: { gh: unknown } };
      assert.deepEqual(data.gh, { ready: false, login: null });
      assert.equal(data.system.gh, null);
      assert.deepEqual(data.review, { repo: 'acme/public', public: null });
      const filed = await f.client.call('feedback', { method: 'POST', body: report });
      assert.deepEqual([filed.status, filed.data], [409, { error: 'gh isn’t signed in: open it on GitHub instead.', web: true }]);
      assert.equal(f.gh.calls().some((c) => c.args[0] === 'issue'), false);
    });
  });

  describe('when the login lookup hangs, ', () => {
    it('then other page calls still answer and the context gives up within a few seconds.', async () => {
      f = await feedbackFixture('acme/public');
      f.delay(user);
      const started = Date.now();
      const waiting = f.client.call('feedback');
      const cleared = await f.client.call('feedback/draft', { method: 'DELETE' });
      assert.equal(cleared.status, 200);
      assert.ok(Date.now() - started < 1500);
      const data = (await waiting).data as { gh: { ready: boolean }; review: { public: unknown } };
      assert.equal(data.gh.ready, false);
      assert.equal(data.review.public, null);
      assert.ok(Date.now() - started < 6000);
    });
  });

  describe('when the repository lookup hangs, ', () => {
    it('then the signed-in user gets unknown visibility without another lookup.', async () => {
      f = await feedbackFixture('acme/public');
      f.delay(['api', '--hostname', 'github.com', 'repos/acme/public']);
      const started = Date.now();
      const first = (await f.client.call('feedback')).data as { gh: { ready: boolean }; review: { public: unknown } };
      assert.equal(first.gh.ready, true);
      assert.equal(first.review.public, null);
      assert.ok(Date.now() - started < 6000);
      const again = Date.now();
      await f.client.call('feedback');
      assert.ok(Date.now() - again < 1000);
    });
  });
});

describe('Given a report with a PNG picture, ', () => {
  describe('when two approved reports are sent, ', () => {
    it('then each report gets its own secret gist, picture, issue body and deletion link.', async () => {
      f = await feedbackFixture();
      f.gist();
      const first = await f.client.call('feedback', { method: 'POST', body: report });
      const secondId = 'b123c456';
      f.gist(secondId);
      f.gh.setReplies([{ match: ['gist', 'create'], stdout: `https://gist.github.com/octocat/${secondId}` }, ...readyReplies]);
      const second = await f.client.call('feedback', { method: 'POST', body: { ...report, kind: 'idea', body: 'First paragraph.\n\nSecond paragraph.' } });
      assert.equal(first.status, 200, first.text);
      assert.equal(second.status, 200, second.text);
      const result = first.data as { number: number; url: string; picture: string; gist: string };
      const next = second.data as typeof result;
      assert.equal(result.number, 5);
      assert.equal(result.url, issueUrl);
      assert.match(result.picture, /^https:\/\/gist.githubusercontent.com\/octocat\/a123b456\/raw\/[a-f0-9]{40}\/untangle-feedback-\d{8}-\d{6}\.png$/);
      assert.notEqual(result.picture, next.picture);
      assert.equal(f.gh.calls().filter((c) => c.args[0] === 'gist' && c.args[1] === 'create').length, 2);
      assert.ok(!f.gh.calls().find((c) => c.args[0] === 'gist' && c.args[1] === 'create')!.args.includes('--public'));
      assert.equal(result.gist, `https://gist.github.com/${gistId}`);
      assert.equal(next.gist, `https://gist.github.com/${secondId}`);
      assert.equal(fs.existsSync(path.join(f.env.UNTANGLE_CACHE, 'feedback.json')), false);
      assert.deepEqual(f.gh.calls().filter((c) => c.args[0] === 'gist' && c.args[1] === 'create').map((c) => c.args), [
        ['gist', 'create', '--desc', 'untangle feedback: The review hangs', 'README.md'],
        ['gist', 'create', '--desc', 'untangle feedback: The review hangs', 'README.md'],
      ]);
      const body = f.files().filter((entry) => entry.file.endsWith('issue.md'));
      assert.equal(body[0].body, `What happened.\n\n![Picture from untangle](${result.picture})\n\nDetails.\n\n<!-- untangle-feedback kind=bug -->\n`);
      assert.equal(body[1].body, `First paragraph.\n\n![Picture from untangle](${next.picture})\n\nSecond paragraph.\n\n<!-- untangle-feedback kind=idea -->\n`);
      for (const entry of f.files()) assert.equal(fs.existsSync(path.dirname(entry.file)), false, entry.file);
      assert.match(f.files()[0].body, /A picture from untangle's Feedback button, for an issue on fixture\/feedback/);
      const names = f.git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter((name) => name.endsWith('.png'));
      assert.equal(names.length, 1);
      assert.match(f.git(['show', 'HEAD:README.md']), /secret, but anyone with its link can see it/);
      assert.match(f.git(['show', 'HEAD:README.md']), /untangle feedback -list/);
      assert.match(f.git(['show', 'HEAD:README.md']), /gh gist delete a123b456/);
      assert.match(f.git(['show', 'HEAD:README.md']), /broken picture/);
      assert.deepEqual(f.gh.calls().filter((c) => c.args[0] === 'gist' && c.args[1] === 'edit').map((c) => c.args), [
        ['gist', 'edit', gistId, '--desc', 'untangle feedback: fixture/feedback#5 The review hangs'],
        ['gist', 'edit', secondId, '--desc', 'untangle feedback: fixture/feedback#5 The review hangs'],
      ]);
      assert.deepEqual(f.blob(`HEAD:${names[0]}`), Buffer.from(picture.split(',')[1], 'base64'));
    });
  });

  describe('when gist creation fails, ', () => {
    it('then the page gets a useful fallback and no issue is filed.', async () => {
      f = await feedbackFixture(null, [{ match: ['gist', 'create'], stderr: 'offline', code: 1 }, ...readyReplies]);
      const reply = await f.client.call('feedback', { method: 'POST', body: report });
      assert.deepEqual([reply.status, reply.data], [502, { error: 'The feedback gist could not be created; open the report on GitHub instead.', web: true }]);
      assert.equal(f.gh.calls().some((c) => c.args[0] === 'issue'), false);
      for (const entry of f.files()) assert.equal(fs.existsSync(path.dirname(entry.file)), false);
    });
  });

  describe('when GitHub returns no gist link, ', () => {
    it('then the report stops before cloning or filing.', async () => {
      f = await feedbackFixture(null, [{ match: ['gist', 'create'], stdout: 'created' }, ...readyReplies]);
      const reply = await f.client.call('feedback', { method: 'POST', body: report });
      assert.deepEqual([reply.status, reply.data], [502, { error: 'GitHub did not return a feedback gist; open the report on GitHub instead.', web: true }]);
      assert.equal(f.gh.calls().some((c) => c.args[0] === 'issue'), false);
    });
  });

  describe('when the picture cannot be cloned, ', () => {
    it('then the report is not filed without it.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: report });
      assert.deepEqual([reply.status, reply.data], [502, { error: 'The picture could not be uploaded; open the report on GitHub instead.', web: true }]);
      assert.equal(f.gh.calls().some((c) => c.args[0] === 'issue'), false);
    });
  });

  describe('when the picture push is rejected, ', () => {
    it('then the issue is not filed and the temporary checkout is removed.', async () => {
      f = await feedbackFixture();
      f.gist();
      fs.writeFileSync(path.join(f.barePath, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const reply = await f.client.call('feedback', { method: 'POST', body: report });
      assert.deepEqual([reply.status, reply.data], [502, { error: 'The picture could not be uploaded; open the report on GitHub instead.', web: true }]);
      assert.equal(f.gh.calls().some((c) => c.args[0] === 'issue'), false);
      assert.equal(fs.existsSync(path.dirname(f.files()[0].file)), false);
    });
  });
});

describe('Given a report without a picture, ', () => {
  describe('when the user sends an idea, ', () => {
    it('then it skips the gist and ends with only the selected marker.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: { kind: 'idea', title: 'An idea', body: 'Words {{picture}}\n<!-- untangle-feedback kind=bug -->' } });
      assert.deepEqual(reply.data, { number: 5, url: issueUrl, picture: null, gist: null });
      assert.equal(f.files()[0].body, 'Words\n\n<!-- untangle-feedback kind=idea -->\n');
      assert.equal(f.gh.calls().some((c) => c.args[0] === 'gist' && c.args[1] === 'create'), false);
    });
  });

  describe('when issue creation fails, ', () => {
    it('then the page gets the issue failure and can use the web form.', async () => {
      f = await feedbackFixture(null, [{ match: ['issue', 'create'], stderr: 'forbidden', code: 1 }, ...readyReplies]);
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, picture: undefined } });
      assert.deepEqual([reply.status, reply.data], [502, { error: 'The issue could not be filed; open the report on GitHub instead.', web: true }]);
      assert.equal(fs.existsSync(path.dirname(f.files()[0].file)), false);
    });
  });

  describe('when GitHub returns no issue link, ', () => {
    it('then the page says to check GitHub before sending again.', async () => {
      f = await feedbackFixture(null, [{ match: ['issue', 'create'], stdout: 'created' }, ...readyReplies]);
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, picture: undefined } });
      assert.deepEqual([reply.status, reply.data], [502, { error: 'GitHub did not return the issue link; check GitHub before sending again.', web: true }]);
    });
  });
});

describe('Given a malformed feedback request, ', () => {
  describe('when the title has another line, ', () => {
    it('then it fails before calling gh.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, title: 'first\nsecond' } });
      assert.deepEqual([reply.status, reply.data], [400, { error: 'title must be one line, from 1 to 256 characters.', web: true }]);
      assert.deepEqual(f.gh.calls(), []);
    });
  });

  describe('when the body is too long, ', () => {
    it('then it explains the body limit.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, body: 'a'.repeat(60001) } });
      assert.deepEqual([reply.status, reply.data], [400, { error: 'body must be markdown of at most 60,000 characters.', web: true }]);
    });
  });

  describe('when the image is not a PNG, ', () => {
    it('then it rejects the image before contacting GitHub.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, picture: 'data:image/png;base64,YWJj' } });
      assert.deepEqual([reply.status, reply.data], [400, { error: 'picture must contain a PNG image.', web: true }]);
      assert.deepEqual(f.gh.calls(), []);
    });
  });

  describe('when the data URL exceeds twelve megabytes, ', () => {
    it('then the page receives the size limit.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, picture: picture + 'A'.repeat(12 * 1024 * 1024) } });
      assert.deepEqual([reply.status, reply.data], [400, { error: 'picture must be a PNG data URL of at most 12 MB.', web: true }]);
    });
  });
});

describe('Given a picture that has not been approved for upload, ', () => {
  describe('when a report omits approved, ', () => {
    it('then it is refused before any gh call, gist creation or upload.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, approved: undefined } });
      assert.deepEqual([reply.status, reply.data], [400, { error: 'Uploading the picture needs your approval first.', web: false }]);
      assert.deepEqual(f.gh.calls(), []);
      assert.deepEqual(f.files(), []);
    });
  });

  describe('when approved is the string true, ', () => {
    it('then it still needs the user’s explicit boolean approval.', async () => {
      f = await feedbackFixture();
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, approved: 'true' } });
      assert.deepEqual([reply.status, reply.data], [400, { error: 'Uploading the picture needs your approval first.', web: false }]);
      assert.deepEqual(f.gh.calls(), []);
    });
  });

  describe('when approved is false after the context was loaded, ', () => {
    it('then it performs no further gh calls.', async () => {
      f = await feedbackFixture();
      await f.client.call('feedback');
      const calls = f.gh.calls();
      const reply = await f.client.call('feedback', { method: 'POST', body: { ...report, approved: false } });
      assert.deepEqual([reply.status, reply.data], [400, { error: 'Uploading the picture needs your approval first.', web: false }]);
      assert.deepEqual(f.gh.calls(), calls);
      assert.deepEqual(f.files(), []);
    });
  });
});

describe('Given an approved picture whose issue was filed, ', () => {
  describe('when renaming its gist fails, ', () => {
    it('then the successful issue and its picture are still returned.', async () => {
      f = await feedbackFixture(null, [{ match: ['gist', 'edit'], stderr: 'offline', code: 1 }, ...readyReplies]);
      f.gist();
      const reply = await f.client.call('feedback', { method: 'POST', body: report });
      assert.equal(reply.status, 200, reply.text);
      assert.equal((reply.data as { gist: string }).gist, `https://gist.github.com/${gistId}`);
      assert.equal((reply.data as { url: string }).url, issueUrl);
      assert.equal(f.gh.calls().filter((c) => c.args[0] === 'issue').length, 1);
    });
  });
});

describe('Given an HTTP request that is not JSON, ', () => {
  describe('when it reaches the feedback route, ', () => {
    it('then it gets the malformed-request error and web fallback without any gh call.', async () => {
      f = await feedbackFixture();
      const response = await fetch(new URL('api/feedback', f.url), {
        method: 'POST', headers: { 'x-untangle-token': new URL(f.url).searchParams.get('token')!, 'content-type': 'application/json' }, body: '{',
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'not JSON', web: true });
      assert.deepEqual(f.gh.calls(), []);
    });
  });
});
