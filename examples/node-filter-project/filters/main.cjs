const fs = require('node:fs');

const settings = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const input = JSON.parse(fs.readFileSync('data/input.json', 'utf8'));

fs.writeFileSync('RP/generated.json', JSON.stringify({ name: settings.name, value: input.value }));
console.log('Generated RP/generated.json');
