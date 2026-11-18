import { createHash } from 'node:crypto';

const MEMBER_KEYS = new Set(['id', 'displayName', 'names', 'emails', 'internal']);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label}.${key} is not allowed`);
    }
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeText(value) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export function normalizeName(name) {
  return typeof name === 'string' ? normalizeText(name) : '';
}

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLocaleLowerCase('en-US') : '';
}

function normalizeAliasList(values, label, normalize) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }

  const aliases = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const raw = assertNonEmptyString(values[index], `${label}[${index}]`);
    const normalized = normalize(raw);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      aliases.push(normalized);
    }
  }
  return aliases;
}

function normalizeMember(member, index) {
  const label = `members[${index}]`;
  assertPlainObject(member, label);
  assertExactKeys(member, MEMBER_KEYS, label);

  const id = assertNonEmptyString(member.id, `${label}.id`);
  const displayName = assertNonEmptyString(member.displayName, `${label}.displayName`);
  const names = normalizeAliasList(member.names, `${label}.names`, normalizeName);
  const emails = normalizeAliasList(member.emails, `${label}.emails`, normalizeEmail);
  if (typeof member.internal !== 'boolean') {
    throw new TypeError(`${label}.internal must be a boolean`);
  }
  if (names.length === 0 && emails.length === 0) {
    throw new TypeError(`${label} must contain at least one name or email`);
  }

  return Object.freeze({ id, displayName, names, emails, internal: member.internal });
}

function addAliases(target, aliases, member, kind) {
  for (const alias of aliases) {
    const existing = target.get(alias);
    if (existing && existing.id !== member.id) {
      throw new TypeError(`${kind} alias ${JSON.stringify(alias)} is shared by members ${JSON.stringify(existing.id)} and ${JSON.stringify(member.id)}`);
    }
    target.set(alias, member);
  }
}

function publicMember(member, matchedBy) {
  return Object.freeze({
    id: member.id,
    displayName: member.displayName,
    internal: member.internal,
    matched: true,
    matchedBy,
  });
}

function unmappedIdentity(name, email) {
  const normalizedName = normalizeName(name);
  const normalizedEmail = normalizeEmail(email);
  const key = normalizedEmail ? `email:${normalizedEmail}` : `name:${normalizedName || 'unknown'}`;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);

  return Object.freeze({
    id: `unmapped:${digest}`,
    displayName: `Unmapped ${digest.slice(0, 8)}`,
    internal: false,
    matched: false,
    matchedBy: null,
  });
}

export function createIdentityRegistry(members) {
  if (!Array.isArray(members)) {
    throw new TypeError('members must be an array');
  }

  const byId = new Map();
  const byEmail = new Map();
  const byName = new Map();
  const normalizedMembers = members.map(normalizeMember);

  for (const member of normalizedMembers) {
    if (byId.has(member.id)) {
      throw new TypeError(`member id ${JSON.stringify(member.id)} is duplicated`);
    }
    byId.set(member.id, member);
    addAliases(byEmail, member.emails, member, 'email');
    addAliases(byName, member.names, member, 'name');
  }

  function resolve(authorOrName, possibleEmail) {
    const author = typeof authorOrName === 'object' && authorOrName !== null
      ? authorOrName
      : { name: authorOrName, email: possibleEmail };
    const email = normalizeEmail(author.email);
    const name = normalizeName(author.name);

    if (email && byEmail.has(email)) {
      return publicMember(byEmail.get(email), 'email');
    }
    if (name && byName.has(name)) {
      return publicMember(byName.get(name), 'name');
    }
    return unmappedIdentity(author.name, author.email);
  }

  return Object.freeze({
    members: Object.freeze(normalizedMembers),
    resolve,
    getById(id) {
      return byId.get(id) ?? null;
    },
  });
}

export function validateMembers(members) {
  return createIdentityRegistry(members).members;
}

export function createIdentityResolver(members) {
  return createIdentityRegistry(members).resolve;
}

export function resolveIdentity(author, membersOrRegistry) {
  const registry = Array.isArray(membersOrRegistry)
    ? createIdentityRegistry(membersOrRegistry)
    : membersOrRegistry;
  if (!registry || typeof registry.resolve !== 'function') {
    throw new TypeError('membersOrRegistry must be a member array or identity registry');
  }
  return registry.resolve(author);
}
