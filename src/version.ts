/**
 * The running version, read from package.json at startup. The file sits one
 * level above both src/ (tests, tsx) and dist/ (built), and the Dockerfile
 * copies it into the image for that reason.
 */
import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();
