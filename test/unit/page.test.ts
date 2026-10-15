import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { reviewPage, type PageConfig } from '../../dist/page.js';
import type { ReviewData } from '../../dist/build.js';

const placeholders = ['/*TITLE*/', '<!--FONTS-->', '<!--HIGHLIGHT-->', '/*CORE*/', '/*CONFIG*/', '/*MODEL*/', '/*DEFS*/', '/*REFS*/', '/*DEFSOLD*/', '/*HISTORY*/', '/*VIEWER*/'];

function review(note: string): ReviewData {
  return {
    model: { compares: { base: { label: 'main', files: [], generated: [], edits: [], groups: [], chains: [], note } } },
    defs: { targets: [], defs: {} },
    refs: {},
    defsOld: { base: { targets: [], defs: {} } },
    history: null,
  };
}

const config: PageConfig = { served: true, key: 'local/sample', state: null, url: null, where: 'sample · main → abcdef0' };

function modelScript(html: string): string {
  const marker = 'id="d-model">';
  const start = html.indexOf(marker) + marker.length;
  return html.slice(start, html.indexOf('</script>', start));
}

describe('Given a review whose data contains "</script>", ', () => {
  const data = review('</script><script>alert(1)</script>');

  describe('when the page is rendered, ', () => {
    let html: string;

    before(() => {
      html = reviewPage(data, 'A <review>', 'served')(config);
    });

    it('then the review is one document and that text cannot close the script.', () => {
      const model = modelScript(html);
      assert.equal(model.includes('<'), false);
      assert.equal(model.includes('\\u003c/script>'), true);
      assert.equal(html.includes('id="d-history"'), true);
    });

    it('then every placeholder is replaced.', () => {
      assert.equal(placeholders.filter((token) => html.includes(token)).join('\n'), '');
    });

    it('then the title is in the document.', () => {
      assert.equal(html.includes('<title>A &lt;review&gt; · untangle</title>'), true);
    });
  });
});
