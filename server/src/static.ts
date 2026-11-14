// 웹 빌드(web/dist) 정적 서빙 + SPA 폴백.
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Handler } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 파일이 있으면 그 파일을, 없으면 index.html을 준다. 폴더 밖 경로는 index.html로 떨어진다. */
export function staticHandler(rootDir: string): Handler {
  const root = resolve(rootDir);
  const indexFile = resolve(root, 'index.html');

  return async (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(c.req.path);
    } catch {
      pathname = '/';
    }
    let file = resolve(root, `.${pathname}`);
    const inside = file.startsWith(root + sep) && !pathname.includes('\0');
    if (!inside || !(await isFile(file))) file = indexFile;
    if (!(await isFile(file))) return c.notFound();

    const isIndex = file === indexFile;
    const body = await readFile(file);
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // 해시가 붙은 빌드 산출물은 오래 캐시, index.html은 항상 새로.
      'Cache-Control': isIndex ? 'no-cache' : pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    });
  };
}
