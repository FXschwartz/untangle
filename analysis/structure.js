// Semantic structure supplied by the Dart analyzer. Positions use UTF-16 columns, like LSP.
export const TYPE_KINDS = new Set(['CLASS', 'MIXIN', 'EXTENSION', 'EXTENSION_TYPE', 'ENUM', 'TYPE_ALIAS']);
export const CALLABLE_KINDS = new Set(['FUNCTION', 'METHOD', 'CONSTRUCTOR', 'GETTER', 'SETTER']);
const MEMBER_KINDS = new Set([...CALLABLE_KINDS, 'FIELD', 'TOP_LEVEL_VARIABLE']);
const indexes = new WeakMap();

export function indexOf(structure) {
  let index = indexes.get(structure);
  if (!index) {
    index = {
      positions: new Map(structure.declarations.map((declaration) => [declaration.position, declaration])),
      ids: new Map(structure.declarations.map((declaration) => [declaration.id, declaration])),
      members: structure.declarations.filter((declaration) => MEMBER_KINDS.has(declaration.kind)),
      types: structure.declarations.filter((declaration) => TYPE_KINDS.has(declaration.kind)),
    };
    indexes.set(structure, index);
  }
  return index;
}

export const declarationAt = (structure, line, col) => indexOf(structure).positions.get(`${line}:${col}`);
const contains = (declaration, line, col) => declaration.startLine <= line && declaration.endLine >= line
  && (line !== declaration.startLine || col >= declaration.startColumn)
  && (line !== declaration.endLine || col < declaration.endColumn);
const innermost = (declarations, line, col) => declarations.filter((declaration) => contains(declaration, line, col))
  .sort((a, b) => (a.end - a.offset) - (b.end - b.offset))[0];

export function memberName(structure, declaration) {
  const owner = indexOf(structure).ids.get(declaration.owner);
  if (!owner || !TYPE_KINDS.has(owner.kind)) return declaration.name;
  if (declaration.kind === 'CONSTRUCTOR') {
    return declaration.name.endsWith('.new') ? `${owner.name}.${owner.name}` : declaration.name;
  }
  return `${owner.name}.${declaration.name}`;
}

export function memberAt(structure, line, col) {
  const index = indexOf(structure);
  const member = innermost(index.members, line, col);
  const owner = innermost(index.types, line, col);
  const test = innermost(structure.scenarios.filter((scenario) => scenario.name !== 'group'), line, col);
  const group = innermost(structure.scenarios.filter((scenario) => scenario.name === 'group'), line, col);
  return {
    member: member ? memberName(structure, member) : owner?.name || null,
    test: test?.title || null,
    group: group?.title || null,
    testKey: test ? `test:${test.startLine}:${test.startColumn}` : null,
  };
}

export function introducedCandidates(structure) {
  const declarations = structure.declarations.flatMap((declaration) => {
    const kind = TYPE_KINDS.has(declaration.kind) ? 'type'
      : CALLABLE_KINDS.has(declaration.kind) ? 'function'
      : declaration.kind === 'TOP_LEVEL_VARIABLE' ? 'binding' : null;
    return kind ? [{ ...declaration, kind, name: kind === 'function' ? memberName(structure, declaration) : declaration.name }] : [];
  });
  return declarations.concat(structure.scenarios.filter((scenario) => scenario.name !== 'group').map((scenario) => ({ ...scenario, kind: 'test', name: scenario.title })));
}
