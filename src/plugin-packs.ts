import type { PackInfo, PluginRequirements, PackLinkOverrides, LinkedPacks } from '@bedrock-core/builder-plugin';

/** One eligible owner and its resolved, writable project pack set. */
interface PluginPackInvocation {
  readonly pack: PackInfo;
  readonly linkedPacks: LinkedPacks;
  readonly packs: readonly PackInfo[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function moduleList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0
    && value.every(item => typeof item === 'string' && !!item.trim()) && new Set(value).size === value.length;
}

/** Resolve eligible owners and typed direct dependencies before any invocation executes. */
export function resolvePluginPacks(
  packs: readonly PackInfo[], requirements: PluginRequirements,
  only?: readonly string[], overrides: PackLinkOverrides = {},
): readonly PluginPackInvocation[] {
  if (!record(requirements) || !moduleList(requirements.modules)
    || Object.keys(requirements).some(key => key !== 'modules' && key !== 'dependencies')
    || (requirements.dependencies !== undefined && !record(requirements.dependencies))) {
    throw new Error('Plugin requirements must declare a nonempty modules list and optional dependencies');
  }

  const dependencies = requirements.dependencies ?? {};

  for (const [name, requirement] of Object.entries(dependencies)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || !record(requirement) || !moduleList(requirement.modules)
      || Object.keys(requirement).some(key => !['modules', 'optional', 'multiple'].includes(key))
      || (requirement.optional !== undefined && typeof requirement.optional !== 'boolean')
      || (requirement.multiple !== undefined && typeof requirement.multiple !== 'boolean')) {
      throw new Error(`Invalid plugin dependency requirement: ${name}`);
    }
  }

  if (only !== undefined && (!Array.isArray(only) || !only.length
    || only.some(id => typeof id !== 'string' || !id.trim()) || new Set(only).size !== only.length)) {
    throw new Error('Plugin owner selection must contain distinct configured pack IDs');
  }

  const eligible = packs.filter(pack => requirements.modules.some(type => pack.moduleTypes.includes(type)));

  for (const id of only ?? []) {
    const pack = packs.find(pack => pack.id === id);

    if (!pack) {
      throw new Error(`Plugin owner is not a configured pack: ${id}`);
    }

    if (!eligible.includes(pack)) {
      throw new Error(`Plugin owner ${id} must declare one of these module types: ${requirements.modules.join(', ')}`);
    }
  }

  if (!record(overrides)) {
    throw new Error('Plugin links must map owner IDs to dependency selections');
  }

  for (const [owner, links] of Object.entries(overrides)) {
    if (!eligible.some(pack => pack.id === owner)) {
      throw new Error(`Plugin links reference an unknown or incompatible owner: ${owner}`);
    }

    if (!record(links)) {
      throw new Error(`Plugin links for ${owner} must be an object`);
    }

    for (const name of Object.keys(links)) {
      if (!Object.hasOwn(dependencies, name)) {
        throw new Error(`Pack ${owner} overrides undeclared plugin dependency: ${name}`);
      }
    }
  }

  return Object.freeze(eligible.filter(pack => !only || only.includes(pack.id)).map((owner) => {
    const direct = new Set((owner.dependencies ?? []).flatMap(dependency => dependency.kind === 'local' ? [dependency.packId] : []));
    const linked = Object.fromEntries(Object.entries(dependencies).map(([name, requirement]) => {
      const candidates = packs.filter(pack => direct.has(pack.id) && requirement.modules.some(type => pack.moduleTypes.includes(type)));
      const override = overrides[owner.id]?.[name];
      let selected = candidates;

      if (override !== undefined) {
        const ids = typeof override === 'string' ? [override] : override;

        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
          throw new Error(`Pack ${owner.id} dependency ${name} override must contain distinct pack IDs`);
        }

        selected = ids.map((id) => {
          const target = packs.find(pack => pack.id === id);

          if (!target || !requirement.modules.some(type => target.moduleTypes.includes(type))) {
            throw new Error(`Pack ${owner.id} dependency ${name} needs a configured pack declaring ${requirement.modules.join(' or ')}: ${id}`);
          }

          if (!direct.has(id)) {
            throw new Error(`Pack ${owner.id} must declare a manifest dependency on ${id} for plugin requirement ${name}`);
          }

          return target;
        });
      }

      if ((!requirement.optional && selected.length === 0) || (!requirement.multiple && selected.length > 1)) {
        const count = requirement.multiple ? 'one or more' : requirement.optional ? 'at most one' : 'exactly one';

        throw new Error(`Pack ${owner.id} plugin dependency ${name} requires ${count} linked pack declaring ${requirement.modules.join(' or ')}; direct local candidates: ${candidates.map(pack => pack.id).join(', ') || 'none'}. Select links.${owner.id}.${name} explicitly or correct its manifest dependencies.`);
      }

      return [name, Object.freeze(selected)];
    }));
    const participating = new Map([owner, ...Object.values(linked).flat()].map(pack => [pack.id, pack]));

    return Object.freeze({ pack: owner, linkedPacks: Object.freeze(linked), packs: Object.freeze([...participating.values()]) });
  }));
}
