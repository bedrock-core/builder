import { ItemStack } from '@minecraft/server';
import { register, type Test } from '@minecraft/server-gametest';
import guides from '@bedrock-core/generated/guides/logic';
import translations from '@bedrock-core/generated/i18n';
import loot from '../loot_tables/drop.json';

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

check('generated_imports_resolve', (test) => {
  test.assert(loot.pools[0].entries[0].name === 'minecraft:apple', 'Imported generated loot data must match its template');
  test.assert(guides.pages.start !== undefined, 'The generated guide manifest must contain its page');
  test.assert(translations.namespace === 'builder_acceptance', 'Translations must use the project namespace');
  test.assert(translations.locales.en_US !== undefined, 'English translations must be bundled');
  test.assert(translations.locales.es_ES !== undefined, 'Spanish translations must be bundled');
  test.succeed();
});
