import type { Artifact, BuildContext, BuildStep, BuildPlugin, PackInfo } from '@bedrock-core/builder-plugin';
import type { StageName } from './config.ts';
import type { ContentValidationResult } from '@bedrock-core/builder-validation';

export type { Artifact, BuildContext, BuildStep, BuildStepResult, BuildPlugin, BuildDetection, BundleExtension, CacheOptions, CacheOutput, CacheResult } from '@bedrock-core/builder-plugin';

/** Inputs to one build; configuration-relative paths resolve from config.json. */
export interface BuildOptions {
  /** Config file path; defaults to `config.json` in the current working directory. */
  configPath?: string;
  /** Named profile; defaults to `default`. */
  profile?: string;
  /** Replacement implementations keyed by built-in stage name. */
  stages?: Record<string, BuildStep | BuildPlugin>;
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
  readonly artifacts: Pick<Artifact, 'id' | 'owner' | 'importAs' | 'pack'>[];
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
