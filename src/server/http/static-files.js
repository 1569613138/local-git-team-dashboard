import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);
const COMPATIBLE_MODULES = new Set(['api.js', 'state.js', 'charts.js', 'render.js', 'format.js']);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

async function regularFile(candidate, root) {
  if (!inside(root, candidate)) return null;
  try {
    const info = await stat(candidate);
    return info.isFile() ? { candidate, info } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function createStaticFileHandler({ publicDirectory, projectRoot = path.dirname(publicDirectory) }) {
  const publicRoot = path.resolve(publicDirectory);
  const compatibleRoot = path.resolve(projectRoot);

  async function locate(pathname) {
    const decoded = decodePathname(pathname);
    if (decoded === null || decoded.includes('\0') || decoded.includes('\\')) return null;
    if (decoded === '/' || decoded === '/index.html') {
      return regularFile(path.join(publicRoot, 'index.html'), publicRoot);
    }

    const relative = decoded.replace(/^\/+/, '');
    if (!relative || relative.split('/').includes('..')) return null;
    const fromPublic = await regularFile(path.resolve(publicRoot, relative), publicRoot);
    if (fromPublic) return fromPublic;

    if (COMPATIBLE_MODULES.has(relative)) {
      return regularFile(path.join(compatibleRoot, relative), compatibleRoot);
    }
    if (relative.startsWith('js/')) {
      const moduleName = relative.slice(3);
      if (COMPATIBLE_MODULES.has(moduleName)) {
        return regularFile(path.join(compatibleRoot, moduleName), compatibleRoot);
      }
    }
    return null;
  }

  return async function serveStatic(request, response, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const file = await locate(url.pathname);
    if (!file) return false;

    response.statusCode = 200;
    response.setHeader('Content-Type', MIME_TYPES.get(path.extname(file.candidate).toLowerCase()) || 'application/octet-stream');
    response.setHeader('Content-Length', file.info.size);
    response.setHeader('Last-Modified', file.info.mtime.toUTCString());
    response.setHeader('Cache-Control', 'no-cache');
    if (request.method === 'HEAD') {
      response.end();
    } else {
      await pipeline(createReadStream(file.candidate), response);
    }
    return true;
  };
}

export default createStaticFileHandler;
