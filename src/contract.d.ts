import type { PackInfo } from './packs.ts';
import type { StageName } from './config.ts';
import type { ContentValidationResult } from '@bedrock-core/builder-validation';

export interface Artifact {
  readonly id: string;
  readonly path: string;
  readonly owner: string;
  readonly importAs?: string;
}
export interface BuildContext {
  readonly projectRoot: string;
  readonly namespace: string;
  readonly stagedRoot: string;
  readonly generatedDir: string;
  readonly generatedImports: Readonly<Record<string, string>>;
  readonly cache: boolean;
  readonly packs: Readonly<Record<string, string>>;
  readonly pack?: PackInfo;
  readonly outputPaths: Readonly<Record<string, string>>;
  readonly profile: string;
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  readonly signal?: AbortSignal;
  registerDependency(path: string): void;
  registerArtifact(id: string, path: string, options?: { importAs?: string }): Promise<void>;
  artifact(id: string): Artifact;
  inspectPack(id: string): Promise<PackInfo>;
}
export interface BuildStepResult {
  cached?: boolean;
  reason?: string;
}
export type BuildStep = (
  context: BuildContext,
  settings: Record<string, unknown>,
) => void | BuildStepResult | Promise<void | BuildStepResult>;
export interface BuildPlugin {
  run: BuildStep;
}
export interface BuildOptions {
  configPath?: string;
  profile?: string;
  stages?: Record<string, BuildStep>;
  signal?: AbortSignal;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  validateArtifacts?: (context: BuildContext) => void | Promise<void>;
}
export interface BuildResult {
  readonly validation: ContentValidationResult;
  readonly outputPaths: Readonly<Record<string, string>>;
  readonly profile: string;
  readonly stages: { stage: StageName; status: 'executed' | 'skipped' | 'cached'; reason?: string }[];
  readonly dependencies: string[];
  readonly compilations: { id: string; status: 'executed' | 'cached' }[];
  readonly artifacts: Pick<Artifact, 'id' | 'owner' | 'importAs'>[];
  readonly packs: PackInfo[];
}
export function runBuild(options: BuildOptions): Promise<BuildResult>;
