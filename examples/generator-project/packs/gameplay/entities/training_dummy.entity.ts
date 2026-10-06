export default {
  'format_version': '1.21.0',
  'minecraft:entity': {
    description: { identifier: 'builder_generator:training_dummy', is_summonable: true },
    components: {
      'minecraft:health': { value: 20, max: 20 },
      'minecraft:physics': {},
    },
  },
} satisfies Entity;
