import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { API } from 'typescript-native/sync';
import { createDocumentChecker, declaredCategories, documentCategory, documentLiteral } from '../../../validation/src/document-types.ts';
import { hash } from '../files.ts';
import { readSampleEntries } from '../inputs/metadata.ts';
import { object } from '../schema/normalize.ts';

type Status = 'passed' | 'type-error' | 'syntax-error' | 'uncovered' | 'excluded';

export interface AuditedDocument {
  path: string;
  category?: string;
  compatibility?: 'legacy' | 'vanilla';
  status: Status;
  diagnostics: { code: string | number; message: string }[];
  ignoredProperties?: string[];
  issue?: string;
}

const samplePack = /^(behavior_pack|resource_pack)\//;

function compatibilityCategory(file: string, category: string, document: unknown): string | undefined {
  if (file === 'resource_pack/biomes_client.json') {
    return 'legacy/rp/biomes_client';
  }

  const root = object(document);

  if (category === 'bp/items' && typeof root?.format_version === 'string') {
    const version = /^1\.(\d+)(?:\.(\d+))?$/.exec(root.format_version);
    const components = object(object(root['minecraft:item'])?.components);
    const legacyIcon = typeof object(components?.['minecraft:icon'])?.texture === 'string';
    const modernPatch = legacyIcon ? 60 : 30;

    if (version && (Number(version[1]) < 20 || (Number(version[1]) === 20 && Number(version[2] ?? 0) < modernPatch))) {
      return 'legacy/bp/items';
    }
  }

  if (category === 'bp/entities' && object(root?.['minecraft:entity'])?.events === null) {
    return 'vanilla/bp/entities';
  }

  if (category === 'rp/sounds') {
    return 'vanilla/rp/sounds';
  }
}

function removeInternalProperties(document: unknown, category: string): string[] {
  const ignored: string[] = [];

  if (category === 'bp/blocks') {
    const description = object(object(object(document)?.['minecraft:block'])?.description);

    if (description && Object.hasOwn(description, 'internal_vanilla_data')) {
      delete description.internal_vanilla_data;
      ignored.push('/minecraft:block/description/internal_vanilla_data');
    }
  }

  function visit(value: unknown, pointer: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, pointer + '/' + index));

      return;
    }

    const node = object(value);

    if (!node) {
      return;
    }

    if (Object.hasOwn(node, '__molang_version')) {
      delete node.__molang_version;
      ignored.push(pointer + '/__molang_version');
    }

    for (const [key, item] of Object.entries(node)) {
      visit(item, pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'));
    }
  }

  visit(document, '');

  return ignored;
}

/** Audit the documented fields of vanilla filters with old numeric comparison selectors. */
function normalizeLegacyEntityFilters(document: unknown): boolean {
  let legacy = false;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);

      return;
    }

    const node = object(value);

    if (!node) {
      return;
    }

    if (typeof node.test === 'string') {
      for (const key of ['operator', 'subject']) {
        if (node[key] === 0 || node[key] === 1) {
          delete node[key];
          legacy = true;
        }
      }
    }

    if (node.test === 'is_difficulty' && node.value === 0) {
      node.value = 'peaceful';
      legacy = true;
    }

    if (node.test === 'actor_has_item_with_enchantment_in_slot' && node.domain === 7) {
      delete node.domain;
      legacy = true;
    }

    Object.values(node).forEach(visit);
  }

  visit(document);

  return legacy;
}

export async function auditDocuments(archive: string, distribution: string): Promise<AuditedDocument[]> {
  using api = new API();
  const categories = declaredCategories(api, path.join(distribution, 'documents.d.ts'));
  const files: AuditedDocument[] = [];
  const pending: { result: AuditedDocument; category: string; literal: string }[] = [];
  const digests = new Map<string, string>();

  await readSampleEntries(archive, file => samplePack.test(file) && file.endsWith('.json'), (file, bytes) => {
    const errors: ParseError[] = [];
    const literal = parse(bytes.toString('utf8').replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
    const kind = file.startsWith('behavior_pack/') ? 'behavior' : 'resource';
    const relative = file.slice(file.indexOf('/') + 1);
    const category = documentCategory(kind, relative);
    const compatibility = compatibilityCategory(file, category, literal);
    const excluded = relative === 'manifest.json' || category === 'bp/dialogue' || category === 'bp/functions/tick'
      || /^resource_pack\/(ui|texts|particles|textures\/ui)\//.test(file)
      || (file.startsWith('resource_pack/items/') && literal?.format_version === '1.10.0')
      || path.posix.basename(file) === '__molang_version.json';
    const result: AuditedDocument = {
      path: file,
      category: categories.has(category) ? category : compatibility,
      status: 'passed',
      diagnostics: [],
    };

    if (excluded) {
      result.status = 'excluded';
    } else if (errors.length) {
      result.status = 'syntax-error';
      result.diagnostics = errors.map(error => ({ code: printParseErrorCode(error.error), message: 'At offset ' + error.offset }));
    } else if (result.category) {
      const ignored = removeInternalProperties(literal, result.category);

      if (compatibility) {
        result.compatibility = compatibility.startsWith('legacy/') ? 'legacy' : 'vanilla';
      }

      if (result.category === 'bp/entities' && normalizeLegacyEntityFilters(literal)) {
        result.compatibility ??= 'legacy';
      }

      if (ignored.length) {
        result.ignoredProperties = ignored;
      }

      pending.push({ result, category: compatibility ?? result.category, literal: documentLiteral(literal) });
    } else {
      result.status = 'uncovered';
    }

    files.push(result);
    digests.set(file, hash(bytes));
  });

  if (!pending.length) {
    throw new Error('No supported vanilla documents were found in the release archive');
  }

  const definitions = await readFile(new URL('./compatibility.d.ts', import.meta.url), 'utf8');
  const check = createDocumentChecker(api, distribution, {
    additionalRoots: [path.join(distribution, 'index.d.ts')],
    documentTypes: [
      'import type { DocumentTypes as Published } from \'./documents\';',
      definitions,
      'export type DocumentTypes = Published & CompatibilityDocuments<Published>;',
    ].join('\n'),
  });
  const findings = check(pending);

  for (const [index, { result }] of pending.entries()) {
    if (findings[index].length) {
      result.status = 'type-error';
      result.diagnostics = findings[index].map(({ code, message }) => ({ code, message }));
    }
  }

  for (const file of files) {
    if (file.status !== 'passed' && file.status !== 'excluded') {
      file.issue = hash(JSON.stringify([file.path, digests.get(file.path), file.status, file.diagnostics])).slice(0, 20);
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}
