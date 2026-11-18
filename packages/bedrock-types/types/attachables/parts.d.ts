import type { AttachableDocument } from './document';

export type AttachableDefinition = AttachableDocument['minecraft:attachable'];
export type AttachableDescription = NonNullable<AttachableDefinition['description']>;
export type AttachableScripts = NonNullable<AttachableDescription['scripts']>;
