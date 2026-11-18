import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { object, type SchemaNode } from '../schema/normalize.ts';

const string = { type: 'string' };

/** Give the modern scatter feature the same placement parameters as a feature rule. */
export async function normalizeScatterFeature(source: string): Promise<void> {
  const file = path.join(source, 'schemas/bp/features/scatter_feature.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const fields = object(schema.properties);
  const description = object(fields?.description);

  if (!fields || !description) {
    throw new Error('Missing SDK scatter feature properties');
  }

  description.required = ['identifier'];
  fields.places_feature = { ...string, description: 'Feature to place at each scattered position.' };
  fields.distribution = { description: object(fields.distribution)?.description, tsType: 'ScatterDistribution' };
  schema.required = [...new Set([...(Array.isArray(schema.required) ? schema.required : []), 'description', 'places_feature', 'distribution'])];
  await writeFile(file, JSON.stringify(schema));
}

/** Add the document wrapper and the placement conditions to the SDK rule definition. */
export async function normalizeFeatureRules(source: string): Promise<void> {
  const file = path.join(source, 'schemas/bp/feature_rules/index.schema.json');
  const rule = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const fields = object(rule.properties);

  if (!fields) {
    throw new Error('Missing SDK feature rule properties');
  }

  fields.description = {
    type: 'object',
    properties: { identifier: string, places_feature: string },
    required: ['identifier', 'places_feature'],
  };
  fields.conditions = {
    type: 'object',
    properties: {
      'placement_pass': { tsType: 'FeaturePlacementPass' },
      'minecraft:biome_filter': { tsType: 'FilterGroup' },
    },
    required: ['placement_pass'],
  };
  fields.distribution = { description: object(fields.distribution)?.description, tsType: 'ScatterDistribution' };
  delete rule.$id;
  rule.required = ['description', 'conditions'];
  await writeFile(file, JSON.stringify({
    type: 'object',
    properties: { 'format_version': string, 'minecraft:feature_rules': rule },
    required: ['format_version', 'minecraft:feature_rules'],
  }));
}

export const featureDocumentType = `
type FeatureRoot = Exclude<keyof FeatureProperties, 'format_version'>;

/** A world generation document contains exactly one feature definition. */
export type FeatureDocument = Pick<FeatureProperties, 'format_version'> & {
  [Root in FeatureRoot]: Required<Pick<FeatureProperties, Root>> & Partial<Record<Exclude<FeatureRoot, Root>, never>>;
}[FeatureRoot];
`;
