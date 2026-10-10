import type { PackInfo } from './packs.ts';
import type { StageName } from './config.ts';
import type { ContentValidationResult } from '@bedrock-core/builder-validation';

/** Registered staged file with a unique ID and producer owner. Paths expire after the build. */
export interface Artifact {
  /** Build-wide identifier; include the pack ID for per-pack producers. */
  readonly id: string;
  /** Absolute existing file inside the temporary workspace. */
  readonly path: string;
  /** Stage or plugin invocation that registered the file. */
  readonly owner: string;
  /** Optional import specifier resolved by later compiler stages. */
  readonly importAs?: string;
}
/** Trusted plugin and stage access to the current build's temporary workspace. */
export interface BuildContext {
  /** Absolute authored project directory containing config.json. */
  readonly projectRoot: string;
  /** Project namespace from configuration. */
  readonly namespace: string;
  /** Absolute temporary project copy; apply pack edits here. */
  readonly stagedRoot: string;
  /** Absolute temporary directory for generated intermediates. */
  readonly generatedDir: string;
  /** Current import-specifier-to-artifact-path map, including earlier registrations. */
  readonly generatedImports: Readonly<Record<string, string>>;
  /** Whether verified compilation reuse is enabled for the selected profile. */
  readonly cache: boolean;
  /** Pack IDs mapped to staged directories; targeted invocations expose only the current pack. */
  readonly packs: Readonly<Record<string, string>>;
  /** Current manifest-classified pack for a plugin with targets; absent for project-wide steps. */
  readonly pack?: PackInfo;
  /** Absolute export destinations, restricted to the current pack for targeted invocations. */
  readonly outputPaths: Readonly<Record<string, string>>;
  /** Selected profile name. */
  readonly profile: string;
  /** Build output sink; defaults to the caller's logger or console. */
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Cooperative cancellation signal supplied by the caller. */
  readonly signal?: AbortSignal;
  /** Register an authored input for results and subsequent watch rebuilds. */
  registerDependency(path: string): void;
  /** Register an existing staged file; duplicate IDs and conflicting import names fail. */
  registerArtifact(id: string, path: string, options?: { importAs?: string }): Promise<void>;
  /** Look up a previously registered artifact; throws when the ID is missing. */
  artifact(id: string): Artifact;
  /** Read a configured pack's current staged manifest; unknown pack IDs fail. */
  inspectPack(id: string): Promise<PackInfo>;
}
/** Optional stage execution report used by build logs and results. */
export interface BuildStepResult {
  /** Report that this invocation reused verified output. */
  cached?: boolean;
  /** Human-readable explanation of the execution result. */
  reason?: string;
}
/** Sequential trusted Node operation. Throwing or rejecting prevents the whole build's export. */
export type BuildStep = (
  context: BuildContext,
  settings: Record<string, unknown>,
) => void | BuildStepResult | Promise<void | BuildStepResult>;
/** Native module plugin contract; the module exports a named `run` function. */
export interface BuildPlugin {
  /** Apply this invocation's settings to the staged workspace. */
  run: BuildStep;
}
/** Inputs to one build; configuration-relative paths resolve from config.json. */
export interface BuildOptions {
  /** Config file path; defaults to `config.json` in the current working directory. */
  configPath?: string;
  /** Named profile; defaults to `default`. */
  profile?: string;
  /** Replacement implementations keyed by built-in stage name. */
  stages?: Record<string, BuildStep>;
  /** Abort preparation, compilation, plugins or export cooperatively. */
  signal?: AbortSignal;
  /** Progress and diagnostic sink; defaults to console. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Additional final check after artifact checks, before manifest/content validation and export. */
  validateArtifacts?: (context: BuildContext) => void | Promise<void>;
}
/** Successful build report containing durable destinations and IDs, without temporary paths. */
export interface BuildResult {
  /** Final JSON syntax/schema validation coverage. */
  readonly validation: ContentValidationResult;
  /** Pack IDs mapped to their published absolute directories. */
  readonly outputPaths: Readonly<Record<string, string>>;
  /** Profile used for the build. */
  readonly profile: string;
  /** Participating stage statuses and optional explanations. */
  readonly stages: { stage: StageName; status: 'executed' | 'skipped' | 'cached'; reason?: string }[];
  /** Authored inputs observed by stages and registered by plugins. */
  readonly dependencies: string[];
  /** Individual compiler execution and reuse records. */
  readonly compilations: { id: string; status: 'executed' | 'cached' }[];
  /** Artifact identities and owners; workspace file paths are intentionally omitted. */
  readonly artifacts: Pick<Artifact, 'id' | 'owner' | 'importAs'>[];
  /** Final manifest classifications with published pack paths. */
  readonly packs: PackInfo[];
}
/**
 * Build an isolated staged project and publish all packs after successful validation. Plugins execute as trusted Node code. Build failures retain the previous export.
 * @param options Project inputs, settings and optional integrations for this operation.
 * @returns Successful export destinations, validation coverage and execution records.
 * @remarks Plugins and templates execute trusted Node code. Temporary workspace paths expire after cleanup. Additional artifact checks run before final manifest and content validation.
 * @throws If planning, execution, validation, cancellation or publication fails.
 */
export function runBuild(options: BuildOptions): Promise<BuildResult>;
