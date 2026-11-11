import type { ContainerSlot, Entity } from '@minecraft/server';

export declare function compiledSlot(entity: Entity, index: number): ContainerSlot;
export declare function compiledOptional(entity: Entity | undefined, index: number): ContainerSlot | undefined;
export declare function compiledBound(entity: Entity, index: number): ContainerSlot;
export declare function compiledDestructured(entity: Entity, index: number): ContainerSlot;
export declare function compiledArgumentOrder(entity: Entity, counter: { value: number }): ContainerSlot;
export declare function compiledSetContainer(owner: { container: unknown }, value: unknown): unknown;
export declare function compiledMutations(owner: { container?: number }): { previous: number; removed: boolean };
export declare function compiledParenthesized(entity: Entity | undefined, index: number): ContainerSlot;
export declare function compiledOptionalParenthesized(entity: Entity | undefined, counter: { value: number }): ContainerSlot | undefined;
export declare function compiledDelete(owner: { getComponent(id: string): { container?: unknown } | undefined }): boolean;
