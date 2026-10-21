import { dirname, resolve, sep } from 'node:path';

export function resolveStaticPath(publicDir: string, urlPath: string): string | null {
  const file = resolve(publicDir, urlPath === '/' ? 'index.html' : `.${urlPath}`);
  return dirname(file) === publicDir || file.startsWith(publicDir + sep) ? file : null;
}
