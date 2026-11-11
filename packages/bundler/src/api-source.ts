import type { ApiCallShape, ApiDataShape, ApiModule, ApiParametersShape, ApiShape, ApiValueSource } from './api.ts';

/** Bind shared value implementations while keeping ordinary metadata as JSON literals. */
export function apiShapeSource(module: ApiModule['shape'], source: (file: string) => string, prefix = 'apiValues'): { imports: string[]; shape: string } {
  const names = new Map<string, string>();
  const imports: string[] = [];

  const reference = (value: ApiValueSource): string => {
    let name = names.get(value.source);

    if (name === undefined) {
      name = `${prefix}${names.size}`;
      names.set(value.source, name);
      imports.push(`import * as ${name} from ${JSON.stringify(source(value.source))};`);
    }

    return `${name}[${JSON.stringify(value.name)}]`;
  };

  const parameters = (shape: ApiParametersShape): string => `{"items":[${shape.items.map(item => item ? data(item) : 'null').join(',')}]${shape.rest ? `,"rest":${data(shape.rest)}` : ''}}`;
  const call = (shape: ApiCallShape): string => `${shape.parameters ? `,"parameters":${parameters(shape.parameters)}` : ''}${shape.result ? `,"result":${data(shape.result)}` : ''}`;

  const data = (shape: ApiDataShape): string => {
    switch (shape.kind) {
      case 'native-value': return JSON.stringify(shape);
      case 'reference': return shape.reference === 'api'
        ? `{"kind":"reference","reference":"api","contract":${JSON.stringify(shape.contract)},"shape":${value(shape.shape)}${shape.missing ? `,"missing":${JSON.stringify(shape.missing)}` : ''}}`
        : JSON.stringify(shape);
      case 'codec': return `{"kind":"codec","codec":${reference(shape.codec)}.codec}`;
      case 'callback': return `{"kind":"callback"${call(shape)}}`;
      case 'map': return `{"kind":"map"${shape.key ? `,"key":${data(shape.key)}` : ''}${shape.value ? `,"value":${data(shape.value)}` : ''}}`;
      case 'set': return `{"kind":"set","item":${data(shape.item)}}`;
      case 'array': return `{"kind":"array","item":${data(shape.item)}}`;
      case 'tuple': return `{"kind":"tuple",${parameters(shape).slice(1)}`;
      case 'object': return `{"kind":"object","members":{${Object.entries(shape.members).map(([name, value]) => `${JSON.stringify(name)}:${data(value)}`).join(',')}}${shape.index ? `,"index":${data(shape.index)}` : ''}}`;
    }
  };

  const value = (shape: ApiShape): string => {
    switch (shape.kind) {
      case 'value': return JSON.stringify(shape);
      case 'local': return `{"kind":"local","value":${reference(shape.value)}}`;
      case 'function': return `{"kind":"function"${call(shape)}}`;
      case 'state':
      case 'event': return `{"kind":${JSON.stringify(shape.kind)}${shape.data ? `,"data":${data(shape.data)}` : ''}}`;
      case 'object': return `{"kind":"object","members":{${Object.entries(shape.members).map(([name, member]) => `${JSON.stringify(name)}:${value(member)}`).join(',')}}}`;
    }
  };

  const shape = value(module);

  return { imports, shape };
}
