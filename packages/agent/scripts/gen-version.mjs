#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(version)) process.exit(1);
const output = `// DO NOT EDIT — generated from package.json by scripts/gen-version.mjs.\n// Run \`pnpm --filter @openrouter/agent gen:version\` after bumping the version.\n\n/** This package's version, self-reported to MCP servers as \`clientInfo\`. */\nexport const PACKAGE_VERSION = '${version}';\n`;
writeFileSync(join(root, 'src/mcp/version.ts'), output);
