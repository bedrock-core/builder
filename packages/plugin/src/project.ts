/** Stable identifiers for registration with @bedrock-core/server. */
export interface AddonIdentity {
  creator: string;
  pack: string;
}

/** Resolved build metadata. It contains no profiles, plugins or filesystem paths. */
export interface ProjectMetadata {
  readonly namespace: string;
  readonly name: string;
  readonly description: string;
  readonly authors: readonly string[];
  readonly targetVersion: string;
  readonly packageName?: string;
  readonly version?: string;
  readonly addon?: Readonly<AddonIdentity>;
}

/** Derive a namespace from stable identity; explicit namespaces must agree. */
export function resolveNamespace(namespace?: string, addon?: AddonIdentity): string {
  if (addon && (!/^[a-z0-9_]+$/.test(addon.creator) || !/^[a-z0-9_]+$/.test(addon.pack))) {
    throw new Error('Addon creator and pack must be lowercase identifier segments');
  }

  const derived = addon && `${addon.creator}_${addon.pack}`;

  if (namespace !== undefined && derived !== undefined && namespace !== derived) {
    throw new Error(`namespace must match addon identity: ${derived}`);
  }

  const resolved = namespace ?? derived;

  if (!resolved || !/^[a-z0-9_]+$/.test(resolved) || resolved === 'minecraft') {
    throw new Error('Provide namespace or bedrockCore.addon with a valid Minecraft namespace');
  }

  return resolved;
}
