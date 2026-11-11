import { ItemStack } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import { registerGuides } from '@bedrock-core/guides';
import { navigation } from '@bedrock-core/navigation/core';
import { core } from '@bedrock-core/server';
import { i18n } from '../i18n';
import loot from '../loot_tables/drop.json';
import manifest from '../manifest.json';

const { guides } = core.register({ manifest, guides: registerGuides({ commands: false }) });

function check(name: string, run: (test: Test) => void): void {
  register('builder_acceptance', name, run)
    .structureName('builder_acceptance:empty')
    .tag('builder_acceptance')
    .maxTicks(80);
}

check('generated_item_loads', (test) => {
  const item = new ItemStack('builder_acceptance:token');

  test.assert(item.typeId === 'builder_acceptance:token', 'Generated item must be registered by the engine');
  test.assert(item.maxAmount === 64, 'Generated component must control the item stack');
  test.succeed();
});

check('compiled_content_resolves', (test) => {
  const screens = navigation(core).screens;

  test.assert(loot.pools[0].entries[0].name === 'minecraft:apple', 'Imported generated loot data must match its template');
  test.assert(typeof guides.open === 'function', 'Core must install the guide app');
  test.assert(screens.find(core.id, 'guide_home') !== undefined, 'The compiled guide entry must be registered');
  test.assert(screens.find(core.id, 'guide_start') !== undefined, 'The compiled guide page must be registered');
  test.assert(i18n.bundle.namespace === manifest.namespace, 'Translations must use the owning manifest namespace');
  test.assert(i18n.forLocale('en_US').t($ => $.accepted) === 'Build accepted', 'English translations must resolve');
  test.assert(i18n.forLocale('es_ES').t($ => $.accepted) === 'Compilación aceptada', 'Spanish translations must resolve');
  test.succeed();
});
