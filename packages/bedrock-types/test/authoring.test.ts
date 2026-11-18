import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript-native/sync';
import { createDocumentChecker, documentLiteral } from '../../validation/src/document-types.ts';

const distribution = path.resolve(process.env.BEDROCK_TYPES_TEST_DIST ?? fileURLToPath(new URL('../dist', import.meta.url)));

function checkDocuments(category: string, accepted: unknown[], rejected: unknown[]): void {
  using api = new API();
  const check = createDocumentChecker(api, distribution, { additionalRoots: [path.join(distribution, 'index.d.ts')] });
  const documents = [...accepted, ...rejected].map(value => ({ category, literal: documentLiteral(value) }));
  const findings = check(documents);

  assert.deepEqual(findings.slice(0, accepted.length), accepted.map(() => []));

  for (const [index, errors] of findings.slice(accepted.length).entries()) {
    assert.ok(errors.length, `Expected to reject ${documents[accepted.length + index].literal}`);
  }
}

test('features require exactly one root and share typed scatter parameters with feature rules', () => {
  const distribution = {
    iterations: 'v.iterations',
    scatter_chance: { numerator: 1, denominator: 4 },
    x: { distribution: 'uniform', extent: [0, 15] },
    y: 'q.heightmap(v.worldx, v.worldz)',
    z: 0,
  };
  const scatter = {
    description: { identifier: 'test:scatter_flowers' },
    places_feature: 'test:flower',
    distribution,
  };
  const feature = { 'format_version': '1.21.20', 'minecraft:scatter_feature': scatter };
  const flower = {
    'format_version': '1.21.20',
    'minecraft:single_block_feature': {
      description: { identifier: 'test:flower' },
      places_block: 'minecraft:poppy',
      enforce_placement_rules: true,
      enforce_survivability_rules: true,
    },
  };
  const description = { identifier: 'test:flowers_rule', places_feature: 'test:scatter_flowers' };
  const conditions = {
    'placement_pass': 'surface_pass',
    'minecraft:biome_filter': [{ all_of: [{ test: 'has_biome_tag', value: 'forest' }] }],
  };
  const rule = { 'format_version': '1.13.0', 'minecraft:feature_rules': { description, conditions, distribution } };

  checkDocuments('bp/features', [feature, flower], [
    { format_version: feature.format_version },
    { ...feature, ...flower },
    { ...feature, 'minecraft:scatter_feature': { description: scatter.description, distribution } },
    { ...feature, 'minecraft:scatter_feature': { ...scatter, distribution: { ...distribution, x: { distribution: 'uniform', extent: [0] } } } },
  ]);
  checkDocuments('bp/feature_rules', [rule, { ...rule, 'minecraft:feature_rules': { description, conditions } }], [
    { format_version: rule.format_version, ...rule['minecraft:feature_rules'] },
    { ...rule, 'minecraft:feature_rules': { description: { ...description, places_feature: false }, conditions } },
    { ...rule, 'minecraft:feature_rules': { description, conditions: { placement_pass: 'invalid_pass' } } },
  ]);
});

test('both biome surface builders enforce the native noise gradient fields', () => {
  const builder = {
    type: 'minecraft:noise_gradient',
    noise_descriptor: { name: 'test:gradient', first_octave: -5, amplitudes: [1, 0, 1] },
    noise_block_specifiers: [{ range: { min: -1, max: 1 }, block: { name: 'minecraft:stone', states: {} } }],
    non_replaceable_blocks: ['minecraft:bedrock'],
  };

  for (const component of ['minecraft:surface_builder', 'minecraft:subsurface_builder']) {
    const biome = (value: unknown) => ({
      'format_version': '1.26.30',
      'minecraft:biome': { description: { identifier: 'test:biome' }, components: { [component]: { builder: value } } },
    });

    checkDocuments('bp/biomes', [biome(builder), biome({ type: 'minecraft:the_end' })], [
      biome({ type: builder.type }),
      biome({ type: builder.type, noise: builder.noise_descriptor, noise_block_specifiers: builder.noise_block_specifiers }),
      biome({ ...builder, noise_descriptor: { ...builder.noise_descriptor, amplitudes: [] } }),
    ]);
  }
});

test('entity authoring checks heal results, weighted timers and swim filters', () => {
  const entity = (components: object) => ({
    'format_version': '1.21.130',
    'minecraft:entity': { description: { identifier: 'test:animal' }, components },
  });
  const target = (filters: unknown) => entity({
    'minecraft:behavior.nearest_attackable_target': { entity_types: [{ filters }] },
  });

  checkDocuments('bp/entities', [
    entity({
      'minecraft:healable': { items: [{ item: 'minecraft:tropical_fish_bucket', result_item: 'minecraft:bucket', heal_amount: 4 }] },
      'minecraft:timer': { random_time_choices: [{ value: 2.5, weight: 4 }, { value: 3 }], time_down_event: { event: 'test:alarm' } },
      'minecraft:behavior.swim_with_entity': { entity_types: [{ filters: { test: 'is_family', subject: 'other', value: 'player' } }] },
    }),
    entity({ 'minecraft:behavior.swim_with_entity': { entity_types: ['player'] } }),
    target({
      all_of: [
        { test: 'is_family', subject: 'other', value: 'player' },
        { none_of: [{ test: 'bool_property', domain: 'test:ready', value: true }] },
      ],
    }),
  ], [
    entity({ 'minecraft:healable': { items: [{ item: 'minecraft:apple', result_item: true }] } }),
    entity({ 'minecraft:timer': { random_time_choices: [{ value: 2, weight: 'four' }] } }),
    entity({ 'minecraft:timer': { random_time_choices: ['two'] } }),
    entity({ 'minecraft:behavior.swim_with_entity': { entity_types: [{ filters: { test: 1 } }] } }),
    target({ test: 'bool_property', domain: 'test:ready', value: 1 }),
    target({ test: 'is_family', subject: 1, value: 'player' }),
    target({ test: 'is_famliy', value: 'player' }),
  ]);
});

test('behavior entities share typed actions between distinct event and upgrade dictionaries', () => {
  const description = {
    identifier: 'test:robot',
    is_summonable: true,
    properties: {
      'test:ready': { type: 'bool', default: false, client_sync: true },
      'test:mode': { type: 'enum', values: ['idle', 'active'], default: 'idle' },
      'test:level': { type: 'int', range: [0, 2], default: 0 },
    },
    animations: { prepare: 'controller.animation.test.prepare' },
    scripts: { animate: [{ prepare: '!q.property(\'test:ready\')' }] },
    entity_version: { upgrades: [{ upgrade_to: 1, name: 'test:prepare' }, { upgrade_to: 2, name: 'test:defaults' }] },
  };
  const definition = {
    description,
    component_groups: { 'test:active': { 'minecraft:physics': {} } },
    events: {
      'minecraft:entity_spawned': { randomize: [{ weight: 1, trigger: 'test:spawn' }, { weight: 2 }] },
      'test:spawn': { add: { component_groups: ['test:active'] } },
    },
    upgrades: {
      'test:prepare': { sequence: [{ filters: { test: 'is_family', value: 'robot' }, set_property: { 'test:ready': true } }] },
      'test:defaults': { first_valid: [{ add: { component_groups: ['test:active'] } }] },
    },
  };
  const document = (entity: object) => ({ 'format_version': '1.26.60', 'minecraft:entity': entity });

  checkDocuments('bp/entities', [document(definition)], [
    document({ ...definition, description: { is_spawnable: true } }),
    document({ ...definition, description: { ...description, properties: { 'test:level': { type: 'int', range: [0], default: false } } } }),
    document({ ...definition, description: { ...description, entity_version: { upgrades: [{ upgrade_to: '1', name: 'test:prepare' }] } } }),
    document({ ...definition, events: { 'test:spawn': { add: { component_groups: 'test:active' } } } }),
    document({ ...definition, upgrades: { 'test:prepare': { trigger: { event: true } } } }),
  ]);
});
