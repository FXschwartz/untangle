import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Narrator } from '../../dist/narrate.js';
import { ReviewServer } from '../../dist/server.js';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';

interface Status {
  rev: number;
  steps: Array<{ label: string; state: string }>;
}

const said = (data: unknown) => (data as Status).steps.map((step) => `${step.label} ${step.state}`).join(', ');

describe('Given the page that follows a review while it is built, ', () => {
  let narrator: Narrator;
  let server: ReviewServer;
  let client: ReviewClient;

  before(async () => {
    narrator = new Narrator({ quiet: true, verbose: false, color: false });
    server = new ReviewServer(
      { host: '127.0.0.1', port: 0, portExplicit: false, basePath: '/' },
      narrator,
      { page: () => null, asset: () => null, call: async () => ({ data: null }) },
      '<p>Untangling…</p>',
      () => {},
    );
    client = reviewClient(await server.listen());
    await client.open();
    narrator.step('packages');
  });

  after(async () => {
    narrator.finish();
    await server.close();
  });

  describe('when it asks with the revision it shows, and the next step starts a moment later, ', () => {
    let early = '';
    let answer = '';

    before(async () => {
      const shown = (await client.call('status')).data as Status;
      const asked = client.call('status', { query: { rev: String(shown.rev) } });
      early = await Promise.race([asked.then(() => 'answered'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 300))]);
      narrator.step('diff');
      answer = said((await asked).data);
    });

    it('then the answer waits for that step, and says it runs.', () => {
      assert.equal(`${early}\n${answer}`, 'waiting\npackages done, diff running');
    });
  });

  describe('when it asks with a revision it has already passed, ', () => {
    let answer = '';

    before(async () => {
      const { data } = await client.call('status', { query: { rev: '0' } });
      answer = said(data);
    });

    it('then it is answered at once, with where the build is.', () => {
      assert.equal(answer, 'packages done, diff running');
    });
  });
});
