const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const entries = () => Object.create(null);
const texturePath = value => value.replaceAll('\\', '/').replace(/\.(?:png|tga|jpe?g)$/i, '');
const identity = value => value.includes(':') ? value : `minecraft:${value}`;
const renderKeys = new Set(['minecraft:geometry', 'minecraft:material_instances', 'minecraft:transformation', 'minecraft:item_visual', 'minecraft:light_emission', 'minecraft:light_dampening']);
const renderComponents = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => renderKeys.has(key)));
const blockDocument = (id, target = '1.26.60') => ({ 'format_version': target.split('.').slice(0, 3).join('.'), 'minecraft:block': { description: { identifier: id }, components: {} } });
const itemDocument = (id, target = '1.26.60') => ({ 'format_version': target.split('.').slice(0, 3).join('.'), 'minecraft:item': { description: { identifier: id }, components: {} } });
const identifyBlock = (value, id) => ({ ...value, 'minecraft:block': { ...value['minecraft:block'], description: { ...value['minecraft:block'].description, identifier: id } } });
const version = value => typeof value === 'string' ? value.split('.').map(Number) : [0];

const compare = (a, b) => {
  const left = version(a), right = version(b);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);

    if (diff) {
      return diff;
    }
  }

  return 0;
};

function texturePaths(value) {
  if (typeof value === 'string') {
    return [texturePath(value)];
  }

  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(texturePaths))];
  }

  if (record(value)) {
    return [...new Set(['path', 'textures', 'variations'].flatMap(key => texturePaths(value[key])))];
  }

  return [];
}

function mergeGeometry(base, child) {
  const bones = new Map((base.bones ?? []).map(bone => [bone.name, bone]));

  for (const bone of child.bones ?? []) {
    const inherited = bones.get(bone.name);

    bones.set(bone.name, { ...inherited, ...bone, ...(inherited?.cubes && bone.cubes ? { cubes: [...inherited.cubes, ...bone.cubes] } : {}) });
  }

  return { ...base, ...child, bones: [...bones.values()] };
}

/** Normalize resource identities and versioned native definitions without evaluating pack scripts. */
export function nativeAssets(resources, { target, bindings = {} } = {}) {
  const textures = entries(), models = entries(), blocks = entries(), entities = entries(), items = entries(), flipbooks = entries();
  const geometries = new Map(), entityVersions = new Map();

  const addGeometry = (key, geometry, formatVersion) => {
    const [id, parent] = key.startsWith('geometry.') ? key.split(':geometry.') : [key];

    geometries.set(id, { geometry, ...(parent ? { parent: `geometry.${parent}` } : {}), formatVersion });
  };

  for (const [name, document] of [...resources].sort(([a], [b]) => a.localeCompare(b))) {
    const file = name.replaceAll('\\', '/');

    if (/^textures\/(?:terrain|item)_texture\.json$/.test(file) && record(document?.texture_data)) {
      for (const [alias, definition] of Object.entries(document.texture_data)) {
        const id = file.endsWith('/item_texture.json') ? `item:${alias}` : alias;

        textures[id] = { paths: texturePaths(record(definition) ? definition.textures : definition), definition };
      }
    }

    if (file === 'textures/flipbook_textures.json' && Array.isArray(document)) {
      for (const flipbook of document) {
        if (record(flipbook)) {
          for (const id of [flipbook.atlas_tile, flipbook.flipbook_texture]) {
            if (typeof id === 'string') {
              flipbooks[texturePath(id)] = flipbook;
            }
          }
        }
      }
    }

    if (file === 'blocks.json' && record(document)) {
      for (const [name, block] of Object.entries(document)) {
        if (record(block)) {
          blocks[identity(name)] = { ...blockDocument(identity(name), target), ...(block.textures === undefined ? {} : { textures: block.textures }), ...(block.carried_textures === undefined ? {} : { carried_textures: block.carried_textures }) };
        }
      }
    }

    if (file.startsWith('models/') && record(document)) {
      for (const geometry of Array.isArray(document['minecraft:geometry']) ? document['minecraft:geometry'] : []) {
        if (record(geometry?.description) && typeof geometry.description.identifier === 'string') {
          addGeometry(geometry.description.identifier, geometry, document.format_version);
        }
      }

      for (const [id, geometry] of Object.entries(document)) {
        if (id.startsWith('geometry.') && record(geometry)) {
          addGeometry(id, geometry, document.format_version);
        }
      }
    }

    const description = document?.['minecraft:client_entity']?.description;

    if (file.startsWith('entity/') && record(description) && typeof description.identifier === 'string') {
      const minimum = description.min_engine_version ?? '0';
      const previous = entityVersions.get(description.identifier);

      if ((target === undefined || compare(minimum, target) <= 0) && (previous === undefined || compare(minimum, previous.minimum) > 0
        || (compare(minimum, previous.minimum) === 0 && compare(document.format_version, previous.format) >= 0))) {
        entities[description.identifier] = { ...document, format_version: document.format_version ?? '1.10.0' };
        entityVersions.set(description.identifier, { minimum, format: document.format_version });
      }
    }
  }

  const resolving = new Set();

  const resolveGeometry = (id) => {
    if (models[id]) {
      return models[id];
    }

    const source = geometries.get(id);

    if (!source) {
      throw new Error(`Missing native geometry parent: ${id}`);
    }

    if (resolving.has(id)) {
      throw new Error(`Native geometry inheritance cycle: ${id}`);
    }

    resolving.add(id);
    const geometry = source.parent ? mergeGeometry(resolveGeometry(source.parent).geometry, source.geometry) : source.geometry;

    models[id] = { geometry, ...(typeof source.formatVersion === 'string' ? { formatVersion: source.formatVersion } : {}), provenance: { kind: 'bedrock-native' } };
    resolving.delete(id);

    return models[id];
  };

  for (const id of geometries.keys()) {
    resolveGeometry(id);
  }

  for (const block of resources.get('metadata/mojang-blocks.json')?.data_items ?? []) {
    if (typeof block.name !== 'string') {
      continue;
    }

    const legacy = typeof block.serialization_id === 'string' ? block.serialization_id.replace(/^tile\./, '') : '';

    blocks[block.name] ??= blocks[identity(legacy)] ? identifyBlock(blocks[identity(legacy)], block.name) : blockDocument(block.name, target);
  }

  for (const [id, source] of Object.entries(bindings.blocks ?? {})) {
    if (!blocks[source]) {
      throw new Error(`Missing native block binding: ${source}`);
    }

    blocks[id] = { ...identifyBlock(blocks[source], id), ...blocks[id], ...(blocks[id]?.textures === undefined && blocks[source].textures !== undefined ? { textures: blocks[source].textures } : {}), ...(blocks[id]?.carried_textures === undefined && blocks[source].carried_textures !== undefined ? { carried_textures: blocks[source].carried_textures } : {}) };
  }

  for (const [name, document] of resources) {
    const block = document?.['minecraft:block'];

    if (!name.startsWith('blocks/') || typeof block?.description?.identifier !== 'string') {
      continue;
    }

    const id = block.description.identifier;
    const components = renderComponents(block.components);
    const permutations = (block.permutations ?? []).map(p => ({ condition: p.condition, components: renderComponents(p.components) }))
      .filter(p => Object.keys(p.components).length > 0);

    blocks[id] = { ...blocks[id], 'format_version': document.format_version ?? target ?? '1.26.60', 'minecraft:block': {
      description: { identifier: id, ...(block.description.states === undefined ? {} : { states: block.description.states }) }, components,
      ...(permutations.length ? { permutations } : {}),
    } };
  }

  for (const entity of Object.values(entities)) {
    const description = entity['minecraft:client_entity'].description;

    if (record(description.textures)) {
      for (const source of Object.values(description.textures)) {
        if (typeof source === 'string') {
          const normalized = texturePath(source), value = { paths: [normalized], definition: source };

          textures[source] ??= value;
          textures[normalized] ??= value;
        }
      }
    }
  }

  for (const [id, value] of Object.entries(textures)) {
    const flipbook = flipbooks[id] ?? flipbooks[value.paths[0]];

    if (flipbook) {
      value.flipbook = flipbook;
    }

    for (const name of value.paths) {
      textures[name] ??= { paths: [name], definition: name, ...(flipbooks[name] ? { flipbook: flipbooks[name] } : {}) };
    }
  }

  const nativeItems = resources.get('metadata/mojang-items.json')?.data_items ?? [];
  const itemsById = new Map(nativeItems.map(item => [item.name, item]));
  const itemNames = new Map();

  for (const item of nativeItems) {
    if (typeof item.name !== 'string') {
      continue;
    }

    for (const name of [item.name, item.serialization_name, typeof item.serialization_id === 'string' ? identity(item.serialization_id.replace(/^item\./, '')) : undefined]) {
      if (typeof name === 'string') {
        itemNames.set(name, item.name);
      }
    }

    items[item.name] = { ...itemDocument(item.name, target), ...(blocks[item.name] ? { block: { id: item.name } } : {}) };
  }

  for (const [name, document] of resources) {
    const item = document?.['minecraft:item'];

    if (!name.startsWith('items/') || typeof item?.description?.identifier !== 'string') {
      continue;
    }

    const id = itemNames.get(item.description.identifier) ?? item.description.identifier, components = record(item.components) ? item.components : {};
    const icon = components['minecraft:icon'];
    const icons = typeof icon === 'string' ? { default: icon } : record(icon?.textures) ? icon.textures : typeof icon?.texture === 'string' ? { default: icon.texture } : {};
    const references = Object.fromEntries(Object.entries(icons).filter(([, alias]) => typeof alias === 'string').map(([slot, alias]) => [slot, { id: `item:${alias}` }]));
    const block = components['minecraft:block_placer']?.block;

    items[id] = { ...items[id], 'format_version': document.format_version ?? target ?? '1.26.60', 'minecraft:item': { description: { identifier: id }, components: Object.fromEntries(Object.entries(components).filter(([key]) => ['minecraft:icon', 'minecraft:block_placer'].includes(key))) }, ...(Object.keys(references).length ? { textures: references } : {}), ...(typeof block === 'string' ? { block: { id: block } } : {}) };
  }

  for (const id of Object.keys(bindings.items ?? {})) {
    if (!items[id]) {
      throw new Error(`Unknown native item binding: ${id}`);
    }
  }

  for (const [id, item] of Object.entries(items)) {
    const explicit = bindings.items?.[id];

    if (explicit !== undefined) {
      if (!record(explicit)) {
        throw new Error(`Invalid native item texture binding: ${id}`);
      }

      const checked = Object.fromEntries(Object.entries(explicit).map(([slot, ref]) => {
        let selected = ref;

        if (record(ref) && typeof ref.alias === 'string' && Number.isSafeInteger(ref.index)) {
          const values = textures[`item:${ref.alias}`]?.definition?.textures;
          const paths = Array.isArray(values) && ref.index >= 0 ? texturePaths(values[ref.index]) : [];

          if (paths.length !== 1) {
            throw new Error(`Invalid native item texture index: ${id}`);
          }

          selected = paths[0];
        }

        if (typeof selected !== 'string' || !textures[selected]) {
          throw new Error(`Missing native item texture binding: ${id}`);
        }

        return [slot, { id: selected }];
      }));

      if (!item.textures) {
        item.textures = checked;
        item.provenance = { kind: 'bedrock-mapping', bindings: explicit };
      }
    } else {
      if (item.textures) {
        continue;
      }

      const name = id.replace(/^minecraft:/, ''), native = itemsById.get(id);
      const serialized = native?.serialization_id?.replace(/^item\./, '');
      const texture = [`item:${name}`, `item:${serialized}`, `textures/items/${name}`].find(ref => textures[ref]);

      if (texture) {
        item.textures = { default: { id: texture } };
        item.provenance = { kind: 'bedrock-name-match' };
      }
    }
  }

  return { textures, models, blocks, entities, items };
}
