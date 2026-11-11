import { core } from '@bedrock-core/server-runtime';
import { system, world, type ContainerSlot, type Entity } from '@minecraft/server';
import * as authored from './authored';
import * as baseline from './baseline';
import { nativeAccess } from './runtime';

const variants: Record<string, (entity: Entity, index: number) => ContainerSlot | undefined> = {
  slot: authored.slot,
  bound: authored.bound,
  borrowed: authored.borrowed,
  namespace: (owner, index) => authored.namespaceSlot(owner.id, index),
  destructured: authored.destructured,
  library: authored.fromLibrary,
  dependency: authored.fromDependency,
  javascript: authored.compiledSlot,
  javascript_optional: (owner, index) => authored.compiledOptional(owner, index),
  javascript_bound: authored.compiledBound,
  javascript_destructured: authored.compiledDestructured,
  javascript_parenthesized: authored.compiledParenthesized,
  javascript_optional_parenthesized: (owner, index) => authored.compiledOptionalParenthesized(owner, { value: index }),
  commonjs: authored.compiledCjs,
  erased: authored.erasedParameter,
  erased_bound: authored.erasedBound,
  rebound: authored.rebound,
  optional: (owner, index) => authored.optional(owner, { value: index }),
  optional_bound: authored.optionalBound,
  optional_method: authored.optionalMethod,
  parenthesized_method: authored.parenthesizedMethod,
  parenthesized_optional: (owner, index) => authored.parenthesizedOptional(owner, { value: index }),
  parenthesized_required: (owner, index) => authored.parenthesizedRequired(owner, { value: index }),
  callback: authored.callback,
};

function entity(id: string) {
  const found = world.getEntity(id);

  if (!found?.isValid) {
    throw new Error('fixture entity unavailable');
  }

  return found;
}

export async function create(x: number, y: number, z: number, label: string): Promise<string> {
  if (core.namespace !== 'native_access_provider') {
    throw new Error('native-access-owner-code-ran-in-consumer');
  }

  return authored.create({ x, y, z }, label).id;
}

export async function blockSlot(x: number, y: number, z: number, index: number): Promise<string> {
  const block = world.getDimension('overworld').getBlock({ x, y, z });

  if (!block) {
    throw new Error('block is unavailable');
  }

  return JSON.stringify(nativeAccess.encode(authored.blockSlot(block, index)));
}

export async function scheduleStop(): Promise<void> {
  system.runTimeout(() => {
    core.stop();
    system.sendScriptEvent('native_access:provider_stopped', JSON.stringify({ registered: core.registered }));
  }, 5);
}

export async function slot(id: string, index: number, variant = 'slot'): Promise<string> {
  const owner = entity(id);

  if (variant === 'native_callback') {
    for (let attempt = 0; attempt < 20; attempt++) {
      const captured = authored.nativeCallback(owner);

      if (captured) {
        return JSON.stringify(nativeAccess.encode(captured));
      }

      await new Promise<void>(resolve => system.run(resolve));
    }

    throw new Error('native spawn callback did not capture its slot');
  }

  const value = (variants[variant] ?? authored.slot)(owner, index);

  try {
    return JSON.stringify(nativeAccess.encode(value));
  } catch (error) {
    throw new Error(`${variant}: ${String(error)}`, { cause: error });
  }
}

export async function write(id: string, index: number, typeId: string, amount: number): Promise<void> {
  authored.write(entity(id), index, typeId, amount);
}

export async function snapshot(id: string, index: number): Promise<string> {
  return JSON.stringify(authored.snapshot(entity(id), index));
}

export async function rawSnapshot(id: string, index: number): Promise<string> {
  try {
    return JSON.stringify(nativeAccess.encode(authored.rawSnapshot(entity(id), index)));
  } catch (error) {
    return String(error);
  }
}

export async function echo(recipe: string): Promise<string> {
  return JSON.stringify(nativeAccess.encode(nativeAccess.decode(JSON.parse(recipe))));
}

export async function remove(id: string): Promise<void> {
  authored.remove(entity(id));
}

export async function measure(id: string, loops: number, tracked: boolean): Promise<number> {
  const owner = entity(id);
  const run = tracked ? authored.slot : baseline.slot;
  const start = Date.now();

  for (let index = 0; index < loops; index++) {
    run(owner, index % 9);
  }

  return Date.now() - start;
}
