import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'openrouter-package-boundaries-'));
const packDir = join(scratch, 'packs');
const consumerDir = join(scratch, 'consumer');
const packages = [
  'packages/agent',
  'packages/mcp',
];

function run({ command, args, cwd = root, capture = false }) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
}

function pack(packageDir) {
  const output = run({
    command: 'pnpm',
    args: [
      'pack',
      '--pack-destination',
      packDir,
      '--json',
    ],
    cwd: join(root, packageDir),
    capture: true,
  });
  const result = JSON.parse(output);
  const filename = Array.isArray(result) ? result[0]?.filename : result.filename;
  if (typeof filename !== 'string') {
    throw new Error(`Could not determine tarball name for ${packageDir}`);
  }
  return resolve(packDir, filename);
}

function tarEntries(tarball) {
  return run({
    command: 'tar',
    args: [
      '-tzf',
      tarball,
    ],
    capture: true,
  })
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//u, ''));
}

function verifyExports(packageDir, entries) {
  const manifest = JSON.parse(readFileSync(join(root, packageDir, 'package.json'), 'utf8'));
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (typeof target === 'string') {
      if (!entries.includes(target.replace(/^\.\//u, ''))) {
        throw new Error(`${manifest.name} ${subpath} target is missing: ${target}`);
      }
      continue;
    }
    for (const kind of [
      'types',
      'default',
    ]) {
      const path = target[kind];
      if (typeof path === 'string' && !entries.includes(path.replace(/^\.\//u, ''))) {
        throw new Error(`${manifest.name} ${subpath} ${kind} target is missing: ${path}`);
      }
    }
  }
  const leaked = entries.filter(
    (entry) => /^(src|tests)\//u.test(entry) || /(^|\/)tsconfig(?:\.[^/]*)?\.json$/u.test(entry),
  );
  if (leaked.length > 0) {
    throw new Error(`${manifest.name} tarball leaks development files:\n${leaked.join('\n')}`);
  }
  return manifest;
}

try {
  run({
    command: 'pnpm',
    args: [
      '--filter',
      '@openrouter/agent',
      'build',
    ],
  });
  run({
    command: 'pnpm',
    args: [
      '--filter',
      '@openrouter/mcp',
      'build',
    ],
  });
  mkdirSync(packDir, {
    recursive: true,
  });
  mkdirSync(consumerDir, {
    recursive: true,
  });

  const tarballs = packages.map(pack);
  const manifests = packages.map((packageDir, index) =>
    verifyExports(packageDir, tarEntries(tarballs[index])),
  );

  run({
    command: 'npm',
    args: [
      'init',
      '-y',
    ],
    cwd: consumerDir,
    capture: true,
  });
  run({
    command: 'npm',
    args: [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarballs[0],
    ],
    cwd: consumerDir,
  });

  const baseSmoke = `
for (const entry of ['@openrouter/agent', '@openrouter/agent/tool-set', '@openrouter/agent/mcp']) {
  await import(entry);
}
const { createMCPTools, MCPMissingPeerDependencyError } = await import('@openrouter/agent/mcp');
try {
  await createMCPTools({ url: 'https://mcp.example.com/mcp' });
  throw new Error('Expected the optional MCP peer to be absent');
} catch (error) {
  if (!(error instanceof MCPMissingPeerDependencyError)) throw error;
  if (!error.message.includes('pnpm add @modelcontextprotocol/client')) throw error;
}
`;
  run({
    command: 'node',
    args: ['--input-type=module', '--eval', baseSmoke],
    cwd: consumerDir,
  });

  run({
    command: 'npm',
    args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballs[1]],
    cwd: consumerDir,
  });
  const facadeSmoke = `
for (const entry of [
  '@openrouter/mcp',
  '@openrouter/mcp/create-mcp-tools',
  '@openrouter/mcp/types',
  '@openrouter/mcp/schema',
  '@openrouter/mcp/cache',
]) await import(entry);
`;
  run({
    command: 'node',
    args: ['--input-type=module', '--eval', facadeSmoke],
    cwd: consumerDir,
  });

  const tree = JSON.parse(
    run({
      command: 'npm',
      args: [
        'ls',
        '@openrouter/agent',
        '--all',
        '--json',
      ],
      cwd: consumerDir,
      capture: true,
    }),
  );
  const direct = tree.dependencies?.['@openrouter/agent'];
  if (direct?.version !== manifests[0].version) {
    throw new Error(
      `Packed @openrouter/mcp did not resolve packed @openrouter/agent ${manifests[0].version}`,
    );
  }
  const nested = tree.dependencies?.['@openrouter/mcp']?.dependencies?.['@openrouter/agent'];
  if (nested !== undefined && nested.version !== manifests[0].version) {
    throw new Error(`Packed facade resolved a second @openrouter/agent version: ${nested.version}`);
  }

  console.log('Package exports, tarballs, optional-peer isolation, and packed installs verified.');
} finally {
  rmSync(scratch, {
    recursive: true,
    force: true,
  });
}
