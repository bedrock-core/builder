import { core } from '@bedrock-core/server-runtime';
import { navigateAsync } from '@bedrock-core/navigation';
import { navigation, registerNavigation } from '@bedrock-core/navigation/core';
import { navigationSnapshot } from '@fixture/navigation-history';
import { system } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import { createProbe } from './probe.generated';
import manifest from './consumer.manifest.json';

const { navigation: destinations } = core.register({ manifest, navigation: registerNavigation() });
const probe = core.api.createModule('navigation_provider', createProbe(async () => '', async () => false, async () => {}).api);
const wait = (ticks = 4): Promise<void> => new Promise(resolve => system.runTimeout(resolve, ticks));
const state = { key: 'catalog', type: 'stack' as const, stale: false as const, index: 1, routeNames: ['home', 'detail'],
  routes: [{ key: 'catalog/home:0', name: 'home' }, { key: 'catalog/detail:1', name: 'detail' }] };

destinations.register({ key: 'consumer_ui:home', kind: 'custom', parameters: { id: { type: 'number' } } }, () => true);

async function routing(test: Test): Promise<void> {
  const player = test.spawnSimulatedPlayer({ x: 2, y: 2, z: 2 }, 'NavigationApi');

  try {
    for (let attempt = 0; attempt < 30 && !destinations.screens.get('provider_ui:detail'); attempt++) {
      await wait();
    }

    test.assert(navigation(core) === destinations, 'Explicit and lazy installation share the same service');
    test.assert(destinations.screens.get('provider_ui:detail')?.owner === 'navigation_provider', 'Discovery uses the publishing owner rather than the UI namespace');
    test.assert(await navigateAsync('consumer_ui:home', player, { params: { id: 7 }, checkpoint: { navigatorStates: { catalog: state } } }), 'Local entry accepts');
    const before = JSON.stringify(navigationSnapshot(player));

    test.assert(!await navigateAsync('provider_ui:detail', player, { params: { id: 13 } }), 'Remote owner rejects the requested destination');
    test.assert(JSON.stringify(navigationSnapshot(player)) === before, 'Rejected handoff retains source history and checkpoint');
    test.assert(await navigateAsync('provider_ui:detail', player, { params: { id: 9 } }), 'Generated navigation API accepts a cross-realm handoff');
    test.assert(JSON.stringify(navigationSnapshot(player)) === '{"history":[]}', 'Accepted handoff clears the source destination');
    const remote = JSON.parse(await probe.snapshot(player.id));

    test.assert(remote.current.key === 'provider_ui:detail' && remote.current.params.id === 9, 'Destination parameters reach the receiving realm');
    test.assert(remote.history[0].key === 'consumer_ui:home' && JSON.stringify(remote.history[0].navigatorStates.catalog) === JSON.stringify(state), 'Complete source checkpoint crosses the generated JSON contract');
    test.assert(await probe.goBack(player.id), 'Back accepts the return handoff');

    for (let attempt = 0; attempt < 30 && JSON.stringify(navigationSnapshot(player)) !== before; attempt++) {
      await wait();
    }

    test.assert(JSON.stringify(navigationSnapshot(player)) === before, 'Back restores the original destination and navigator state');
    let returned = await probe.snapshot(player.id);

    for (let attempt = 0; attempt < 30 && returned !== '{"history":[]}'; attempt++) {
      await wait();
      returned = await probe.snapshot(player.id);
    }

    test.assert(returned === '{"history":[]}', 'Return acknowledgement clears the former destination realm');
    await probe.stopNavigation();

    for (let attempt = 0; attempt < 30 && destinations.screens.get('provider_ui:detail'); attempt++) {
      await wait();
    }

    test.assert(destinations.screens.get('provider_ui:detail') === undefined, 'Stopping the owner declaration withdraws navigation discovery');
    test.assert(await probe.snapshot(player.id) === '{"history":[]}', 'Stopping navigation preserves the owner Runtime and its other API');
  } finally {
    player.disconnect();
  }
}

register('navigation_api', 'routing', (test) => {
  void routing(test).then(() => test.succeed()).catch((error: unknown) => test.fail(String(error)));
}).structureName('navigation_api:empty').tag('navigation_api').maxTicks(600);
