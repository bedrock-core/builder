import type { StageName } from '../config.ts';
import type { PackInfo } from '../packs.ts';

/** Known built-in filter implementation accepted by configuration conversion. */
export type FilterKind = StageName | 'core';

/** Configuration conversion issue with a stable code and JSON pointer. */
export interface MigrationDiagnostic {
  /** Errors prevent writing; warnings allow a ready preview. */
  severity: 'error' | 'warning';
  /** Stable issue identifier. */
  code: string;
  /** JSON pointer into the source configuration. */
  path: string;
  /** Actionable explanation of the conversion issue. */
  message: string;
}

/** Explicit metadata, profile, filter and destination mappings for Regolith configuration conversion. */
export interface MigrationOptions {
  /** Supply a missing project namespace. */
  namespace?: string;
  /** Supply a missing target Minecraft version. */
  targetVersion?: string;
  /** Profile names to convert; omission selects all profiles. */
  profiles?: string[];
  /** Exact destination overrides keyed by profile and configured pack ID. */
  exports?: Record<string, Record<string, string>>;
  /** Explicit mappings for verified local filters or forks; no module is executed. */
  filters?: Record<string, FilterKind>;
  /** Explicit classification for packs whose type cannot be inferred. */
  packKinds?: Record<string, PackInfo['kind']>;
  /** Editor schema reference inserted into the converted config. */
  schema?: string;
}

/** Configuration preview and diagnostics; ready means no error diagnostics remain. */
export interface MigrationResult {
  /** Converted configuration preview, including preserved unrelated metadata. */
  config: Record<string, unknown>;
  /** All conversion issues. */
  diagnostics: MigrationDiagnostic[];
  /** True when no error diagnostics remain. */
  ready: boolean;
}

export type ReportDiagnostic = (code: string, location: string, message: string, severity?: 'error' | 'warning') => void;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
