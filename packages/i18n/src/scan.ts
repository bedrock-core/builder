import fs from 'node:fs';
import path from 'node:path';

const SOURCE_RE = /\.(?:ts|tsx|js|jsx|mjs)$/;

/** One source file read off disk, as the scans below consume it. */
export interface Source {
  path: string;
  text: string;
}

/**
 * Recursively read source files under `dir` (skipping node_modules and
 * declaration files). Missing dir → empty list.
 */
export function walkSources(dir: string): Source[] {
  const out: Source[] = [];

  if (!fs.existsSync(dir)) {
    return out;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue;
      }

      out.push(...walkSources(abs));
      continue;
    }

    if (!SOURCE_RE.test(entry.name) || entry.name.endsWith('.d.ts')) {
      continue;
    }

    out.push({ path: abs, text: fs.readFileSync(abs, 'utf-8') });
  }

  return out;
}

const STRING_LITERAL_RE = /(['"`])([^'"`\n]{1,200})\1/g;
const CHAIN_RE = /\bvanilla((?:\s*\.\s*[A-Za-z0-9_$]+)+)/g;

/**
 * Vanilla keys the sources reference. A key assembled at runtime is not a
 * literal and will not be found — the client still resolves it, but `t()`
 * falls back to the raw key and measurement for that string is approximate.
 */
export function scanVanillaUsage(sources: Source[], vanillaKeys: Set<string>): Set<string> {
  const used = new Set<string>();

  for (const { text } of sources) {
    for (const m of text.matchAll(STRING_LITERAL_RE)) {
      const raw = m[2];
      const candidate = raw.startsWith('vanilla.') ? raw.slice('vanilla.'.length) : raw;

      if (vanillaKeys.has(candidate)) {
        used.add(candidate);
      }
    }

    for (const m of text.matchAll(CHAIN_RE)) {
      const key = m[1].replaceAll(/\s/g, '').split('.').filter(Boolean).join('.');

      if (vanillaKeys.has(key)) {
        used.add(key);
      }
    }
  }

  return used;
}
