import { core, registerModule } from '@bedrock-core/server-runtime';
import { API } from '../api/index';
import { math } from '../api/math';
import manifest from '../manifest.json';

core.register({ manifest, providerApi: registerModule(API), math: registerModule(math) });
