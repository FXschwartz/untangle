// Generated-code adapters, shared by export_diff.py (through generated_globs.js) and analyze.js.
// Each one switches on by what the repository contains; .review.yaml can override that.
'use strict';
const ADAPTERS = {
  // Serverpod: a generated class maps to its model class (minus the suffix), a field to the
  // model field of the same name, and a relation's …Id column to the relation.
  serverpod: {
    detect: /\.spy\.yaml$/, generated: ['**/generated/**', '**/migrations/**'],
    model: { kind: 'yaml', generated: ['**/generated/**'], source: '**/*.spy.yaml', classSuffixes: 'Table|Include|IncludeList|Repository|AttachRepository|AttachRowRepository|DetachRepository|DetachRowRepository' },
  },
  // Generated part files (build_runner: freezed, json_serializable, built_value, riverpod...):
  // a generated declaration maps to the one it was generated for, in the library that owns
  // the part. _$User, $UserCopyWith and _User map to User, and their members to User's.
  build_runner: {
    detect: /\.(g|freezed)\.dart$/, generated: ['**/*.g.dart', '**/*.freezed.dart', '**/*.gr.dart', '**/*.config.dart', '**/*.mocks.dart'],
    model: { kind: 'part', generated: ['**/*.g.dart', '**/*.freezed.dart'] },
  },
  // Protobuf: a generated message class maps to its .proto message, and a getter (or its
  // has/clear/ensure accessor) to the field of the same name in snake_case.
  protobuf: {
    detect: /\.proto$/, generated: ['**/*.pb.dart', '**/*.pbenum.dart', '**/*.pbjson.dart', '**/*.pbserver.dart', '**/*.pbgrpc.dart'],
    model: { kind: 'proto', generated: ['**/*.pb.dart'], source: '**/*.proto' },
  },
};

// Generated-file patterns of the adapters on for a repository's files, plus .review.yaml's.
function generatedGlobs(paths, review) {
  const on = (k) => (review && review.adapters && k in review.adapters ? !!review.adapters[k] : paths.some((p) => ADAPTERS[k].detect.test(p)));
  return Object.keys(ADAPTERS).filter(on).flatMap((k) => ADAPTERS[k].generated.map((g) => [g, k + ' adapter']))
    .concat(((review && review.generated) || []).map((g) => [g, '.review.yaml']));
}
module.exports = { ADAPTERS, generatedGlobs };
