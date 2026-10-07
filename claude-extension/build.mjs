// Builds juke.mcpb, the one-click Claude Desktop extension: juke's MCP server (../mcp/src/index.ts) bundled into one
// file with its dependencies, beside manifest.json and the icon, zipped. Run from the kit's root:
//   node claude-extension/build.mjs        (needs esbuild: npx esbuild, and the mcp folder's npm install)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stage = join(here, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
execFileSync(process.env.ESBUILD ?? 'npx', [...(process.env.ESBUILD ? [] : ['esbuild']), join(here, '..', 'mcp', 'src', 'index.ts'),
  '--bundle', '--platform=node', '--format=esm', '--target=node20', `--outfile=${join(stage, 'server', 'index.js')}`,
  '--banner:js=import { createRequire } from "module"; const require = createRequire(import.meta.url);'], { stdio: 'inherit', cwd: join(here, '..', 'mcp') });
copyFileSync(join(here, 'manifest.json'), join(stage, 'manifest.json'));
copyFileSync(join(here, 'icon.png'), join(stage, 'icon.png'));
rmSync(join(here, 'juke.mcpb'), { force: true });
execFileSync('zip', ['-r', '-X', '-q', join(here, 'juke.mcpb'), 'manifest.json', 'icon.png', 'server'], { cwd: stage, stdio: 'inherit' });
console.log(`built ${join(here, 'juke.mcpb')}`);
