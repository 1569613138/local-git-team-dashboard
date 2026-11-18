import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCacheStore } from './cache/store.js';
import { loadConfig } from './config.js';
import { syncRemoteRepository } from './git/remote.js';
import { scanRepository } from './git/scan.js';
import { createRouter } from './http/router.js';
import { createStaticFileHandler } from './http/static-files.js';
import { createRefreshJobs } from './jobs/refresh.js';

const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIRECTORY, '../..');

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('PORT must be an integer between 0 and 65535');
  }
  return port;
}

async function defaultAggregator() {
  const module = await import('./domain/aggregate.js');
  if (typeof module.aggregateRepositories !== 'function') {
    throw new TypeError('aggregate.js must export aggregateRepositories(entries, options)');
  }
  return module.aggregateRepositories;
}

export async function createApplication(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const configPath = path.resolve(options.configPath ?? process.env.GIT_STATS_CONFIG ?? path.join(projectRoot, 'config/app.local.json'));
  const cacheDirectory = path.resolve(
    options.cacheDirectory
      ?? process.env.GIT_STATS_CACHE_DIRECTORY
      ?? path.join(projectRoot, '.cache/git-stats')
  );
  const publicDirectory = path.resolve(
    options.publicDirectory
      ?? process.env.GIT_STATS_PUBLIC_DIRECTORY
      ?? path.join(projectRoot, 'public')
  );
  const config = options.config ?? await loadConfig(configPath);
  const cacheStore = options.cacheStore ?? createCacheStore(cacheDirectory);
  const scanner = options.scanner ?? scanRepository;
  const synchronizer = options.synchronizer ?? syncRemoteRepository;
  const aggregateRepositories = options.aggregateRepositories ?? await defaultAggregator();
  const refreshJobs = options.refreshJobs ?? createRefreshJobs({
    repositories: config.repositories,
    cacheStore,
    scanner,
    synchronizer,
    scanOptions: options.scanOptions,
  });
  const serveStatic = createStaticFileHandler({ publicDirectory, projectRoot });
  const handler = createRouter({ config, cacheStore, aggregateRepositories, refreshJobs, serveStatic });
  const server = createServer(handler);

  return Object.freeze({
    server,
    handler,
    config,
    cacheStore,
    refreshJobs,
    configPath,
    cacheDirectory,
    publicDirectory,
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
}

export async function startServer(options = {}) {
  const application = await createApplication(options);
  const host = options.host ?? '127.0.0.1';
  const port = parsePort(options.port ?? process.env.PORT ?? 4173);
  await listen(application.server, host, port);
  return application;
}

const isCli = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  startServer()
    .then(({ server }) => {
      const address = server.address();
      process.stdout.write(`Git stats server listening on http://${address.address}:${address.port}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
