import { Player, world as minecraftWorld } from '@minecraft/server';
// Both packs need the native class bindings used by simulated-player fixtures.
import '@minecraft/server-gametest';
import type { Block, Dimension, Entity, Vector3 } from '@minecraft/server';
import { observable, signal } from '@bedrock-core/observable';
import type { ReadonlyObservable, Signal } from '@bedrock-core/observable';
import { Money } from './values';

export interface DroppedItem {
  entityId: string;
  entity: Entity | undefined;
  itemTypeId: string;
  price: Money;
}

export interface WorldApi {
  readonly afterEvents: { readonly entityDropItem: Signal<DroppedItem> };
  readonly timeOfDay: ReadonlyObservable<number | undefined>;
  readonly tracked: ReadonlyObservable<DroppedItem | undefined>;
  getTime(): Promise<number>;
  setTimeOfDay(value: number): Promise<void>;
  getEntity(id: string): Promise<Entity | undefined>;
  getPlayer(id: string): Promise<Player | undefined>;
  getPlayerId(player: Player): Promise<string>;
  getDimension(id: string): Promise<Dimension>;
  getBlock(dimension: Dimension, location: Vector3): Promise<Block | undefined>;
  describeBlock(block: Block): Promise<{ block: Block; dimension: Dimension; typeId: string }>;
  track(entity: Entity): Promise<void>;
  quote(entity: Entity, price: Money, approve: (entity: Entity, price: Money) => Promise<Money>): Promise<{ entity: Entity; price: Money }>;
  remove(entity: Entity): Promise<void>;
}

const time = observable<number | undefined>(undefined);
const tracked = observable<DroppedItem | undefined>(undefined);
const dropped = signal<DroppedItem>();

export const world: WorldApi = {
  afterEvents: { entityDropItem: dropped },
  timeOfDay: time,
  tracked,
  async getTime() {
    return minecraftWorld.getTimeOfDay();
  },
  async setTimeOfDay(value) {
    minecraftWorld.setTimeOfDay(value);
    time.set(value);
  },
  async getEntity(id) {
    return minecraftWorld.getEntity(id);
  },
  async getPlayer(id) {
    const entity = minecraftWorld.getEntity(id);

    return entity instanceof Player ? entity : undefined;
  },
  async getPlayerId(player) {
    return player.id;
  },
  async getDimension(id) {
    return minecraftWorld.getDimension(id);
  },
  async getBlock(dimension, location) {
    return dimension.getBlock(location);
  },
  async describeBlock(block) {
    return { block, dimension: block.dimension, typeId: block.typeId };
  },
  async track(entity) {
    entity.addTag('api:tracked');
  },
  async quote(entity, price, approve) {
    if (!(price instanceof Money)) {
      throw new TypeError('world quote did not receive Money');
    }

    const accepted = await approve(entity, price);

    if (!(accepted instanceof Money)) {
      throw new TypeError('world callback did not return Money');
    }

    const event = { entityId: entity.id, entity, itemTypeId: 'minecraft:stone', price: accepted };

    tracked.set(event);
    dropped.emit(event);

    return { entity, price: accepted };
  },
  async remove(entity) {
    const event = { entityId: entity.id, entity, itemTypeId: 'minecraft:stone', price: new Money(0) };

    tracked.set(event);
    dropped.emit(event);
    entity.remove();
  },
};
