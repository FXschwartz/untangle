// Serverpod model navigation, shared by saved definitions and live lookups. Like the
// Serverpod extension, resolve PascalCase names (and import prefixes) to YAML declarations.
// The index belongs to one immutable checkout; it needs no second language server.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ADAPTERS } from '../analysis/adapters.js';
import { gitMaybe } from './exec.js';
import type { Location } from './lsp/dart.js';
import '../viewer/core.js';

const MODEL = /\.spy(?:\.ya?ml)?$/;
const SUFFIX = new RegExp(`(${ADAPTERS.serverpod.model.classSuffixes})$`);
interface Model extends Location { package: string }

export class ModelDefinitions {
  private indexed = false;
  private readonly models = new Map<string, Model[]>();
  private readonly packages = new Map<string, string>();
  private readonly owners = new Map<string, Set<string>>();
  private readonly sources = new Map<string, { text: string; lines: string[] }>();

  constructor(private readonly root: string) {}

  private source(file: string): { text: string; lines: string[] } {
    if (!this.sources.has(file)) {
      if (this.sources.size >= 32) this.sources.delete(this.sources.keys().next().value!);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { /* Absent generated files are normal. */ }
      this.sources.set(file, { text, lines: text.split('\n') });
    }
    return this.sources.get(file)!;
  }

  private packageOf(file: string): string {
    for (let dir = path.dirname(file); dir.startsWith(this.root); dir = path.dirname(dir)) {
      if (this.packages.has(dir) || dir === this.root) return dir;
    }
    return this.root;
  }

  private index(): void {
    if (this.indexed) return;
    this.indexed = true;
    const files = (gitMaybe(this.root, 'ls-files', '-z', '--', '*.spy.yaml', '*.spy.yml', '*.spy', 'pubspec.yaml', '**/pubspec.yaml') || '').split('\0').filter(Boolean);
    for (const p of files.filter((p) => path.basename(p) === 'pubspec.yaml')) {
      try {
        const spec = YAML.parse(this.source(path.join(this.root, p)).text);
        if (typeof spec?.name === 'string') this.packages.set(path.dirname(path.join(this.root, p)), spec.name);
      } catch { /* An invalid pubspec cannot identify a package. */ }
    }
    for (const dir of this.packages.keys()) {
      try {
        const config = YAML.parse(this.source(path.join(dir, 'config/generator.yaml')).text);
        if (!config) continue;
        const shared = Array.isArray(config?.shared_packages) ? config.shared_packages.filter((p: unknown) => typeof p === 'string').map((p: string) => path.resolve(dir, p)) : [];
        this.owners.set(dir, new Set([...(this.owners.get(dir) || []), dir, ...shared]));
        if (typeof config?.client_package_path === 'string') {
          const client = path.resolve(dir, config.client_package_path);
          this.owners.set(client, new Set([...(this.owners.get(client) || []), client, dir, ...shared]));
        }
      } catch { /* Without generator settings, models belong to their own package. */ }
    }
    for (const p of files.filter((p) => MODEL.test(p))) {
      const file = path.join(this.root, p);
      const counter = new YAML.LineCounter();
      const doc = YAML.parseDocument(this.source(file).text, { lineCounter: counter });
      if (doc.errors.length || !YAML.isMap(doc.contents)) continue;
      for (const key of ['class', 'exception', 'enum']) {
        const node = doc.get(key, true);
        if (!YAML.isScalar(node) || typeof node.value !== 'string' || !node.range) continue;
        const name = node.value;
        if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) continue;
        const offset = node.range[0] + this.source(file).text.slice(node.range[0], node.range[1]).indexOf(name);
        const at = counter.linePos(offset);
        const model = { path: file, line: at.line - 1, col: at.col - 1, package: this.packageOf(file) };
        this.models.set(name, [...(this.models.get(name) || []), model]);
      }
    }
  }

  /** A YAML target, or null to retain the Dart answer. No global same-name guesses. */
  resolve(file: string, line: number, col: number, dart: Location | null): Location | null {
    if (!file.startsWith(this.root + path.sep)) return null;
    if (dart && (!dart.path.startsWith(this.root + path.sep) || !dart.path.includes('/generated/'))) return null;
    const source = this.source(file);
    const text = source.lines[line] || '';
    const token = globalThis.ReviewCore.tokenize(text, MODEL.test(file) ? 'yaml' : 'dart').find((t) => t.c <= col && t.c + t.t.length > col);
    if (!token || !['id', 'ty'].includes(token.k) || !/^[A-Z][A-Za-z0-9_]*$/.test(token.t)) return null;
    const prefix = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(text.slice(0, token.c))?.[1];

    this.index();
    const candidates = this.models.get(token.t) || this.models.get(token.t.replace(SUFFIX, '')) || [];
    if (!candidates.length) return null;
    const inPackages = (roots: Set<string>) => candidates.filter((m) => [...roots].some((root) => (this.owners.get(root) || new Set([root])).has(m.package)));
    const pick = (matches: Model[]) => matches.length === 1 ? { path: matches[0].path, line: matches[0].line, col: matches[0].col } : null;
    if (dart) return pick(inPackages(new Set([this.packageOf(dart.path)])));

    if (!prefix) {
      const local = inPackages(new Set([this.packageOf(file)]));
      if (local.length) return pick(local);
    }
    const imported = new Set<string>();
    for (const match of source.text.matchAll(/\bimport\s+(['"])([^'"\n]+)\1([^;]*);/g)) {
      const alias = /\bas\s+(\w+)/.exec(match[3])?.[1];
      if (alias !== prefix) continue;
      const show = /\bshow\s+([\w\s,]+)/.exec(match[3])?.[1].match(/\w+/g);
      const hide = /\bhide\s+([\w\s,]+)/.exec(match[3])?.[1].match(/\w+/g);
      if ((show && !show.includes(token.t)) || hide?.includes(token.t)) continue;
      if (match[2].startsWith('package:')) {
        const name = match[2].slice(8).split('/')[0];
        for (const [dir, packageName] of this.packages) if (name === packageName) imported.add(dir);
      } else if (!match[2].includes(':')) {
        imported.add(this.packageOf(path.resolve(path.dirname(file), match[2])));
      }
    }
    return pick(inPackages(imported));
  }
}
