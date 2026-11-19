import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validatedConfigSchema, type Config } from './schema.js';

const PREFIX = 'GJB_';

export type EnvName = 'CONFIG' | 'DRY_RUN' | 'HOST' | 'PORT';

export function readEnv(name: EnvName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`${PREFIX}${name}`];
}

export function readEnvFlag(name: EnvName, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = readEnv(name, env);
  return value === '1' || value === 'true';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces ${VAR} and ${VAR:-default} in every string of a parsed YAML tree, so
 * secrets can live in the environment (a compose `.env`, a k8s Secret) rather
 * than in config.yaml. Interpolating after parsing means a secret containing YAML
 * metacharacters cannot corrupt the document structure.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (match, name: string, fallback: string | undefined) => {
      const found = env[name];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(
        `${path.join('.') || '<root>'}: environment variable ${name} referenced as ${match} is not set`,
      );
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnv(item, env, [...path, String(i)]));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env, [...path, k])]),
    );
  }
  return value;
}

export function parseConfig(raw: string, file: string, env: NodeJS.ProcessEnv = process.env): Config {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) throw new ConfigError(`${file} is empty`);

  const result = validatedConfigSchema.safeParse(interpolateEnv(doc, env));
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new ConfigError(`${file} is not valid:\n${lines.join('\n')}`);
  }
  const config = result.data;

  // Deployment overrides on top of the file: the container binds 0.0.0.0 while a
  // laptop run keeps the safe 127.0.0.1 default from config.yaml.
  if (readEnvFlag('DRY_RUN', env)) config.behaviours.dry_run = true;
  const host = readEnv('HOST', env);
  if (host) config.server.host = host;
  const port = readEnv('PORT', env);
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new ConfigError(`GJB_PORT=${port} is not a valid port`);
    config.server.port = n;
  }
  return config;
}

/**
 * Load config.yaml, validate it, then apply env overrides. GJB_CONFIG points at the
 * file; GJB_DRY_RUN=1 forces dry_run; GJB_HOST / GJB_PORT override the listener.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = resolve(readEnv('CONFIG', env) ?? 'config.yaml');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `config file not found at ${path}\nCopy config.example.yaml to config.yaml, or point GJB_CONFIG at your file.`,
      );
    }
    throw new ConfigError(`could not read ${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw, path, env);
}
