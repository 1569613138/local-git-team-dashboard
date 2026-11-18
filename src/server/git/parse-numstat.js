function decode(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function parseCount(value, label) {
  if (value === '-') return null;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label} count in numstat: ${JSON.stringify(value)}`);
  return Number(value);
}

function consumeRenamePaths(tokens, index, pathToken) {
  if (pathToken === '') {
    if (index + 1 >= tokens.length) throw new Error('Malformed rename record in numstat');
    return {
      oldPath: tokens[index],
      path: tokens[index + 1],
      nextIndex: index + 2,
    };
  }
  return { path: pathToken, nextIndex: index };
}

function parseCommitMarker(token) {
  const normalized = token.replace(/^\n+/u, '');
  if (normalized.startsWith('commit\t')) return normalized.slice(7);
  if (normalized.startsWith('\x1e')) return normalized.slice(1).replace(/\0+$/u, '');
  return null;
}

export function parseNumstat(output) {
  const tokens = decode(output).split('\0');
  while (tokens.at(-1) === '') tokens.pop();

  const commits = [];
  let current;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index++].replace(/^\n+/u, '');
    const oid = parseCommitMarker(token);
    if (!token) continue;
    if (oid !== null) {
      if (!/^[0-9a-f]{40,64}$/i.test(oid)) {
        throw new Error(`Invalid commit marker in numstat: ${JSON.stringify(token)}`);
      }
      current = { oid, files: [] };
      commits.push(current);
      continue;
    }

    if (!current) throw new Error('Numstat file record appeared before a commit marker');

    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new Error(`Malformed numstat record: ${JSON.stringify(token)}`);
    }

    const added = parseCount(token.slice(0, firstTab), 'added');
    const deleted = parseCount(token.slice(firstTab + 1, secondTab), 'deleted');
    const pathToken = token.slice(secondTab + 1);
    const paths = consumeRenamePaths(tokens, index, pathToken);
    index = paths.nextIndex;

    current.files.push({
      path: paths.path,
      ...(paths.oldPath === undefined ? {} : { oldPath: paths.oldPath }),
      added,
      deleted,
      binary: added === null || deleted === null,
    });
  }

  return commits;
}

export default parseNumstat;
