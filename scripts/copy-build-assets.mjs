import { cp, mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const sourceRoot = 'server';
const destinationRoot = join('dist', 'server', 'server');
const copyableExtensions = new Set(['.py', '.sql']);

async function copyAssets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;

    const source = join(directory, entry.name);
    if (entry.isDirectory()) {
      await copyAssets(source);
      continue;
    }

    if (!copyableExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue;

    const destination = join(destinationRoot, relative(sourceRoot, source));
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(source, destination);
  }
}

await copyAssets(sourceRoot);
