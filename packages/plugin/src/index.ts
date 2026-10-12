import type { Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { glob, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectMetadata } from './project.ts';
export { resolveNamespace, type AddonIdentity, type ProjectMetadata } from './project.ts';

/** Manifest classification supplied by the host for the current pack. */
export interface PackInfo {
  /** Configured identity; pack names carry no type meaning. */
  readonly id: string;
  /** Absolute staged directory, or published directory in a build result. */
  readonly path: string;
  /** Selected profile's export destination; supplied by the builder host. */
  readonly outputPath?: string;
  /** Classification from manifest module types. */
  readonly kind: 'behavior' | 'resource' | 'other';
  /** Module types declared by the current manifest. */
  readonly moduleTypes: readonly string[];
  /** Native header identity; absent in descriptors supplied by older standalone callers. */
  readonly uuid?: string;
  /** Resolved native pack version. */
  readonly version?: string;
  /** Current manifest, including module UUIDs and entry paths. */
  readonly manifest?: Readonly<Record<string, unknown>>;
  /** Requirements classified against the complete configured pack set. */
  readonly dependencies?: readonly PackDependency[];
}

/** Native requirement, with local UUIDs resolved to project pack IDs. */
export type PackDependency
  = | { readonly kind: 'local'; readonly packId: string; readonly uuid: string; readonly version: string }
    | { readonly kind: 'external'; readonly uuid: string; readonly version: string }
    | { readonly kind: 'module'; readonly moduleName: string; readonly version: string };

/** Pack IDs intersected with an any-of manifest module selection. */
export interface PackSelector {
  /** Configured pack IDs; unknown IDs fail rather than silently selecting nothing. */
  readonly packs?: readonly string[];
  /** Select a pack declaring at least one of these module types. */
  readonly modules?: readonly string[];
}

export { describePack, resolvePackGraph, inspectPack, inspectPacks, selectPacks, resolvePackOwner, resolveResourcePack, resolveFeaturePacks, type FeatureRouting } from './packs.ts';

/** Indentation for generated JSON. */
export interface JsonFormatting {
  /** Indentation character; defaults to spaces. */
  indent?: 'space' | 'tab';
  /** Characters per level; defaults to two spaces or one tab. */
  size?: number;
}

/** Registered staged file. Its temporary path expires after the build. */
export interface Artifact {
  /** Build-wide identifier; include pack identity for per-pack outputs. */
  readonly id: string;
  /** Absolute existing file within the temporary workspace. */
  readonly path: string;
  /** Invocation that registered the artifact. */
  readonly owner: string;
  /** Import specifier handed to downstream compilers. */
  readonly importAs?: string;
  /** Pack receiving the unqualified import; other packs use importAs/packId. */
  readonly pack?: string;
}

/** Deterministic output accepted by the host's file cache. */
export interface CacheOutput<T> {
  /** Restored data; must contain only JSON-serializable values. */
  value: T;
  /** Additional files and resolution candidates discovered during execution. */
  inputs?: readonly string[];
  /** Existing emitted files inside staging roots to restore on a cache hit. */
  files?: readonly string[];
  /** False when execution discovers inputs that cannot be tracked. */
  cache?: boolean;
}

/** Inputs and execution for one invocation-scoped cache entry. */
export interface CacheOptions<T> {
  /** Absolute input paths; missing resolution candidates may also be tracked. */
  inputs: readonly string[];
  /** JSON-compatible implementation version, options and other non-file inputs. */
  key?: unknown;
  /** False forces execution and prevents reuse. */
  cache?: boolean;
  /** Execute on a miss. Cancellation or failure prevents publication. */
  run: () => CacheOutput<T> | Promise<CacheOutput<T>>;
}

/** Restored or executed cache value and its observed files. */
export interface CacheResult<T> {
  /** Execution result, copied from JSON on a hit. */
  value: T;
  /** Whether the host verified and restored an existing record. */
  cached: boolean;
  /** Absolute observed inputs. */
  inputs: string[];
  /** Absolute emitted files. */
  files: string[];
}

/** Feature-owned contributions to subsequent runtime script bundling. */
export interface BundleExtension {
  /** Build-wide namespaced identity; duplicate registrations fail. */
  readonly id: string;
  /** Stable implementation/settings fingerprint included in bundle cache keys. */
  readonly version: string;
  /** Pack IDs receiving this extension; omission applies to all packs. */
  readonly packs?: readonly string[];
  /** Source files and resolution candidates that invalidate bundle reuse. */
  readonly inputs?: readonly string[];
  /** esbuild plugins, applied in registration order before the host resolver. */
  readonly plugins?: readonly Plugin[];
  /** Package supplying the automatic JSX runtime; conflicting values fail. */
  readonly jsxImportSource?: string;
  /** Import prefixes resolved from the authored dependency root first. */
  readonly resolveFromProject?: readonly string[];
  /** Opt into cache reuse when every plugin input is declared or tracked by its hooks. Defaults to false. */
  readonly cache?: boolean;
}

/** Services shared by built-in and external trusted Node plugins. */
export interface BuildContext {
  /** Absolute directory containing the authored configuration. */
  readonly projectRoot: string;
  /** Configured project namespace. */
  readonly namespace: string;
  /** Shared package and display metadata; absent in standalone adapter hosts. */
  readonly project?: ProjectMetadata;
  /** Temporary project copy; apply pack edits here. */
  readonly stagedRoot: string;
  /** Temporary directory for generated intermediates. */
  readonly generatedDir: string;
  /** Current import specifiers mapped to registered artifact IDs. */
  readonly generatedImports: Readonly<Record<string, string>>;
  /** Global imports plus the selected pack's unqualified generated imports. */
  generatedImportsFor?(pack: string): Readonly<Record<string, string>>;
  /** Whether the profile enables verified output reuse. */
  readonly cache: boolean;
  /** Pack IDs mapped to staged directories; targeted invocations expose one pack. */
  readonly packs: Readonly<Record<string, string>>;
  /** All configured staged directories, including destinations outside a targeted invocation. */
  readonly allPacks?: Readonly<Record<string, string>>;
  /** Current pack for a targeted invocation. */
  readonly pack?: PackInfo;
  /** Absolute export destinations, restricted for targeted invocations. */
  readonly outputPaths: Readonly<Record<string, string>>;
  /** Selected profile. */
  readonly profile: string;
  /** Build output sink. */
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
  /** Extensions already registered in this build, in execution order. */
  readonly bundleExtensions: readonly BundleExtension[];
  /** Track an authored input; relative paths resolve from projectRoot. */
  registerDependency(file: string): void;
  /** Omit a staged pack input from publication after all consumers finish; pack roots are rejected. */
  excludeFromExport?(file: string): void;
  /** Non-template source directories reserved by participating producers. */
  readonly inputDirectories?: readonly string[];
  /** Register an existing staged file; duplicate IDs/import names fail. */
  registerArtifact(id: string, file: string, options?: { importAs?: string; pack?: string }): Promise<void>;
  /** Read an earlier artifact; missing IDs fail. */
  artifact(id: string): Artifact;
  /** Read a configured pack's current staged manifest. */
  inspectPack(id: string): Promise<PackInfo>;
  /** Read the complete current pack graph, resolving local requirements by header UUID. */
  inspectPacks?(): Promise<readonly PackInfo[]>;
  /** Reuse output under an invocation-scoped ID, tracking dependencies on hits and misses. */
  reuse<T>(id: string, options: CacheOptions<T>): Promise<CacheResult<T>>;
  /** Register a bundling contribution before its consumer runs. Targeted invocations default to their current pack. */
  registerBundleExtension(extension: BundleExtension): void;
}

/** Result of optional input detection in the current staged workspace. */
export interface BuildDetection {
  /** Whether automatic execution should participate. */
  needed: boolean;
  /** Human-readable explanation used in build logs. */
  reason: string;
}

/** Optional execution report used by the host. */
export interface BuildStepResult {
  /** Whether all outputs were restored from verified cache entries. */
  cached?: boolean;
  /** Human-readable execution explanation. */
  reason?: string;
}

/** Sequential operation; throwing or rejecting prevents the build's export. */
export type BuildStep = (
  context: BuildContext,
  settings: Record<string, unknown>,
) => void | BuildStepResult | Promise<void | BuildStepResult>;

/** Module contract used for both built-in and external plugins. */
export interface BuildPlugin {
  /** Declare non-template pack input directories without evaluating their content. */
  inputDirectories?: (context: BuildContext, settings: Record<string, unknown>) => readonly string[] | Promise<readonly string[]>;
  /** Apply settings to the staged workspace. */
  run: BuildStep;
  /** Probe inputs without evaluating resource modules. Used only in auto mode. */
  detect?: (context: BuildContext, settings: Record<string, unknown>) => BuildDetection | Promise<BuildDetection>;
}

/** Resolve generated imports and explicit overrides to their current artifact files. */
export function generatedAliases(context: BuildContext, mappings: Record<string, string> = {}, pack = context.pack?.id): Record<string, string> {
  const imports = pack && context.generatedImportsFor ? context.generatedImportsFor(pack) : context.generatedImports;

  return Object.fromEntries(
    Object.entries({ ...imports, ...mappings }).map(([specifier, id]) => [specifier, context.artifact(id).path]),
  );
}

/** Check whether glob patterns select a regular file, without loading its module. */
export async function hasFiles(root: string, patterns: string | string[], exclude: string[] = []): Promise<boolean> {
  for await (const file of glob(patterns, { cwd: root, exclude })) {
    if ((await stat(path.resolve(root, file))).isFile()) {
      return true;
    }
  }

  return false;
}

/** Hash explicit implementation files in order. Use package-local URLs for portable release fingerprints. */
export async function fingerprint(files: readonly (string | URL)[]): Promise<string> {
  const hash = createHash('sha256');

  for (const file of files) {
    hash.update(await readFile(file));
  }

  return hash.digest('hex');
}
