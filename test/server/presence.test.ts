import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Narrator } from '../../dist/narrate.js';
import { ReviewServer } from '../../dist/server.js';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server that counts the times it went idle, 200 ms after its last page closed. */
async function serving(call: () => Promise<{ data: unknown }> = async () => ({ data: null })) {
  let idle = 0;
  const server = new ReviewServer(
    { host: '127.0.0.1', port: 0, portExplicit: false, basePath: '/', idle: { after: 200, then: () => { idle += 1; } } },
    new Narrator({ quiet: true, verbose: false, color: false }),
    { page: () => null, asset: () => null, call },
    '<p>Untangling…</p>',
    () => {},
  );
  const client: ReviewClient = reviewClient(await server.listen());
  await client.open();
  return {
    client,
    idle: () => idle,
    page: (id: string, open: boolean) => client.call('presence', { method: 'POST', body: { id, open } }),
    close: () => server.close(),
  };
}

describe('Given a page that said it opened, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;

  before(async () => {
    s = await serving();
    await s.page('first', true);
  });
  after(() => s.close());

  describe('when it closes, ', () => {
    let seen = '';

    before(async () => {
      await s.page('first', false);
      const early = s.idle();
      await sleep(400);
      seen = `${early} then ${s.idle()}`;
    });

    it('then the server is idle once the moment after it passes, not before.', () => {
      assert.equal(seen, '0 then 1');
    });
  });
});

describe('Given a page that said it opened, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;

  before(async () => {
    s = await serving();
    await s.page('before', true);
  });
  after(() => s.close());

  describe('when it is reloaded: it closes, and the next page opens within the moment, ', () => {
    let idle = -1;

    before(async () => {
      await s.page('before', false);
      await s.page('after', true);
      await sleep(400);
      idle = s.idle();
    });

    it('then the server is not idle.', () => {
      assert.equal(idle, 0);
    });
  });
});

describe('Given two open pages, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;

  before(async () => {
    s = await serving();
    await s.page('one', true);
    await s.page('two', true);
  });
  after(() => s.close());

  describe('when one closes, and later the other, ', () => {
    let seen = '';

    before(async () => {
      await s.page('one', false);
      await sleep(400);
      const one = s.idle();
      await s.page('two', false);
      await sleep(400);
      seen = `${one} then ${s.idle()}`;
    });

    it('then the server is idle only once both have closed.', () => {
      assert.equal(seen, '0 then 1');
    });
  });
});

describe('Given a call still being answered when the last page closes, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;
  let answer = () => {};
  let pending: Promise<unknown>;

  before(async () => {
    s = await serving(() => new Promise((resolve) => { answer = () => resolve({ data: null }); }));
    await s.page('page', true);
    pending = s.client.call('state', { method: 'PUT', body: {} });
    await sleep(50);
    await s.page('page', false);
  });
  after(() => s.close());

  describe('when the call is answered after the moment, ', () => {
    let seen = '';

    before(async () => {
      await sleep(400);
      const waiting = s.idle();
      answer();
      await pending;
      await sleep(400);
      seen = `${waiting} then ${s.idle()}`;
    });

    it('then the server is idle only once it has answered.', () => {
      assert.equal(seen, '0 then 1');
    });
  });
});
