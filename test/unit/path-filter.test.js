import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compilePathFilter,
  createPathFilter,
  normalizePath,
  shouldExcludePath,
} from '../../src/server/domain/path-filter.js';

const rules = {
  directories: ['node_modules', 'dist/assets', '.generated[old]'],
  suffixes: ['.min.js', '.snap'],
  files: ['package-lock.json', 'config/exact.lock', 'special/[literal].lock'],
};

test('目录规则匹配任意层级目录和指定子路径', () => {
  const filter = compilePathFilter(rules);
  assert.equal(filter.excludes('node_modules/a.js'), true);
  assert.equal(filter.excludes('src/node_modules/a.js'), true);
  assert.equal(filter.excludes('dist/assets/app.js'), true);
  assert.equal(filter.excludes('nested/dist/assets/app.js'), true);
  assert.equal(filter.excludes('src/.generated[old]/a.js'), true);
  assert.equal(filter.excludes('node_modules.txt/a.js'), false);
});

test('后缀规则和精确 lockfile 规则不使用正则解释特殊字符', () => {
  const excludes = createPathFilter(rules);
  assert.equal(excludes('src/app.min.js'), true);
  assert.equal(excludes('test/view.snap'), true);
  assert.equal(excludes('nested/package-lock.json'), true);
  assert.equal(excludes('config/exact.lock'), true);
  assert.equal(excludes('other/config/exact.lock'), false);
  assert.equal(excludes('special/[literal].lock'), true);
  assert.equal(excludes('special/x.lock'), false);
  assert.equal(excludes('package-lock.json.backup'), false);
});

test('支持斜杠根路径、反斜杠和特殊路径', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('./src\\node_modules\\x.js'), 'src/node_modules/x.js');
  assert.equal(shouldExcludePath('/', { files: ['/'] }), true);
  assert.equal(shouldExcludePath('src/[abc](1)+.js', { files: ['src/[abc](1)+.js'] }), true);
  assert.equal(shouldExcludePath('src/[abc](1)+.js', { files: ['[abc](1)+.js'] }), true);
});

test('路径规则执行严格校验', () => {
  assert.throws(() => compilePathFilter({ unknown: [] }), /unknown is not allowed/u);
  assert.throws(() => compilePathFilter({ suffixes: '.js' }), /suffixes must be an array/u);
  assert.throws(() => compilePathFilter({ files: [''] }), /non-empty string/u);
  assert.throws(() => normalizePath('bad\0path'), /without NUL/u);
});
