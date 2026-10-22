import type { PackInfo } from './index.ts';

/** Related local packs required by one owner invocation. */
export interface PackRequirement {
  /** Match at least one declared manifest module type. */
  readonly modules: readonly string[];
  /** Permit no matching dependency. Defaults to false. */
  readonly optional?: boolean;
  /** Accept several dependencies. Defaults to exactly one. */
  readonly multiple?: boolean;
}

/** Pack-processing contract exported as requirements by a native plugin. */
export interface PluginRequirements {
  /** Run once on every pack declaring at least one of these module types. */
  readonly modules: readonly string[];
  /** Named requirements resolved through each owner's direct manifest dependencies. */
  readonly dependencies?: Readonly<Record<string, PackRequirement>>;
}

/** Owner pack ID, requirement name, then selected dependency pack IDs. */
export type PackLinkOverrides = Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>;

/** Related pack descriptors grouped by the plugin's declared requirement names. */
export type LinkedPacks = Readonly<Record<string, readonly PackInfo[]>>;
