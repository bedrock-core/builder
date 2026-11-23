import { registerGuides } from '@bedrock-core/guides';
import { core } from '@bedrock-core/server';
import { i18n } from '../i18n';
import loot from '../loot_tables/drop.json';
import manifest from '../manifest.json';

export const { guides } = core.register({ manifest, guides: registerGuides({ commands: false }) });

export { i18n, loot, manifest };
