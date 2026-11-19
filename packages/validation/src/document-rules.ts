type Report = (pointer: string, message: string) => void;

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function segment(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

// https://github.com/Blockception/Minecraft-bedrock-json-schemas/pull/647
const baseBlockComponents = [
  'minecraft:block_entity',
  'minecraft:embedded_visual',
  'minecraft:flower_pottable',
  'minecraft:item_visual',
  'minecraft:redstone_consumer',
  'minecraft:support',
];

function beforeFormat(formatVersion: unknown, minor: number, patch: number): boolean {
  const version = typeof formatVersion === 'string' ? /^1\.(\d+)(?:\.(\d+))?$/.exec(formatVersion) : null;

  return version !== null && (Number(version[1]) < minor || (Number(version[1]) === minor && Number(version[2] ?? 0) < patch));
}

function checkStates(definition: JsonObject, report: Report): void {
  const states = record(record(definition.description)?.states);

  // Array length and shape are checked by BlockStates. JSON also needs integer and uniqueness checks.
  // https://github.com/Blockception/Minecraft-bedrock-json-schemas/tree/main/source/behavior/blocks/format/states
  for (const [name, values] of Object.entries(states ?? {})) {
    const pointer = '/minecraft:block/description/states/' + segment(name);

    if (Array.isArray(values)) {
      if (new Set(values).size < values.length) {
        report(pointer, 'Block state values must be unique.');
      }

      for (const [index, value] of values.entries()) {
        if (typeof value === 'number' && !Number.isInteger(value)) {
          report(pointer + '/' + index, 'Numeric block state values must be integers.');
        }
      }
    } else {
      const bounds = record(record(values)?.values);
      const min = bounds?.min;
      const max = bounds?.max;

      if (typeof min === 'number' && typeof max === 'number'
        && (!Number.isInteger(min) || !Number.isInteger(max) || max < min || max - min > 15)) {
        report(pointer + '/values', 'A block state range must contain 1 through 16 consecutive integers.');
      }
    }
  }
}

function checkMaterials(materials: unknown, pointer: string, legacy: boolean, report: Report): void {
  // https://learn.microsoft.com/minecraft/creator/reference/content/blockreference/examples/blockcomponents/minecraftblock_material_instances
  for (const [face, value] of Object.entries(record(materials) ?? {})) {
    const material = record(value);
    const occlusion = material?.ambient_occlusion;

    if (material && typeof occlusion === 'boolean') {
      if (!legacy) {
        report(pointer + '/' + segment(face) + '/ambient_occlusion', 'Ambient occlusion requires a numeric value from format_version 1.26.20.');
      }

      material.ambient_occlusion = Number(occlusion);
    } else if (!legacy && typeof occlusion === 'number' && (occlusion < 0 || occlusion > 10)) {
      report(pointer + '/' + segment(face) + '/ambient_occlusion', 'Ambient occlusion must be between 0 and 10.');
    }
  }
}

function checkBlockComponents(components: JsonObject, pointer: string, legacy: boolean, permutation: boolean, report: Report): void {
  const redstone = record(components['minecraft:redstone_consumer']);
  const power = redstone?.min_power;

  // https://learn.microsoft.com/minecraft/creator/reference/content/blockreference/examples/blockcomponents/minecraftblock_redstone_consumer
  if (typeof power === 'number' && (!Number.isInteger(power) || power < 0 || power > 15)) {
    report(pointer + '/minecraft:redstone_consumer/min_power', 'Minimum redstone power must be an integer from 0 through 15.');
  }

  const directions = record(components['minecraft:neighbor_change'])?.neighbor_directions;

  // https://feedback.minecraft.net/hc/en-us/articles/49274834093453-Minecraft-Beta-Preview-26-60-29
  if (Array.isArray(directions)) {
    const directionPointer = pointer + '/minecraft:neighbor_change/neighbor_directions';

    if (directions.length < 1 || directions.length > 6) {
      report(directionPointer, 'Choose between one and six neighbor directions.');
    } else if (directions.includes('all') && directions.some(direction => direction !== 'all')) {
      report(directionPointer, 'The all neighbor direction cannot be combined with specific faces.');
    }
  }

  checkMaterials(components['minecraft:material_instances'], pointer + '/minecraft:material_instances', legacy, report);

  for (const key of ['minecraft:embedded_visual', 'minecraft:item_visual']) {
    checkMaterials(record(components[key])?.material_instances, pointer + '/' + key + '/material_instances', legacy, report);
  }

  if (permutation) {
    for (const key of baseBlockComponents) {
      // https://learn.microsoft.com/minecraft/creator/documents/update1.26.20
      if (Object.hasOwn(components, key) && !(legacy && key === 'minecraft:flower_pottable')) {
        report(pointer + '/' + key, key + ' belongs in the base block components.');
      }
    }
  }
}

function checkParameterDepth(value: unknown, pointer: string, depth: number, report: Report): void {
  const array = Array.isArray(value);
  const container = array ? value : record(value);

  if (!container) {
    return;
  }

  // At the final level, an array of scalar values is still valid.
  // https://github.com/Blockception/Minecraft-bedrock-json-schemas/pull/642
  if (depth >= (array ? 3 : 2)) {
    report(pointer, 'Custom component parameters exceed the object and array depth limit.');

    return;
  }

  for (const [key, child] of Object.entries(container)) {
    checkParameterDepth(child, pointer + '/' + segment(key), depth + 1, report);
  }
}

function prepareCustomComponents(components: JsonObject, pointer: string, report: Report, item = false): void {
  // Native fields are checked with the declarations. Custom V2 keys refer to script registrations.
  // https://learn.microsoft.com/minecraft/creator/documents/scripting/custom-components
  for (const [key, value] of Object.entries(components)) {
    if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(key) && !key.startsWith('minecraft:')) {
      const componentPointer = pointer + '/' + segment(key);

      if (item && value === null) {
        report(componentPointer, 'A custom item component requires a parameter value. Use an empty object for a component without parameters.');
      } else {
        checkParameterDepth(value, componentPointer, 0, report);
      }

      delete components[key];
    }
  }
}

function checkDimension(document: unknown, report: Report): void {
  const root = record(document);
  const dimension = record(root?.['minecraft:dimension']);
  const components = record(dimension?.components);

  if (!components) {
    return;
  }

  // https://learn.microsoft.com/minecraft/creator/documents/scripting/custom-dimension-api-tutorial
  const pointer = '/minecraft:dimension/components';
  const identifier = record(dimension?.description)?.identifier;
  const bounds = record(components['minecraft:dimension_bounds']);

  if (beforeFormat(root?.format_version, 26, 50) && !Object.hasOwn(components, 'minecraft:dimension_height')
    && bounds && typeof bounds.min === 'number' && typeof bounds.max === 'number') {
    components['minecraft:dimension_height'] = { min_y: bounds.min, height_range: bounds.max - bounds.min };
    delete components['minecraft:dimension_bounds'];
  }

  if (typeof identifier === 'string' && !identifier.startsWith('minecraft:') && !Object.hasOwn(components, 'minecraft:generation')) {
    report(pointer + '/minecraft:generation', 'A custom dimension requires the generation component.');
  }

  const height = record(components['minecraft:dimension_height']);
  const min = height?.min_y;
  const range = height?.height_range;

  if (typeof min === 'number' && typeof range === 'number'
    && (min % 16 !== 0 || range % 16 !== 0 || min < -512 || range < 16 || range > 1024 || min + range > 512)) {
    report(pointer + '/minecraft:dimension_height', 'Dimension bounds must use multiples of 16, span 16 through 1024 blocks, and stay between -512 and 512.');
  }

  const clouds = record(components['minecraft:clouds'])?.height;

  if (typeof clouds === 'number' && (!Number.isInteger(clouds) || clouds < -512 || clouds > 512)) {
    report(pointer + '/minecraft:clouds/height', 'Cloud height must be an integer between -512 and 512.');
  }
}

/** Camera presets share their directory with separate aim assist documents. */
export function matchesDocumentType(category: string, document: unknown): boolean {
  if (category !== 'bp/cameras/presets') {
    return true;
  }

  const root = record(document);

  return !root || Object.hasOwn(root, 'minecraft:camera_preset')
    || (!Object.hasOwn(root, 'minecraft:aim_assist_preset') && !Object.hasOwn(root, 'minecraft:aim_assist_categories'));
}

/** Prepare the in-memory JSON literal for native type checking and apply content rules. */
export function prepareCheckedDocument(category: string, document: unknown, report: Report): void {
  if (category === 'bp/dimensions') {
    checkDimension(document, report);

    return;
  }

  if (category !== 'bp/blocks' && category !== 'bp/items') {
    return;
  }

  const root = record(document);
  const block = category === 'bp/blocks';
  const key = block ? 'minecraft:block' : 'minecraft:item';
  const definition = record(root?.[key]);

  if (!definition) {
    return;
  }

  const legacy = beforeFormat(root?.format_version, 26, 20);
  const components = record(definition.components);

  if (components) {
    if (block) {
      checkBlockComponents(components, '/' + key + '/components', legacy, false, report);
    }

    prepareCustomComponents(components, '/' + key + '/components', report, !block);
  }

  if (block) {
    checkStates(definition, report);

    if (Array.isArray(definition.permutations)) {
      for (const [index, value] of definition.permutations.entries()) {
        const overrides = record(record(value)?.components);

        if (overrides) {
          const pointer = '/' + key + '/permutations/' + index + '/components';

          checkBlockComponents(overrides, pointer, legacy, true, report);
          prepareCustomComponents(overrides, pointer, report);
        }
      }
    }
  }
}
