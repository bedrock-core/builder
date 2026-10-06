import type { StageName } from '../config.ts';
import type { PackInfo } from '../packs.ts';

export type FilterKind = StageName | 'core';

export interface MigrationDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface MigrationOptions {
  namespace?: string;
  targetVersion?: string;
  profiles?: string[];
  exports?: Record<string, Record<string, string>>;
  /** Explicit mappings for verified local filters or forks; no module is executed. */
  filters?: Record<string, FilterKind>;
  packKinds?: Record<string, PackInfo['kind']>;
  schema?: string;
}

export interface MigrationResult {
  config: Record<string, unknown>;
  diagnostics: MigrationDiagnostic[];
  ready: boolean;
}

export type ReportDiagnostic = (code: string, location: string, message: string, severity?: 'error' | 'warning') => void;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
