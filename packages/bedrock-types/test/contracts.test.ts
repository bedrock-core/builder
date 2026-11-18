import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

function diagnostics(text: string, moduleResolution: ts.ModuleResolutionKind = ts.ModuleResolutionKind.NodeNext): string[] {
  const file = fileURLToPath(new URL('../contract-fixture.ts', import.meta.url));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: moduleResolution === ts.ModuleResolutionKind.Bundler ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);

  host.getSourceFile = (name, version, ...rest) =>
    path.resolve(name) === path.resolve(file) ? ts.createSourceFile(name, text, version, true) : original(name, version, ...rest);
  const program = ts.createProgram([file], options, host);

  return ts.getPreEmitDiagnostics(program).map(value => ts.flattenDiagnosticMessageText(value.messageText, '\n'));
}

test('Bedrock types resolve from the package root in NodeNext and Bundler projects', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string;
    types: string;
    exports: unknown;
  };

  assert.equal(pkg.types, './dist/index.d.ts');
  assert.deepEqual(pkg.exports, {
    '.': { types: pkg.types },
    './package.json': './package.json',
  });
  const source = `
    export type * as Bedrock from '${pkg.name}';
    // @ts-expect-error Block types are available through the package root.
    export type * as Blocks from '${pkg.name}/blocks';
    // @ts-expect-error Pack manifests belong to Builder's manifest stage.
    import type { PackManifestDocument } from '${pkg.name}';
    import type { DocumentTypes } from '${pkg.name}';
    // @ts-expect-error Behavior pack manifests are outside the content declarations.
    type BehaviorManifest = DocumentTypes['bp/manifest'];
    // @ts-expect-error Resource pack manifests are outside the content declarations.
    type ResourceManifest = DocumentTypes['rp/manifest'];
  `;

  assert.deepEqual(diagnostics(source), []);
  assert.deepEqual(diagnostics(source, ts.ModuleResolutionKind.Bundler), []);
});

test('authored declarations resolve generated models through the package project configuration', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const author = path.join(root, 'types/models/parts.d.ts');
  const configFile = ts.findConfigFile(path.dirname(author), ts.sys.fileExists);

  assert.equal(configFile && path.resolve(configFile), path.join(root, 'tsconfig.json'));
  const loaded = ts.readConfigFile(configFile!, ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);

  assert.equal(config.errors.length, 0);
  assert.ok(config.fileNames.map(file => path.resolve(file)).includes(author));
  assert.equal(config.options.skipLibCheck, false);
  const model = ts.resolveModuleName('./geometry', author, config.options, ts.sys).resolvedModule;

  assert.equal(model && path.resolve(model.resolvedFileName), path.join(root, 'dist/models/geometry.d.ts'));
  const program = ts.createProgram([author], config.options);

  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(value => ts.flattenDiagnosticMessageText(value.messageText, '\n')), []);
});

test('native documents and component types preserve meaningful field checks', () => {
  assert.deepEqual(
    diagnostics(`
    import type {
      BlockComponents, BlockDocument, ClientEntityDocument, DocumentCategory,
      ModelGeometry, RecipeDocument, ShapelessRecipeDocument,
    } from '@bedrock-core/bedrock-types';
    const components: BlockComponents = {
      'minecraft:friction': 0.4, 'minecraft:collision_box': false,
      'minecraft:geometry': { identifier: 'geometry.test', uv_lock: ['root'], bone_visibility: { root: 'q.is_alive' } },
      'minecraft:material_instances': { '*': { texture: 'test', render_method: 'alpha_test' }, north: 'side' },
    };
    const block: BlockDocument = { format_version: '1.26.60', 'minecraft:block': { description: { identifier: 'test:block' }, components } };
    // @ts-expect-error Vanilla engine internals are not part of the public block-authoring format.
    const privateBlock: BlockDocument = { format_version: '1.26.60', 'minecraft:block': { description: { identifier: 'test:block', internal_vanilla_data: { block_id: 1 } } } };
    const entity: ClientEntityDocument = { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: 'test:entity', textures: { default: 'textures/test' }, geometry: { default: 'geometry.test' }, scripts: { scalex: 1, variables: { 'variable.active': 'public' } }, render_controllers: [{ 'controller.render.test': 'q.is_alive' }] } } };
    const geometry: ModelGeometry = { description: { identifier: 'geometry.test', texture_width: 16, texture_height: 16, visible_bounds_width: 2, visible_bounds_height: 2 }, bones: [{ name: 'root', pivot: [0, 0, 0], locators: { head: [0, 1, 0] }, cubes: [{ origin: [0, 0, 0], size: [16, 16, 16], inflate: 0.1, uv: { north: { uv: [0, 0], uv_size: [16, 16] } } }] }] };
    const shapeless: ShapelessRecipeDocument = { format_version: '1.12', 'minecraft:recipe_shapeless': { description: { identifier: 'test:recipe' }, tags: ['crafting_table'], ingredients: [{ item: 'minecraft:stone' }], result: { item: 'minecraft:stone', count: 1 } } };
    const recipe: RecipeDocument = shapeless;
    // @ts-expect-error Numeric vectors reject text.
    const invalid: ModelGeometry = { bones: [{ name: 'root', pivot: ['x', 0, 0] }] };
    // @ts-expect-error Native scalar components remain numeric.
    const invalidComponents: BlockComponents = { 'minecraft:friction': 'invalid' };
    // @ts-expect-error Component helpers are not native document categories.
    const internalCategory: DocumentCategory = 'assets/block-components';
    void internalCategory;
    void [block, privateBlock, entity, geometry, recipe, invalid, invalidComponents];
  `),
    [],
  );
});

test('animations expose typed channels, keyframes, events and controller state machines for both packs', () => {
  assert.deepEqual(diagnostics(`
    import type {
      Animation, AnimationBone, AnimationControllerDocument, AnimationControllerState, AnimationDocument, DocumentTypes,
    } from '@bedrock-core/bedrock-types';
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    const sameAnimations: Same<DocumentTypes['rp/animations'], DocumentTypes['bp/animations']> = true;
    const sameControllers: Same<DocumentTypes['rp/animation_controllers'], DocumentTypes['bp/animation_controllers']> = true;
    const clip: Animation = {
      loop: 'hold_on_last_frame', animation_length: 1.5, blend_weight: 1, start_delay: 'v.delay',
      bones: { root: { position: [0, 'q.life_time', 0], rotation: { '0.0': [0, 0, 0], '1.0': { lerp_mode: 'catmullrom', pre: [0, 45, 0], post: [0, 90, 0] } }, scale: 1, relative_to: { rotation: 'entity' } } },
      timeline: { '0.5': ['v.hit = 1;', '/say hit'] },
      particle_effects: { '0.5': [{ effect: 'dust', locator: 'feet', pre_effect_script: 1, bind_to_actor: false }] },
      sound_effects: { '0.5': { effect: 'hit' } },
    };
    const animation: AnimationDocument = { format_version: '1.8.0', animations: { 'animation.test.hit': clip } };
    const orderedRotation: AnimationBone = { rotation: [{ y: '180.0 - this' }, { x: 'q.body_x_rotation' }, { y: 'v.swim_rotation' }] };
    const state: AnimationControllerState = {
      animations: ['idle', { moving: 'q.is_moving' }], transitions: [{ active: 'v.active' }],
      blend_transition: { '0.0': 0, '1.0': 1 }, blend_via_shortest_path: true,
      on_entry: ['v.active = 1;'], on_exit: ['v.active = 0;'],
      variables: { speed: { input: 'q.ground_speed', remap_curve: { '0.0': 0, '1.0': 1 } } },
      particle_effects: ['dust', { effect: 'dust', pre_effect_script: 1 }], sound_effects: ['hit', { effect: 'hit' }],
    };
    const controller: AnimationControllerDocument = { format_version: '1.10.0', animation_controllers: { 'controller.animation.test': { initial_state: 'default', states: { default: state } } } };
    // @ts-expect-error Vector transforms have exactly three axes.
    const shortVector: AnimationBone = { position: [1, 2] };
    // @ts-expect-error Interpolation modes use their native literals.
    const badInterpolation: AnimationBone = { rotation: { '0.0': { lerp_mode: 'cubic' } } };
    // @ts-expect-error Animation duration is numeric.
    const badDuration: Animation = { animation_length: 'one second' };
    // @ts-expect-error Conditions contain Molang expressions, not booleans.
    const badTransition: AnimationControllerState = { transitions: [{ active: true }] };
    // @ts-expect-error Remapping curves contain numeric values.
    const badCurve: AnimationControllerState = { variables: { speed: { input: 1, remap_curve: { '0': 'invalid' } } } };
    // @ts-expect-error Controller state dictionaries are required.
    const noStates: AnimationControllerDocument = { format_version: '1.10.0', animation_controllers: { test: { initial_state: 'default' } } };
    // @ts-expect-error Ordered rotation operations use native axis names.
    const badAxis: AnimationBone = { rotation: [{ w: 90 }] };
    void [sameAnimations, sameControllers, animation, orderedRotation, controller, shortVector, badInterpolation, badDuration, badTransition, badCurve, noStates, badAxis];
  `), []);
});

test('entities and attachables share resource descriptions and scripts while retaining their native fields', () => {
  assert.deepEqual(diagnostics(`
    import type {
      AttachableDescription, AttachableDocument, AttachableScripts, ClientEntityDescription, ClientEntityDocument,
      ClientEntityScripts, ClientResourceDescription, ClientResourceScripts,
    } from '@bedrock-core/bedrock-types';
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    const sameScripts: Same<ClientEntityScripts, AttachableScripts> = true;
    const scripts: ClientResourceScripts = {
      initialize: ['v.active = 0;'], pre_animation: ['v.time = q.life_time;'], parent_setup: 'v.armor_visible = 0;',
      animate: ['idle', { active: 'v.active' }], variables: { 'variable.active': 'public' },
      scaleX: 1, scaley: 1, scalez: 1, hide_held_items: 'v.hidden', should_update_bones_and_effects_offscreen: 'q.is_alive',
    };
    const shared: ClientResourceDescription = { identifier: 'test:visual', min_engine_version: '1.21.0',
      textures: { default: 'textures/test' }, geometry: { default: 'geometry.test' }, materials: { default: 'entity_alphatest' },
      animations: { idle: 'animation.test.idle' }, scripts, render_controllers: ['controller.render.default', { 'controller.render.active': 'v.active' }],
    };
    const entity: ClientEntityDescription = { ...shared, queryable_geometry: 'default', held_item_ignores_lighting: true, held_item_scale: 2.678, particle_emitters: { dust: 'test:dust' } };
    const attachable: AttachableDescription = { ...shared, item: { 'test:item': 'q.is_owner_identifier_any("minecraft:player")' } };
    const document: AttachableDocument = { format_version: '1.10.0', 'minecraft:attachable': { description: attachable } };
    const entityDocument: ClientEntityDocument = { format_version: '1.10.0', 'minecraft:client_entity': { description: entity } };
    // @ts-expect-error Item conditions use Molang expressions.
    const badItem: AttachableDescription = { identifier: 'test:visual', item: { 'test:item': true } };
    // @ts-expect-error Both native descriptions require an identifier.
    const noIdentifier: AttachableDescription = { textures: { default: 'textures/test' } };
    // @ts-expect-error Conditional animation entries use dynamic alias keys with Molang values.
    const badAnimate: AttachableScripts = { animate: [{ active: false }] };
    // @ts-expect-error Client-entity documents require their own native root.
    const wrongRoot: ClientEntityDocument = { format_version: '1.10.0', 'minecraft:attachable': { description: attachable } };
    void [sameScripts, document, entityDocument, badItem, noIdentifier, badAnimate, wrongRoot];
  `), []);
});

test('render controllers expose complete native arrays, expression maps, colours and UV animation', () => {
  assert.deepEqual(diagnostics(`
    import type { RenderControllerDocument, RenderController, RenderControllerColor, RenderControllerUVAnimation } from '@bedrock-core/bedrock-types';
    const color: RenderControllerColor = { r: 1, g: 'v.green', b: 0.5, a: 1 };
    const uv: RenderControllerUVAnimation = { offset: ['q.life_time', 0], scale: [1, 1] };
    const controller: RenderController = {
      geometry: 'array.models[q.variant]',
      arrays: { geometries: { 'array.models': ['geometry.default'] }, textures: { 'array.skins': ['texture.default', 'texture.other'] }, materials: { 'array.materials': ['material.default'] } },
      materials: [{ '*': 'material.default' }], textures: ['array.skins[q.variant]'], part_visibility: [{ root: 'q.is_alive' }, { hat: 1 }, { unused: false }],
      color, overlay_color: color, is_hurt_color: color, on_fire_color: color,
      filter_lighting: true, ignore_lighting: false, light_color_multiplier: 0.8, rebuild_animation_matrices: true, uv_anim: uv,
    };
    const document: RenderControllerDocument = { format_version: '1.8.0', render_controllers: { 'controller.render.test': controller } };
    // @ts-expect-error Visibility values are constants or expressions, not arbitrary objects.
    const badVisibility: RenderController = { geometry: 'geometry.default', part_visibility: [{ root: { value: true } }] };
    // @ts-expect-error Array entries contain resource references.
    const badArray: RenderController = { geometry: 'geometry.default', arrays: { textures: { 'array.skins': [true] } } };
    // @ts-expect-error UV vectors have exactly two axes.
    const badUV: RenderControllerUVAnimation = { offset: [0, 0, 0], scale: [1, 1] };
    // @ts-expect-error Colour channels are expressions, not arbitrary objects.
    const badColor: RenderControllerColor = { r: { value: 1 } };
    void [document, badVisibility, badArray, badUV, badColor];
  `), []);
});

test('component registries type native lookups and augment block, item and entity documents', () => {
  assert.deepEqual(diagnostics(`
    import type {
      BlockComponentId, BlockComponents, BlockDocument, Component, ComponentId, Components, EntityDocument, ItemComponents, ItemDocument,
    } from '@bedrock-core/bedrock-types';
    declare module '@bedrock-core/bedrock-types' {
      interface BlockComponentRegistry { 'test:power': { strength: number }; }
      interface ItemComponentRegistry { 'test:charges': { remaining: number }; }
      interface EntityComponentRegistry { 'test:follow': { target: string }; }
      interface ComponentRegistries { widget: { label: string }; }
    }
    const id: BlockComponentId = 'test:power';
    const genericId: ComponentId<'item'> = 'test:charges';
    const data: Component<'block', 'test:power'> = { strength: 3 };
    const block: BlockDocument = { format_version: '1.26.60', 'minecraft:block': { description: { identifier: 'test:block' }, components: { 'minecraft:friction': 0.5, 'test:power': data }, permutations: [{ condition: 'q.is_alive', components: { 'test:power': { strength: 2 } } }] } };
    const item: ItemDocument = { format_version: '1.26.0', 'minecraft:item': { description: { identifier: 'test:item' }, components: { 'minecraft:max_stack_size': 64, 'test:charges': { remaining: 3 } } } };
    const entity: EntityDocument = { format_version: '1.26.0', 'minecraft:entity': { description: { identifier: 'test:entity' }, components: { 'test:follow': { target: 'test:player' } }, component_groups: { active: { 'test:follow': { target: 'test:other' } } } } };
    const extraFamily: Components<'widget'> = { label: 'hello' };
    // @ts-expect-error Unknown identifiers do not turn into an unrestricted index signature.
    const unknownId: BlockComponents = { 'test:unregistered': {} };
    // @ts-expect-error Registered block parameters remain checked.
    const wrongBlock: BlockComponents = { 'test:power': { strength: 'high' } };
    // @ts-expect-error Registered item parameters remain checked.
    const wrongItem: ItemComponents = { 'test:charges': { remaining: 'three' } };
    // @ts-expect-error Native payload types remain checked.
    const wrongNative: ItemComponents = { 'minecraft:max_stack_size': { value: 'many' } };
    // @ts-expect-error Native component identifiers constrain payload lookups.
    type UnknownPayload = Component<'block', 'test:missing'>;
    // @ts-expect-error Component groups use the same typed registry as base components.
    const wrongGroup: EntityDocument = { format_version: '1.26.0', 'minecraft:entity': { description: { identifier: 'test:entity' }, component_groups: { active: { 'test:follow': { target: 3 } } } } };
    // @ts-expect-error Standalone particle components are outside the supported registry families.
    type ParticlePayload = ComponentId<'particle'>;
    // @ts-expect-error Entity registries also constrain component identifiers.
    type UnknownEntityPayload = Component<'entity', 'test:missing'>;
    // @ts-expect-error Item registries also constrain component identifiers.
    type UnknownItemPayload = Component<'item', 'test:missing'>;
    void [id, genericId, block, item, entity, extraFamily, unknownId, wrongBlock, wrongItem, wrongNative, wrongGroup];
  `), []);
});

test('texture sets require a document wrapper and color, preserve channel counts and reject conflicting layers', () => {
  assert.deepEqual(diagnostics(`
    import type { TextureSetDocument, TextureSet } from '@bedrock-core/bedrock-types';
    const images: TextureSetDocument = { format_version: '1.21.30', 'minecraft:texture_set': { color: 'stone', normal: 'stone_normal', metalness_emissive_roughness_subsurface: 'stone_mers' } };
    const uniforms: TextureSetDocument = { format_version: '1.16.100', 'minecraft:texture_set': { color: [180, 135, 190, 170], heightmap: 128, metalness_emissive_roughness: [130, 135, 140] } };
    const hex: TextureSet = { color: '#FF808080', heightmap: '#80', metalness_emissive_roughness_subsurface: [0, 0, 200, 128] };
    const minimal: TextureSet = { color: 'stone' };
    // @ts-expect-error Layers belong inside the minecraft:texture_set document property.
    const unwrapped: TextureSetDocument = { color: 'stone' };
    // @ts-expect-error The format version is required on a complete texture-set document.
    const unversioned: TextureSetDocument = { 'minecraft:texture_set': minimal };
    // @ts-expect-error Every texture set requires its color layer.
    const noColor: TextureSet = { normal: 'stone_normal' };
    // @ts-expect-error Uniform color values contain four channels.
    const shortColor: TextureSet = { color: [128, 128, 128] };
    // @ts-expect-error Uniform MER values contain three channels.
    const longMer: TextureSet = { color: 'stone', metalness_emissive_roughness: [0, 0, 0, 0] };
    // @ts-expect-error Uniform MERS values contain four channels.
    const shortMers: TextureSet = { color: 'stone', metalness_emissive_roughness_subsurface: [0, 0, 0] };
    // @ts-expect-error Normal maps and heightmaps cannot be combined.
    const conflictingSurface: TextureSet = { color: 'stone', normal: 'stone_normal', heightmap: 'stone_heightmap' };
    // @ts-expect-error MER and MERS maps cannot be combined.
    const conflictingMaterial: TextureSet = { color: 'stone', metalness_emissive_roughness: 'stone_mer', metalness_emissive_roughness_subsurface: 'stone_mers' };
    void [images, uniforms, hex, minimal, unwrapped, unversioned, noColor, shortColor, longMer, shortMers, conflictingSurface, conflictingMaterial];
  `), []);
});

test('flipbook documents and atlases preserve their document and entry types', () => {
  assert.deepEqual(diagnostics(`
    import type { FlipbookTextureDocument, FlipbookTexture, TerrainTexturesDocument, ItemTexturesDocument, TextureAtlasEntry, TextureListDocument } from '@bedrock-core/bedrock-types';
    const flipbooks: FlipbookTextureDocument = [
      { flipbook_texture: 'textures/blocks/test', atlas_tile: 'test', ticks_per_frame: 4, frames: [0, 2, 1], blend_frames: false, atlas_index: 1, atlas_tile_variant: 0, replicate: 2 },
      { flipbook_texture: 'textures/blocks/other', atlas_tile: 'other', frames: 6 },
    ];
    const entry: FlipbookTexture = flipbooks[0];
    const terrain: TerrainTexturesDocument = {
      resource_pack_name: 'test', texture_name: 'atlas.terrain', texture_data: {
        simple: { textures: 'textures/blocks/simple', quad: 2 },
        variants: { textures: ['textures/blocks/first', { path: 'textures/blocks/second', quad: 1, tint_color: '#ffffff' }] },
        weighted: { textures: { variations: [{ path: 'textures/blocks/first', weight: 10 }, { path: 'textures/blocks/second', weight: 20 }] } },
        layers: { additive: true, textures: [{ path: 'textures/blocks/base', overlay_color: '#ffffff' }, 'textures/blocks/overlay'] },
      },
    };
    const textureList: TextureListDocument = ['textures/blocks/simple'];
    const atlasEntry: TextureAtlasEntry = terrain.texture_data.simple;
    const items: ItemTexturesDocument = { resource_pack_name: 'test', texture_name: 'atlas.items', texture_data: { icon: atlasEntry }, default_leather_color: '#ffffff', default_leather_horse_armor_color: '#ffffff' };
    // @ts-expect-error A flipbook document contains an array of entries.
    const wrongRoot: FlipbookTextureDocument = entry;
    // @ts-expect-error Flipbook entries require their atlas alias and texture path.
    const missingPath: FlipbookTexture = { atlas_tile: 'test' };
    // @ts-expect-error Frame ordering uses numeric indices.
    const badFrames: FlipbookTexture = { ...entry, frames: ['first'] };
    // @ts-expect-error Atlas paths remain strings.
    const badPath: TextureAtlasEntry = { textures: { path: 1 } };
    // @ts-expect-error Weighted variations must identify their image path.
    const badVariation: TextureAtlasEntry = { textures: { variations: [{ weight: 1 }] } };
    // @ts-expect-error Atlas entries require their texture definition.
    const empty: TextureAtlasEntry = {};
    // @ts-expect-error Texture list entries are resource paths.
    const badTextureList: TextureListDocument = [false];
    void [flipbooks, items, textureList, wrongRoot, missingPath, badFrames, badPath, badVariation, empty, badTextureList];
  `), []);
});

test('recipes support native keys, tag ingredients, result alternatives, unlocks and brewing containers', () => {
  assert.deepEqual(diagnostics(`
    import type {
      BrewingContainerRecipeDocument, FurnaceRecipeDocument, ItemComponents, RecipeDocument,
      RecipeIngredient, RecipeUnlock, ShapedRecipeDocument, ShapelessRecipeDocument,
    } from '@bedrock-core/bedrock-types';
    const shaped: ShapedRecipeDocument = { format_version: '1.20.10', 'minecraft:recipe_shaped': {
      description: { identifier: 'test:shaped' }, tags: ['crafting_table'], pattern: ['#'], key: { '#': { tag: 'minecraft:planks' } },
      result: [{ item: 'minecraft:barrel', count: 1 }], unlock: { context: 'PlayerInWater' },
    } };
    const shapeless: ShapelessRecipeDocument = { format_version: '1.20.10', 'minecraft:recipe_shapeless': {
      description: { identifier: 'test:shapeless' }, tags: ['crafting_table'], ingredients: [{ tag: 'minecraft:planks' }, { item: 'minecraft:boat', data: 4 }],
      result: { item: 'minecraft:chest_boat', data: 4 }, unlock: [{ item: 'minecraft:boat', data: 4 }, { tag: 'minecraft:planks' }],
    } };
    const furnace: FurnaceRecipeDocument = { format_version: '1.20.10', 'minecraft:recipe_furnace': {
      description: { identifier: 'test:furnace' }, tags: ['furnace'], input: { tag: 'minecraft:logs' }, output: 'minecraft:charcoal', priority: 100, unlock: [{ item: 'minecraft:oak_log' }],
    } };
    const container: BrewingContainerRecipeDocument = { format_version: '1.20.10', 'minecraft:recipe_brewing_container': {
      description: { identifier: 'test:container' }, tags: ['brewing_stand'], input: 'minecraft:potion', reagent: 'minecraft:gunpowder', output: 'minecraft:splash_potion',
    } };
    const documents: RecipeDocument[] = [shaped, shapeless, furnace, container];
    // @ts-expect-error Ingredients must identify an item or a tag.
    const emptyIngredient: RecipeIngredient = { count: 1 };
    // @ts-expect-error Unlock conditions must identify an ingredient or context.
    const emptyUnlock: RecipeUnlock = {};
    // @ts-expect-error Result stacks must identify concrete items.
    const badResult: ShapedRecipeDocument = { ...shaped, 'minecraft:recipe_shaped': { ...shaped['minecraft:recipe_shaped'], result: { tag: 'minecraft:planks' } } };
    // @ts-expect-error Ingredient amounts remain numeric.
    const badCount: RecipeIngredient = { item: 'minecraft:stone', count: 'many' };
    const icon: ItemComponents = { 'minecraft:icon': { textures: { default: 'apple' } } };
    // @ts-expect-error The retired singular texture field is absent from modern icon definitions.
    const legacyIcon: ItemComponents = { 'minecraft:icon': { texture: 'apple' } };
    void [documents, emptyIngredient, emptyUnlock, badResult, badCount, icon, legacyIcon];
  `), []);
});

test('bounded arrays preserve inclusive lower and upper limits and native collision-box limits', () => {
  assert.deepEqual(diagnostics(`
    import type { BlockCollisionBox, BoundedArray } from '@bedrock-core/bedrock-types';
    const range: BoundedArray<number, 1, 3> = [1, 2, 3];
    const minimum: BoundedArray<number, 1, 3> = [1];
    const disabled: BlockCollisionBox = false;
    const box: BlockCollisionBox = { origin: [0, 0, 0], size: [16, 16, 16] };
    const boxes: BlockCollisionBox = [{ origin: [0, 0, 0], size: [16, 16, 16] }];
    // @ts-expect-error The minimum length is inclusive.
    const short: BoundedArray<number, 1, 3> = [];
    // @ts-expect-error The maximum length is inclusive.
    const long: BoundedArray<number, 1, 3> = [1, 2, 3, 4];
    // @ts-expect-error Collision-box arrays are limited to sixteen entries.
    const tooManyBoxes: BlockCollisionBox = [${Array.from({ length: 17 }, () => '{}').join(', ')}];
    void [range, minimum, disabled, box, boxes, short, long, tooManyBoxes];
  `), []);
});

test('fog identifiers and native block mapping dictionaries retain their field checks', () => {
  assert.deepEqual(diagnostics(`
    import type { BlockResourceDefinition, BlockTexturesDocument, FogDocument } from '@bedrock-core/bedrock-types';
    const fog: FogDocument = { format_version: '1.16.100', 'minecraft:fog_settings': { description: { identifier: 'test:fog' }, distance: { air: { fog_color: '#ffffff', fog_start: 0, fog_end: 1, render_distance_type: 'render' } }, volumetric: { density: { air: { max_density: 0.05, max_density_height: 320, zero_density_height: 320 } }, media_coefficients: { air: { scattering: [0.06, 0.06, 0.06], absorption: [0, 0, 0] } }, henyey_greenstein_g: { air: { henyey_greenstein_g: 0.4 } } } } };
    const definition: BlockResourceDefinition = { sound: 'stone', ambient_occlusion_exponent: 0.8, textures: { up: 'top', side: 'side' }, carried_textures: 'inventory', isotropic: { up: true, down: true } };
    const blocks: BlockTexturesDocument = { format_version: '1.21.40', warped_nylium: definition, 'test:block': { textures: 'test', isotropic: false } };
    const keyedFog: FogDocument = { format_version: '1.26.20', 'minecraft:fog_settings': { description: { identifier: 'test:keyed' }, volumetric: { density: { air: { max_density: { '0.0': 0.05, '1.0': 0.1 } } }, media_coefficients: { water: { scattering: '#000000', absorption: { '0.0': [0, 0, 0], '1.0': '#ffffff' } } } } } };
    // @ts-expect-error Fog identifiers are strings.
    const badFog: FogDocument = { format_version: '1.16.100', 'minecraft:fog_settings': { description: { identifier: true } } };
    // @ts-expect-error Texture aliases are strings.
    const badTexture: BlockResourceDefinition = { textures: { up: 2 } };
    // @ts-expect-error Isotropic faces use native face names.
    const badFace: BlockResourceDefinition = { isotropic: { front: true } };
    // @ts-expect-error Block entries cannot be numeric.
    const badBlock: BlockTexturesDocument = { 'test:block': 3 };
    // @ts-expect-error Volumetric scattering contains three numeric channels.
    const badVolume: FogDocument = { format_version: '1.16.100', 'minecraft:fog_settings': { description: { identifier: 'test:fog' }, volumetric: { media_coefficients: { air: { scattering: ['red', 0, 0] } } } } };
    void [fog, keyedFog, blocks, badFog, badTexture, badFace, badBlock, badVolume];
  `), []);
});

test('modern geometry and legacy named geometry preserve their distinct native fields', () => {
  assert.deepEqual(diagnostics(`
    import type { GeometryDocument, ModelGeometry, LegacyModelGeometry } from '@bedrock-core/bedrock-types';
    const modern: ModelGeometry = { description: { identifier: 'geometry.test' }, item_display_transforms: { gui: { fit_to_frame: true, rotation: [30, 225, 0], translation: [0, 1, 0], scale: [1, 1, 1] } }, bones: [{ name: 'root', binding: 'q.item_slot_to_bone_name(c.item_slot)', cubes: [{ uv: { up: { uv: [0, 0], uv_size: [16, 16], uv_rotation: 180 } } }] }] };
    const legacy: LegacyModelGeometry = { texturewidth: 64, textureheight: 64, visible_bounds_offset: [0, 1, 0], bones: [{ name: 'root', bind_pose_rotation: [0, 0, 0], reset: true, neverRender: false, inflate: 0.1, cubes: [{ uv: [0, 0], origin: [-8, 0, -8], size: [16, 16, 16] }] }] };
    const current: GeometryDocument = { format_version: '1.21.0', 'minecraft:geometry': [modern] };
    const old: GeometryDocument = { format_version: '1.8.0', 'geometry.test': legacy };
    // @ts-expect-error Legacy texture dimensions stay numeric.
    const badLegacy: GeometryDocument = { format_version: '1.8.0', 'geometry.test': { texturewidth: 'wide' } };
    // @ts-expect-error Face UV rotations are quarter turns.
    const badRotation: ModelGeometry = { bones: [{ cubes: [{ uv: { up: { uv_rotation: 45 } } }] }] };
    // @ts-expect-error Bone bindings contain Molang expressions.
    const badBinding: ModelGeometry = { bones: [{ binding: true }] };
    // @ts-expect-error Display-transform vectors stay numeric.
    const badTransform: ModelGeometry = { item_display_transforms: { gui: { translation: ['x', 0, 0] } } };
    // @ts-expect-error Legacy UVs use box-mapped numeric pairs.
    const badUv: LegacyModelGeometry = { bones: [{ cubes: [{ uv: { up: { uv: [0, 0] } } }] }] };
    void [current, old, badLegacy, badRotation, badBinding, badTransform, badUv];
  `), []);
});

test('client biomes and lighting use native component fields and typed color curves', () => {
  assert.deepEqual(diagnostics(`
    import type { ClientBiomeDocument, LightingDocument } from '@bedrock-core/bedrock-types';
    const biome: ClientBiomeDocument = { format_version: '1.21.120', 'minecraft:client_biome': { description: { identifier: 'test:biome' }, components: { 'minecraft:fog_appearance': { fog_identifier: 'test:fog' }, 'minecraft:water_appearance': { surface_color: '#0056ff', surface_opacity: 0.4 }, 'minecraft:lighting_identifier': { lighting_identifier: 'test:lighting' }, 'minecraft:ambient_sounds': { addition: { asset: 'test:addition', chance: 0.01 }, underwater_addition: { asset: 'test:underwater', chance: 0.01 }, underwater_loop: 'test:loop' }, 'minecraft:biome_music': { underwater_music: true }, 'minecraft:grass_appearance': { grass_is_shaded: true } } } };
    const lighting: LightingDocument = { format_version: '1.26.0', 'minecraft:lighting_settings': {
      description: { identifier: 'test:lighting' }, directional_lights: { orbital: { sun: { color: { '0.0': [255, 127, 0], '1.0': '#ffffff' }, illuminance: { '0.0': 100, '1.0': 0 } }, moon: { color: [163, 182, 255], illuminance: 0.4 }, orbital_offset_degrees: 0 }, flash: { color: [228, 93, 255], illuminance: 10 } },
      ambient: { color: { '0.0': '#ffffff' }, illuminance: { '0.0': 0.02 } }, sky: { intensity: { '0.0': 0.8 } },
    } };
    const legacyLighting: LightingDocument = { format_version: '1.21.70', 'minecraft:lighting_settings': { directional_lights: { sun: { color: { '0.0': [255, 127, 0] } } } } };
    // @ts-expect-error Water opacity remains numeric.
    const badBiome: ClientBiomeDocument = { format_version: '1.21.120', 'minecraft:client_biome': { description: { identifier: 'test:biome' }, components: { 'minecraft:water_appearance': { surface_opacity: 'opaque' } } } };
    // @ts-expect-error RGB keyframes contain three numeric channels.
    const badCurve: LightingDocument = { format_version: '1.26.0', 'minecraft:lighting_settings': { directional_lights: { orbital: { sun: { color: { '0.0': [255, 127] } } } } } };
    // @ts-expect-error Arbitrary objects cannot bypass color validation.
    const badColor: LightingDocument = { format_version: '1.26.0', 'minecraft:lighting_settings': { directional_lights: { sun: { color: { value: true } } } } };
    // @ts-expect-error Ambient addition probabilities remain numeric.
    const badAddition: ClientBiomeDocument = { format_version: '1.21.120', 'minecraft:client_biome': { description: { identifier: 'test:biome' }, components: { 'minecraft:ambient_sounds': { underwater_addition: { asset: 'test:underwater', chance: 'always' } } } } };
    void [biome, lighting, legacyLighting, badBiome, badCurve, badColor, badAddition];
  `), []);
});

test('sound event bindings expose typed native structures', () => {
  assert.deepEqual(diagnostics(`
    import type { SoundEventsDocument } from '@bedrock-core/bedrock-types';
    const sounds: SoundEventsDocument = { block_sounds: { copper: { events: { 'trapdoor.close': { sound: 'close_trapdoor.copper', pitch: [0.9, 1.1], volume: 1 } } } }, individual_named_sounds: { sounds: { test: { sound: 'test.sound' } } } };
    const variants: SoundEventsDocument = {
      entity_sounds: {
        entities: {
          cat: {
            variants: {
              key: "q.is_baby ? 'baby' : 'adult'",
              map: {
                baby: { events: { ambient: { sound: 'mob.baby_cat.ambient', volume: 0.5 } } },
                adult: { events: { ambient: { volume: 1 } } },
              },
            },
          },
        },
      },
    };
    // @ts-expect-error Sound volume cannot be textual.
    const badSound: SoundEventsDocument = { block_sounds: { copper: { events: { close: { sound: 'close.copper', volume: 'loud' } } } } };
    // @ts-expect-error Undocumented engine-version metadata is outside the public authoring contract.
    const internalSound: SoundEventsDocument = { entity_sounds: { entities: { cat: { __molang_version: 13 } } } };
    void [sounds, variants, badSound, internalSound];
  `), []);
});

test('corrected authoring documents retain the native field and payload types', () => {
  assert.deepEqual(diagnostics(`
    import type {
      ColorGradingDocument, EntityComponents, ItemComponents, LootFunction, LootTableDocument, MusicDefinitionsDocument,
      SoundDefinitionsDocument, SpawnRuleDocument, TradingDocument,
    } from '@bedrock-core/bedrock-types';
    const components: EntityComponents = {
      'minecraft:entity_sensor': { subsensors: [{ range: [10, 6], event: 'test:notice' }] },
      'minecraft:navigation.walk': { using_door_annotation: true },
      'minecraft:breedable': { breeds_with: { 'test:animal': { event: 'test:pregnant', target: 'self' } } },
      'minecraft:ageable': { feed_items: ['minecraft:wheat', { item: 'minecraft:milk_bucket', growth: 2, result_item: 'minecraft:bucket' }] },
      'minecraft:transformation': { into: 'test:adult', transformation_sound: 'test.transform' },
    };
    const spawn: SpawnRuleDocument = {
      format_version: '1.8.0', 'minecraft:spawn_rules': { description: { identifier: 'test:animal' }, conditions: [{
        'minecraft:biome_filter': { all_of: [{ any_of: [{ test: 'has_biome_tag', value: 'forest' }] }] },
      }] },
    };
    const grading: ColorGradingDocument = { format_version: '1.21.40', 'minecraft:color_grading_settings': { description: { identifier: 'test:grade' }, color_grading: { midtones: { gain: [1, 1, 1] } } } };
    const music: MusicDefinitionsDocument = { 'music.test': { event_name: 'test.theme', min_delay: 20 } };
    const sounds: SoundDefinitionsDocument = { format_version: '1.14.0', sound_definitions: { 'test.theme': { subtitle: 'sound.test.theme', sounds: ['sounds/test/theme'] } } };
    const setVariant: LootFunction = { function: 'set_data', data: 2 };
    const reward: LootTableDocument = { pools: [{ rolls: 1, entries: [{ type: 'item', name: 'minecraft:book', functions: [{
      function: 'enchant_book_for_trading', enchantments: [{ name: 'sharpness', min: 1, max: 5 }],
    }] }] }] };
    const emptyPool: LootTableDocument = { pools: [{}] };
    const absentEntries: NonNullable<LootTableDocument['pools']>[number]['entries'] = undefined;
    const item: ItemComponents = {
      'minecraft:piercing_weapon': { reach: { min: 0, max: 4 } }, 'minecraft:swing_sounds': { attack_hit: 'test.hit' },
      'minecraft:fire_resistant': { value: true },
    };
    const trades: TradingDocument = { tiers: [{ groups: [{ trades: [{
      wants: [{ choice: [{ item: 'minecraft:coal', quantity: { min: 3, max: 4 } }] }],
      gives: [{ item: 'minecraft:emerald', functions: [setVariant] }],
    }] }] }] };
    // @ts-expect-error Sensor ranges are numeric pairs.
    const badSensor: EntityComponents = { 'minecraft:entity_sensor': { subsensors: [{ range: [10] }] } };
    // @ts-expect-error Loot functions only accept the extra fields for their corresponding operations.
    const badFunction: LootFunction = { function: 'set_data', amplifier: 1 };
    // @ts-expect-error Enchantment lists belong to the book function.
    const misplacedEnchantments: LootFunction = { function: 'set_count', enchantments: [{ name: 'sharpness', min: 1, max: 5 }] };
    // @ts-expect-error Each enchantment choice requires a name and numeric level bounds.
    const badEnchantment: LootFunction = { function: 'enchant_book_for_trading', enchantments: [{ name: 'sharpness', max: 'five' }] };
    // @ts-expect-error A configured pool requires its entries.
    const incompletePool: LootTableDocument = { pools: [{ rolls: 2 }] };
    // @ts-expect-error Musical event keys must resolve to a sound identifier.
    const badMusic: MusicDefinitionsDocument = { 'music.test': { event_name: 1 } };
    // @ts-expect-error Item attack reach bounds are numeric.
    const badReach: ItemComponents = { 'minecraft:kinetic_weapon': { reach: { max: 'far' } } };
    void [components, spawn, grading, music, sounds, trades, reward, emptyPool, absentEntries, item,
      badSensor, badFunction, misplacedEnchantments, badEnchantment, incompletePool, badMusic, badReach];
  `), []);
});

test('known legacy shapes are typed in the vanilla audit without widening public documents', () => {
  assert.deepEqual(diagnostics(`
    import type { DocumentTypes, EntityDocument, ItemDocument } from '@bedrock-core/bedrock-types';
    import type { CompatibilityDocuments } from './src/audit/compatibility';
    type Audit = CompatibilityDocuments<DocumentTypes>;
    const item: Audit['legacy/bp/items'] = { format_version: '1.16.0', 'minecraft:item': {
      description: { identifier: 'test:food' }, components: { 'minecraft:food': { saturation_modifier: 'good' }, 'minecraft:icon': { texture: 'old_icon' } },
    } };
    const biomes: Audit['legacy/rp/biomes_client'] = { biomes: { default: { water_surface_color: '#3344aa' } } };
    const entity: Audit['vanilla/bp/entities'] = { format_version: '1.12.0', 'minecraft:entity': {
      description: { identifier: 'test:animal' }, events: null,
    } };
    // @ts-expect-error Named saturation is only read by the vanilla audit.
    const publicItem: ItemDocument = item;
    // @ts-expect-error Vanilla null events do not belong in authoring documents.
    const publicEntity: EntityDocument = entity;
    // @ts-expect-error Legacy categories are absent from the public document map.
    type NoPublicLegacyBiome = DocumentTypes['legacy/rp/biomes_client'];
    // @ts-expect-error The audit still validates the shape of legacy fields.
    const invalidBiome: Audit['legacy/rp/biomes_client'] = { biomes: { default: { water_surface_color: true } } };
    void [item, biomes, entity, publicItem, publicEntity, invalidBiome];
  `, ts.ModuleResolutionKind.Bundler), []);
});
