import { registerGuides } from '@bedrock-core/guides';
import { core } from '@bedrock-core/server';
import { i18n } from '../i18n';
import manifest from '../manifest.json';

export const { guides: guide } = core.register({ manifest, guides: registerGuides() });
export const title = i18n.resolve('example_guides.guides.intro.title');
