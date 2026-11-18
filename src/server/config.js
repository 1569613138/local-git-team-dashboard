import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createIdentityRegistry } from './domain/identity.js';
import { compilePathFilter } from './domain/path-filter.js';

const TOP_LEVEL_KEYS = new Set(['repositories', 'members', 'pathFilter']);
const REPOSITORY_KEYS = new Set(['id', 'name', 'path', 'remoteUrl', 'defaultBranch', 'branches', 'enabled']);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not allowed`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeRemoteUrl(value, label) {
  if (value === undefined) return null;
  const remoteUrl = nonEmptyString(value, label);
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new TypeError(`${label} must be an http(s) URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError(`${label} must not contain credentials`);
  }
  parsed.hash = '';
  return parsed.href;
}

function normalizeBranches(value, label) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const branches = value.map((branch, index) => nonEmptyString(branch, `${label}[${index}]`));
  if (new Set(branches).size !== branches.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(branches);
}

function normalizeRepository(repository, index) {
  const label = `repositories[${index}]`;
  assertPlainObject(repository, label);
  assertExactKeys(repository, REPOSITORY_KEYS, label);
  const id = nonEmptyString(repository.id, `${label}.id`);
  const name = repository.name === undefined ? id : nonEmptyString(repository.name, `${label}.name`);
  const path = nonEmptyString(repository.path, `${label}.path`);
  if (!isAbsolute(path)) throw new TypeError(`${label}.path must be absolute`);
  const remoteUrl = normalizeRemoteUrl(repository.remoteUrl, `${label}.remoteUrl`);
  if (repository.enabled !== undefined && typeof repository.enabled !== 'boolean') {
    throw new TypeError(`${label}.enabled must be a boolean`);
  }
  return Object.freeze({
    id,
    name,
    path,
    remoteUrl,
    defaultBranch: repository.defaultBranch === undefined
      ? null
      : nonEmptyString(repository.defaultBranch, `${label}.defaultBranch`),
    branches: normalizeBranches(repository.branches, `${label}.branches`),
    enabled: repository.enabled ?? true,
  });
}

export function validateConfig(value) {
  assertPlainObject(value, 'config');
  assertExactKeys(value, TOP_LEVEL_KEYS, 'config');
  if (!Array.isArray(value.repositories)) throw new TypeError('config.repositories must be an array');
  if (!Array.isArray(value.members)) throw new TypeError('config.members must be an array');

  const repositories = value.repositories.map(normalizeRepository);
  const ids = new Set();
  for (const repository of repositories) {
    if (ids.has(repository.id)) throw new TypeError(`repository id ${JSON.stringify(repository.id)} is duplicated`);
    ids.add(repository.id);
  }

  const identityRegistry = createIdentityRegistry(value.members);
  const pathFilter = compilePathFilter(value.pathFilter ?? {});
  return Object.freeze({
    repositories: Object.freeze(repositories),
    members: identityRegistry.members,
    pathFilter: Object.freeze({
      directories: pathFilter.directories,
      suffixes: pathFilter.suffixes,
      files: pathFilter.files,
    }),
  });
}

export function parseConfigJson(source, sourceName = 'config') {
  if (typeof source !== 'string') throw new TypeError('config JSON source must be a string');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SyntaxError(`Invalid JSON in ${sourceName}: ${error.message}`, { cause: error });
  }
  try {
    return validateConfig(parsed);
  } catch (error) {
    error.message = `Invalid config in ${sourceName}: ${error.message}`;
    throw error;
  }
}

export async function loadConfig(filePath) {
  const path = nonEmptyString(filePath, 'config file path');
  const resolvedPath = await realpath(path);
  const source = await readFile(resolvedPath, 'utf8');
  return parseConfigJson(source, resolvedPath);
}

export default loadConfig;
