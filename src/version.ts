import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package's root folder: dist/, analysis/ and viewer/ live in it. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
