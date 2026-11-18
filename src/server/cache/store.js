import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

function repositoryCacheName(repositoryPath) {
  return `${createHash('sha256').update(path.resolve(repositoryPath)).digest('hex')}.json`;
}

export function createCacheStore(cacheDirectory) {
  if (!cacheDirectory) throw new TypeError('cacheDirectory is required');

  function fileFor(repositoryPath) {
    return path.join(cacheDirectory, repositoryCacheName(repositoryPath));
  }

  async function read(repositoryPath) {
    try {
      return JSON.parse(await readFile(fileFor(repositoryPath), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function write(repositoryPath, value) {
    await mkdir(cacheDirectory, { recursive: true });
    const destination = fileFor(repositoryPath);
    const temporary = path.join(cacheDirectory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;

    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);

      const directory = await open(cacheDirectory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return value;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function scanAndStore(repositoryPath, scanner, options) {
    const value = await scanner(repositoryPath, options);
    await write(repositoryPath, value);
    return value;
  }

  return { fileFor, read, write, scanAndStore };
}

export class JsonCacheStore {
  constructor(cacheDirectory) {
    Object.assign(this, createCacheStore(cacheDirectory));
  }
}

export { repositoryCacheName };
export default createCacheStore;
