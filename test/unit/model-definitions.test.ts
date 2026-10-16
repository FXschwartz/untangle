import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ModelDefinitions } from '../../dist/model-definitions.js';
import { definitionCollector } from '../../dist/pipeline/definitions.js';
import { TempRepo } from '../helpers/repo.ts';

describe('Given two packages defining Invoice and a client generated from shared models, ', () => {
  let repo: TempRepo;
  let models: ModelDefinitions;
  const model = 'domain/lib/src/models/invoice.spy.yaml';
  const at = (p: string, line: number, col: number) => ({ path: path.join(repo.dir, p), line, col });

  before(() => {
    repo = TempRepo.create();
    repo.write('app/pubspec.yaml', 'name: app\n');
    repo.write('domain/pubspec.yaml', 'name: domain\n');
    repo.write('other/pubspec.yaml', 'name: other\n');
    repo.write('client/pubspec.yaml', 'name: client\n');
    repo.write('server/pubspec.yaml', 'name: server\n');
    repo.write('server/config/generator.yaml', 'client_package_path: ../client\nshared_packages:\n  - ../domain\n');
    repo.write(model, '### A shared invoice.\nclass: Invoice\nfields:\n  amount: int\n');
    repo.write('other/lib/src/models/invoice.spy.yaml', 'class: Invoice\nfields:\n  description: String\n');
    repo.write('domain/lib/src/models/status.spy.yml', 'enum: Status\nvalues:\n  - paid\n');
    repo.write('domain/lib/src/models/problem.spy', 'exception: Problem\nfields:\n  message: String\n');
    repo.write('app/lib/prefixed.dart', "import 'package:domain/domain.dart' as billing;\nbilling.Invoice? invoice;\n");
    repo.write('app/lib/ambiguous.dart', "import 'package:domain/domain.dart';\nimport 'package:other/other.dart';\nInvoice? invoice;\n");
    repo.write('app/lib/hidden.dart', "import 'package:domain/domain.dart' hide Invoice;\nInvoice? invoice;\n");
    repo.write('app/lib/unrelated.dart', 'Invoice? invoice;\n');
    repo.write('client/lib/use.dart', 'Invoice? invoice;\n');
    repo.write('domain/lib/use.dart', 'Invoice? invoice;\nStatus? status;\nProblem? problem;\nInvoiceTable? table;\n');
    models = new ModelDefinitions(repo.dir);
  });

  after(() => repo.remove());

  it(
    'when a generated class resolves in one package, '
    + 'then its YAML definition wins over another package’s same name.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'app/lib/prefixed.dart'), 1, 8, at('domain/lib/src/generated/invoice.dart', 5, 6));

      assert.deepEqual(found, at(model, 1, 7));
    },
  );

  it(
    'when generated code is missing and an import uses a custom alias, '
    + 'then that import selects the YAML model.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'app/lib/prefixed.dart'), 1, 8, null);

      assert.deepEqual(found, at(model, 1, 7));
    },
  );

  it(
    'when two imports supply an unresolved name, '
    + 'then navigation does not guess between them.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'app/lib/ambiguous.dart'), 2, 0, null);

      assert.equal(found, null);
    },
  );

  it(
    'when an import hides the class, '
    + 'then its YAML model is not a fallback.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'app/lib/hidden.dart'), 1, 0, null);

      assert.equal(found, null);
    },
  );

  it(
    'when a package does not import a model, '
    + 'then an unresolved name does not jump to it.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'app/lib/unrelated.dart'), 0, 0, null);

      assert.equal(found, null);
    },
  );

  it(
    'when Dart resolves a handwritten class, '
    + 'then the same-named model does not replace it.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'domain/lib/use.dart'), 0, 0, at('domain/lib/handwritten.dart', 0, 6));

      assert.equal(found, null);
    },
  );

  it(
    'when Dart resolves a client class generated from a shared package, '
    + 'then navigation finds the shared YAML.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'client/lib/use.dart'), 0, 0, at('client/lib/src/generated/invoice.dart', 0, 6));

      assert.deepEqual(found, at(model, 1, 7));
    },
  );

  it(
    'when an enum in a spy.yml file is used, '
    + 'then its model declaration is found.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'domain/lib/use.dart'), 1, 0, null);

      assert.deepEqual(found, at('domain/lib/src/models/status.spy.yml', 0, 6));
    },
  );

  it(
    'when an exception in a spy file is used, '
    + 'then its model declaration is found.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'domain/lib/use.dart'), 2, 0, null);

      assert.deepEqual(found, at('domain/lib/src/models/problem.spy', 0, 11));
    },
  );

  it(
    'when a generated table helper is used, '
    + 'then its underlying model declaration is found.',
    () => {
      const found = models.resolve(path.join(repo.dir, 'domain/lib/use.dart'), 3, 0, null);

      assert.deepEqual(found, at(model, 1, 7));
    },
  );

  describe('when a generated definition is saved for the review page, ', () => {
    let collector: ReturnType<typeof definitionCollector>;
    let generated: ReturnType<typeof at>;

    before(() => {
      generated = at('domain/lib/src/generated/invoice.dart', 5, 6);
      collector = definitionCollector(repo.dir);
      collector.add('app/lib/prefixed.dart', 2, 8, 7, generated);
    });

    it('then the peek contains the YAML declaration and its documentation.', () => {
      assert.deepEqual(collector.data.targets[0], { p: model, w: 'repo', l: 2, c: 7, s: 1, code: ['### A shared invoice.', 'class: Invoice', 'fields:', '  amount: int', ''] });
    });

    it('then chain analysis still receives the original Dart target.', () => {
      assert.deepEqual(collector.data.raw['app/lib/prefixed.dart:2:8'], [generated.path, generated.line, generated.col]);
    });
  });
});
