import { core } from '@bedrock-core/server-runtime';
import { world } from '@minecraft/server';
// Both packs need native class bindings used by simulated-player fixtures.
import '@minecraft/server-gametest';
import { back } from '@bedrock-core/navigation';
import { registerNavigation } from '@bedrock-core/navigation/core';
import { navigationSnapshot } from '@fixture/navigation-history';
import { createProbe } from './probe.generated';
import manifest from './provider.manifest.json';

const declaration = registerNavigation();

const playerOf = (id: string) => {
  const player = world.getPlayers().find(candidate => candidate.id === id);

  if (!player) {
    throw new Error('Missing fixture player');
  }

  return player;
};

const { navigation } = core.register({
  manifest,
  navigation: declaration,
  probe: createProbe(
    async id => JSON.stringify(navigationSnapshot(playerOf(id))),
    async id => back(playerOf(id)),
    async () => { core.uninstall(declaration); },
  ),
});

navigation.register({ key: 'provider_ui:detail', kind: 'custom', parameters: { id: { type: 'number' } } },
  (_player, { params }) => params?.id !== 13);
