import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { object, type SchemaNode } from '../schema/normalize.ts';

/** Retain legacy lighting layouts and type modern orbital lights and RGB keyframes. */
export async function normalizeLighting(source: string): Promise<void> {
  const directory = path.join(source, 'schemas/rp/deferred_rendering');
  const file = path.join(directory, 'lighting.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8')) as SchemaNode;
  const settingsFile = path.join(directory, 'minecraft_lighting_settings.schema.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as SchemaNode;
  const properties = object(settings.properties);
  const directionalFile = path.join(directory, 'directional_lights.schema.json');
  const directional = JSON.parse(await readFile(directionalFile, 'utf8')) as SchemaNode;
  const lights = object(directional.properties);

  if (!properties || !lights) {
    throw new Error('Missing upstream directional lighting schema');
  }

  const color: SchemaNode = {
    title: 'LightingColor',
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }],
  };
  const keyframes = (value: SchemaNode, title: string): SchemaNode => ({ title, anyOf: [value, { type: 'object', additionalProperties: value }] });
  const colorCurve = keyframes(color, 'LightingColorCurve');
  const numberCurve = keyframes({ type: 'number' }, 'LightingNumberCurve');
  const light: SchemaNode = { title: 'DirectionalLight', type: 'object', properties: { illuminance: numberCurve, color: colorCurve } };

  Object.assign(lights, {
    sun: light,
    moon: light,
    orbital_offset_degrees: numberCurve,
    orbital: { title: 'OrbitalLights', type: 'object', properties: { sun: light, moon: light, orbital_offset_degrees: numberCurve } },
    flash: { title: 'FlashLight', type: 'object', properties: { illuminance: { type: 'number' }, color } },
  });
  properties.ambient = { type: 'object', properties: { color: colorCurve, illuminance: numberCurve } };
  properties.sky = { type: 'object', properties: { intensity: numberCurve } };
  schema.required = ['format_version', 'minecraft:lighting_settings'];
  await writeFile(file, JSON.stringify(schema));
  await writeFile(settingsFile, JSON.stringify(settings));
  await writeFile(directionalFile, JSON.stringify(directional));
}
