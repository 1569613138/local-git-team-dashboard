function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function normalizePath(value, label = 'path') {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError(`${label} must be a string without NUL characters`);
  }

  if (value === '/') return '/';
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/\/{2,}/gu, '/')
    .replace(/^\//u, '')
    .replace(/\/$/u, '');
}

function normalizeRules(values, label, transform = (value) => value) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }

  const result = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== 'string' || values[index] === '' || values[index].includes('\0')) {
      throw new TypeError(`${label}[${index}] must be a non-empty string without NUL characters`);
    }
    const rule = transform(values[index]);
    if (!seen.has(rule)) {
      seen.add(rule);
      result.push(rule);
    }
  }
  return result;
}

function directoryMatches(path, directory) {
  if (directory === '/') return path === '/';
  if (path === '/') return false;

  if (directory.includes('/')) {
    return path === directory
      || path.startsWith(`${directory}/`)
      || path.includes(`/${directory}/`)
      || path.endsWith(`/${directory}`);
  }
  return path.split('/').includes(directory);
}

function exactFileMatches(path, file) {
  if (file === '/') return path === '/';
  if (file.includes('/')) return path === file;
  const separator = path.lastIndexOf('/');
  return path.slice(separator + 1) === file;
}

export function compilePathFilter(rules = {}) {
  assertPlainObject(rules, 'path filter rules');
  const allowed = new Set(['directories', 'suffixes', 'files']);
  for (const key of Object.keys(rules)) {
    if (!allowed.has(key)) {
      throw new TypeError(`path filter rules.${key} is not allowed`);
    }
  }

  const directories = normalizeRules(
    rules.directories,
    'path filter rules.directories',
    (value) => normalizePath(value).replace(/^\/+|\/+$/gu, '') || '/',
  );
  const suffixes = normalizeRules(rules.suffixes, 'path filter rules.suffixes');
  const files = normalizeRules(rules.files, 'path filter rules.files', normalizePath);

  function excludes(candidate) {
    const path = normalizePath(candidate);
    return directories.some((directory) => directoryMatches(path, directory))
      || suffixes.some((suffix) => path.endsWith(suffix))
      || files.some((file) => exactFileMatches(path, file));
  }

  return Object.freeze({
    directories: Object.freeze(directories),
    suffixes: Object.freeze(suffixes),
    files: Object.freeze(files),
    excludes,
    includes(candidate) {
      return !excludes(candidate);
    },
  });
}

export function createPathFilter(rules) {
  return compilePathFilter(rules).excludes;
}

export function shouldExcludePath(path, rulesOrFilter) {
  if (typeof rulesOrFilter === 'function') return rulesOrFilter(path);
  if (rulesOrFilter && typeof rulesOrFilter.excludes === 'function') {
    return rulesOrFilter.excludes(path);
  }
  return compilePathFilter(rulesOrFilter).excludes(path);
}

export { normalizePath };
