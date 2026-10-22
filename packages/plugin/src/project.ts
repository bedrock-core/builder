/** Resolved build metadata. It contains no profiles, plugins or filesystem paths. */
export interface ProjectMetadata {
  readonly namespace: string;
  readonly name: string;
  readonly description: string;
  readonly authors: readonly string[];
  readonly targetVersion: string;
  readonly packageName?: string;
  readonly version?: string;
  /** Project license identifier or root license text. */
  readonly license?: string;
  /** Project homepage supplied by package metadata. */
  readonly url?: string;
}
