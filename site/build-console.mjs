// Build the console bundle: bundles console.src.js + viem + contract ABIs into console.bundle.js (iife, minified).
// Run from the repo root: node site/build-console.mjs
import { build } from '../node_modules/esbuild/lib/main.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'site', 'console.src.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  outfile: path.join(root, 'site', 'console.bundle.js'),
  logLevel: 'info',
});
console.log('wrote site/console.bundle.js');
