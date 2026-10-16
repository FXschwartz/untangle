// Reading units sit above edit blocks. Blocks retain their ids and marks; a wholly new
// declaration is read in source order, without turning each field into a separate task.
const TYPES = new Set(['class_definition', 'mixin_declaration', 'extension_declaration', 'enum_declaration', 'extension_type_declaration', 'type_alias']);
const SIGNATURES = new Set(['method_signature', 'function_signature', 'getter_signature', 'setter_signature', 'constructor_signature', 'factory_constructor_signature', 'operator_signature', 'redirecting_factory_constructor_signature', 'constant_constructor_signature']);
const TEST_FILE = /(^|\/)(test|test_[a-z0-9_]+|integration_test)\/|_test\.dart$/;

/** The full title is a label. The call's source position, never that title, is its identity. */
export function testCall(node) {
  if (node.type !== 'expression_statement') return null;
  const call = /^(testWidgets|test|group)\s*\(/.exec(node.text);
  if (!call) return null;

  const args = node.namedChildren.find((c) => c.type === 'selector')?.descendantsOfType('arguments')[0];
  const arg = args?.namedChildren.find((c) => c.type === 'argument');
  if (!arg) return null;

  const literals = [...arg.text.matchAll(/r?(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g)];
  const title = literals.length ? literals.map((m) => m[2].replace(/\\(['"\\])/g, '$1')).join('') : arg.text;
  return { kind: call[1], title, key: `test:${node.startPosition.row + 1}:${node.startPosition.column}` };
}

function nameOf(node) {
  const name = node.childForFieldName('name');
  if (name) return name.text;
  if (node.type === 'extension_declaration') {
    const body = node.namedChildren.find((child) => child.type === 'extension_body');
    if (body) return node.text.slice(0, body.startIndex - node.startIndex).replace(/\s+/g, ' ').trim();
  }
  if (node.type === 'type_alias') return node.namedChildren.find((child) => child.type === 'type_identifier')?.text;
  const signature = node.namedChildren.find((c) => SIGNATURES.has(c.type));
  if (signature) return nameOf(signature);
  return node.namedChildren.find((c) => c.type === 'identifier')?.text || null;
}

function startOf(node) {
  let start = node.startPosition.row + 1;
  for (let previous = node.previousSibling; previous; previous = previous.previousSibling) {
    if (!/^(comment|documentation_comment|annotation|marker_annotation)$/.test(previous.type) || previous.endPosition.row < start - 2) break;
    start = previous.startPosition.row + 1;
  }
  return start;
}

/** Assigns only fully introduced declarations, including new declarations in existing files. */
export function readingUnits(files, modelPatterns = []) {
  const units = [];

  for (const file of files) {
    if (!file.newTree) continue;
    const source = file.newSrc.split('\n');
    const added = new Set(file.blocks.flatMap((b) => b.rows.filter((r) => r.type === '+').map((r) => r.n)));
    const candidates = [];
    const isTestFile = TEST_FILE.test(file.p);
    const existing = new Set();

    const oldDeclarations = (node, owner = null) => {
      if (TYPES.has(node.type)) {
        const name = nameOf(node);
        existing.add(`type:${name}`);
        owner = name;
      } else if (SIGNATURES.has(node.type) && !SIGNATURES.has(node.parent?.type)) {
        const name = nameOf(node);
        existing.add(`function:${owner && name !== owner ? `${owner}.${name}` : name}`);
      }

      for (const child of node.namedChildren) {
        if (child.type !== 'string_literal') oldDeclarations(child, owner);
      }
    };

    if (file.oldTree) oldDeclarations(file.oldTree.rootNode);

    const add = (node, kind, name, endNode = node) => {
      const start = startOf(node);
      const end = endNode.endPosition.row + 1;
      if (existing.has(`${kind}:${name}`)) return;
      if (file.blocks.some((block) => (block.move || block.movedTo || block.dels) && block.rows.some((row) => row.type === '+' && row.n >= start && row.n <= end && !/^[\s{}();,]*$/.test(row.text)))) return;
      // Git can match a new declaration's closing brace to an old declaration's brace.
      // Punctuation reused that way does not turn the new declaration into existing code.
      if (!name || !source.slice(start - 1, end).every((line, i) => /^[\s{}();,]*$/.test(line) || added.has(start + i))) return;
      candidates.push({ id: `${file.p}:${start}:${node.startPosition.column}`, file: file.p, kind, name, start, end, blocks: new Set() });
    };

    const visit = (node, owner = null) => {
      if (TYPES.has(node.type)) {
        const name = nameOf(node);
        add(node, 'type', name);
        owner = name;
      } else if (SIGNATURES.has(node.type) && !SIGNATURES.has(node.parent?.type)) {
        const name = nameOf(node);
        // A test entrypoint is infrastructure for its scenarios, not one giant scenario.
        if (!(isTestFile && name === 'main')) {
          const body = node.nextNamedSibling?.type === 'function_body' ? node.nextNamedSibling : node;
          add(node, 'function', owner && name !== owner ? `${owner}.${name}` : name, body);
        }
      } else if (node.parent?.type === 'program' && /^(static_final_declaration_list|initialized_identifier_list)$/.test(node.type)) {
        const names = node.namedChildren.map((child) => nameOf(child)).filter(Boolean);
        add(node, 'binding', names.join(', '));
      } else if (isTestFile) {
        const test = testCall(node);
        if (test && test.kind !== 'group') add(node, 'test', test.title);
      }

      for (const child of node.namedChildren) {
        if (child.type !== 'string_literal') visit(child, owner);
      }
    };

    visit(file.newTree.rootNode);
    // The outer type owns its methods; a test owns helpers declared inside its callback.
    let outer = candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.start <= candidate.start && other.end >= candidate.end && (other.start < candidate.start || other.end > candidate.end)));

    // An existing atomic block can span adjacent declarations with no blank line between
    // them. Keep those declarations together rather than splitting a saved review identity.
    for (const block of file.blocks) {
      if (block.move || block.movedTo || block.dels) continue;
      const rows = block.rows.filter((row) => row.type === '+' && row.text.trim());
      const touching = outer.filter((candidate) => rows.some((row) => row.n >= candidate.start && row.n <= candidate.end));
      if (touching.length < 2) continue;
      if (!rows.every((row) => /^[\s{}();,]*$/.test(row.text) || touching.some((candidate) => row.n >= candidate.start && row.n <= candidate.end))) continue;

      const first = touching.reduce((a, b) => a.start < b.start ? a : b);
      const bundle = { ...first, kind: touching.every((candidate) => candidate.kind === 'test') ? 'test' : 'declarations', name: touching.map((candidate) => candidate.name).join(', '), end: Math.max(...touching.map((candidate) => candidate.end)), blocks: new Set() };
      outer = outer.filter((candidate) => !touching.includes(candidate));
      outer.push(bundle);
    }

    for (const block of file.blocks) {
      if (block.move || block.movedTo || block.dels) continue;
      const rows = block.rows.filter((r) => r.type === '+' && r.text.trim());
      if (!rows.length) continue;
      // A trailing class brace or blank separator may share the final member's block.
      const unit = outer.find((candidate) => rows.every((r) => r.n >= candidate.start && (r.n <= candidate.end || /^[\s});,]*$/.test(r.text))));
      if (!unit) continue;
      block.unit = unit;
      unit.blocks.add(block);
    }

    units.push(...outer.filter((unit) => [...unit.blocks].some((block) => block.edits.length)));

    if (isTestFile && file.s === 'A') {
      const blocks = file.blocks.filter((block) => !block.unit);
      if (blocks.some((block) => block.edits.length)) {
        const setup = { id: `${file.p}:setup`, file: file.p, kind: 'setup', name: 'Setup and groups', start: 1, end: source.length, blocks: new Set(blocks) };
        blocks.forEach((block) => { block.unit = setup; });
        units.push(setup);
      }
    }
  }

  // A new generator model is authored as one declaration, independently of its fields.
  for (const file of files) {
    if (file.s !== 'A' || !modelPatterns.some((pattern) => pattern.test(file.p))) continue;
    const name = /^(?:class|exception):\s*(\w+)/m.exec(file.newSrc || '')?.[1];
    if (!name) continue;
    const unit = { id: `${file.p}:1:0`, file: file.p, kind: 'model', name, start: 1, end: file.newSrc.split('\n').length, blocks: new Set(file.blocks) };
    file.blocks.forEach((block) => { block.unit = unit; });
    units.push(unit);
  }

  return units;
}
