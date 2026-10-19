import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Narrator } from '../../dist/narrate.js';
import { ReviewServer } from '../../dist/server.js';
import { reviewClient, type PresenceSocket, type ReviewClient } from '../helpers/http.ts';

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
  const url = await server.listen();
  const client: ReviewClient = reviewClient(url);
  await client.open();
  return {
    url,
    client,
    idle: () => idle,
    page: (id: string, open: boolean, asleep?: boolean) => client.call('presence', { method: 'POST', body: asleep ? { id, open, asleep } : { id, open } }),
    socket: (id: string) => client.socket(id),
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

describe('Given a page holding its socket, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;
  let socket: PresenceSocket;

  before(async () => {
    s = await serving();
    await s.page('page', true);
    socket = await s.socket('page');
  });
  after(() => s.close());

  describe('when the socket drops without a word from the page, as Orca\'s browser drops a tab it closes, ', () => {
    let seen = '';

    before(async () => {
      socket.drop();
      await socket.ended;
      await sleep(50);
      const early = s.idle();
      await sleep(400);
      seen = `${socket.status}: ${early} then ${s.idle()}`;
    });

    it('then the server is idle once the moment after it passes, as if the page had said it closed.', () => {
      assert.equal(seen, '101: 0 then 1');
    });
  });
});

describe('Given a page holding its socket, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;
  let socket: PresenceSocket;

  before(async () => {
    s = await serving();
    socket = await s.socket('page');
  });
  after(() => s.close());

  describe('when it closes the socket as it goes, ', () => {
    let idle = -1;

    before(async () => {
      await socket.close();
      await sleep(400);
      idle = s.idle();
    });

    it('then the server is idle a moment later, though the page never said it opened.', () => {
      assert.equal(idle, 1);
    });
  });
});

describe('Given a page that said the browser froze it, holding its socket, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;
  let socket: PresenceSocket;

  before(async () => {
    s = await serving();
    socket = await s.socket('page');
    await s.page('page', true, true);
  });
  after(() => s.close());

  describe('when its socket drops, as the browser discards it, ', () => {
    let idle = -1;

    before(async () => {
      socket.drop();
      await socket.ended;
      await sleep(400);
      idle = s.idle();
    });

    it('then the server is not idle: the page may come back.', () => {
      assert.equal(idle, 0);
    });
  });
});

describe('Given a page whose socket dropped, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;

  before(async () => {
    s = await serving();
    const first = await s.socket('page');
    first.drop();
    await first.ended;
  });
  after(() => s.close());

  describe('when the page holds it again within the moment, ', () => {
    let idle = -1;

    before(async () => {
      await s.socket('page');
      await sleep(400);
      idle = s.idle();
    });

    it('then the server is not idle.', () => {
      assert.equal(idle, 0);
    });
  });
});

describe('Given a server and a page holding its socket, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;
  let socket: PresenceSocket;

  before(async () => {
    s = await serving();
    socket = await s.socket('page');
  });

  describe('when the server closes, ', () => {
    let seen = '';

    before(async () => {
      await s.close();
      seen = await Promise.race([socket.ended.then(() => 'the socket ended'), sleep(2000).then(() => 'the socket still open')]);
    });

    it('then the socket ends with it.', () => {
      assert.equal(seen, 'the socket ended');
    });
  });
});

describe('Given a server, ', () => {
  let s: Awaited<ReturnType<typeof serving>>;

  before(async () => {
    s = await serving();
  });
  after(() => s.close());

  describe('when a socket is asked for without the cookie the printed link gives, ', () => {
    let seen = '';

    before(async () => {
      const stranger = await reviewClient(s.url).socket('page');
      await sleep(50);
      const open = (await s.page('other', false)).data as { pages: number };
      seen = `${stranger.status}, ${open.pages} pages open`;
    });

    it('then it is refused, and no page opened.', () => {
      assert.equal(seen, '403, 0 pages open');
    });
  });
});
