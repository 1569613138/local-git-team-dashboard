function decode(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function parseRecord(fields, inDefault) {
  const [oid, authorName, authorEmail, authoredAt, parents = ''] = fields;
  if (!/^[0-9a-f]{40,64}$/i.test(oid ?? '')) {
    throw new Error(`Invalid commit OID in git log: ${JSON.stringify(oid)}`);
  }
  if (!authoredAt || Number.isNaN(Date.parse(authoredAt))) {
    throw new Error(`Invalid author date for commit ${oid}: ${JSON.stringify(authoredAt)}`);
  }

  return {
    oid,
    authorName,
    authorEmail,
    authoredAt,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    inDefault: inDefault.has(oid),
  };
}

export function parseLog(output, defaultOids = new Set()) {
  const inDefault = defaultOids instanceof Set ? defaultOids : new Set(defaultOids);
  const text = decode(output);
  if (text.includes('\x1e')) {
    const commits = [];
    for (const rawRecord of text.split('\x1e')) {
      const record = rawRecord.replace(/^\0+/u, '').replace(/\n$/u, '');
      if (!record) continue;
      const fields = record.split('\0');
      while (fields.at(-1) === '') fields.pop();
      if (fields.length === 4) fields.push('');
      if (fields.length !== 5) {
        throw new Error(`Malformed NUL-delimited git log: expected groups of 5 fields, got ${fields.length}`);
      }
      commits.push(parseRecord(fields, inDefault));
    }
    return commits;
  }

  const fields = text.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 5 !== 0) {
    throw new Error(`Malformed NUL-delimited git log: expected groups of 5 fields, got ${fields.length}`);
  }
  const commits = [];
  for (let index = 0; index < fields.length; index += 5) {
    commits.push(parseRecord(fields.slice(index, index + 5), inDefault));
  }
  return commits;
}

export default parseLog;
