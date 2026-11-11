import { registerModule, type ModuleDeclaration } from '@bedrock-core/server-runtime';

export interface Probe {
  snapshot(playerId: string): Promise<string>;
  goBack(playerId: string): Promise<boolean>;
  stopNavigation(): Promise<void>;
}

export function createProbe(
  snapshot: Probe['snapshot'],
  goBack: Probe['goBack'],
  stopNavigation: Probe['stopNavigation'],
): ModuleDeclaration<Probe> {
  const API: Probe = { snapshot, goBack, stopNavigation };

  return registerModule(API);
}
