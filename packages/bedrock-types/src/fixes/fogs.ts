import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { object, type SchemaNode } from '../schema/normalize.ts';

/** Fog descriptions identify resources by a namespaced string. */
export async function normalizeFogs(source: string): Promise<void> {
  const file = path.join(source, 'schemas/rp/fogs/fog_settings.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const description = object(object(schema.properties)?.description);
  const properties = object(description?.properties);

  if (!properties) {
    throw new Error('Missing upstream fog description');
  }

  properties.identifier = { type: 'string' };
  description!.required = ['identifier'];
  schema.required = ['description'];
  const media = (names: readonly string[], value: SchemaNode): SchemaNode => ({ type: 'object', properties: Object.fromEntries(names.map(name => [name, value])) });
  const vector = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
  const color: SchemaNode = { title: 'FogColor', anyOf: [{ type: 'string' }, vector] };
  const curve = (value: SchemaNode, title: string): SchemaNode => ({ title, anyOf: [value, { type: 'object', additionalProperties: value }] });
  const numberCurve = curve({ type: 'number' }, 'FogNumberCurve');
  const colorCurve = curve(color, 'FogColorCurve');
  const density: SchemaNode = { title: 'FogDensity', type: 'object', properties: {
    max_density: numberCurve,
    max_density_height: numberCurve,
    zero_density_height: numberCurve,
    uniform: { type: 'boolean' },
  } };
  const coefficients: SchemaNode = { title: 'FogMediaCoefficients', type: 'object', properties: { scattering: colorCurve, absorption: colorCurve } };
  const phase: SchemaNode = { title: 'FogPhaseFunction', type: 'object', properties: { henyey_greenstein_g: numberCurve } };

  object(schema.properties)!.volumetric = { title: 'VolumetricFog', type: 'object', properties: {
    density: media(['air', 'water', 'lava', 'lava_resistance', 'weather'], density),
    media_coefficients: media(['air', 'water', 'cloud'], coefficients),
    henyey_greenstein_g: media(['air', 'water', 'cloud'], phase),
  } };
  await writeFile(file, JSON.stringify(schema));
}
