import type { DeployedPack } from './deploy.ts';
import type { PackInfo } from './packs.ts';

export interface Artifact {
  readonly id: string;
  readonly path: string;
  readonly owner: string;
}
export interface BuildContext {
  readonly projectRoot: string;
  readonly stagedRoot: string;
  readonly generatedDir: string;
  readonly packs: Readonly<Record<string, string>>;
  readonly outputPath: string;
  readonly profile: string;
  readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  readonly signal?: AbortSignal;
  registerDependency(path: string): void;
  registerArtifact(id: string, path: string): Promise<void>;
  artifact(id: string): Artifact;
  inspectPack(id: string): Promise<PackInfo>;
}
export type BuildStep = (
  context: BuildContext,
  settings: Record<string, unknown>,
) => void | Promise<void>;
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
  readonly outputPath: string;
  readonly profile: string;
  readonly dependencies: string[];
  readonly artifacts: Pick<Artifact, 'id' | 'owner'>[];
  readonly packs: PackInfo[];
  readonly deployments: DeployedPack[];
}
export function runBuild(options: BuildOptions): Promise<BuildResult>;
