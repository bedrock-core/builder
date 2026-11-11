import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as ts from 'typescript-native/ast';
import { isJSDoc, isJSDocOptionalType, isJSDocParameterTag, isJSDocTypeExpression, isParameterDeclaration, isPropertySignatureDeclaration, isStringLiteralLikeNode, isTypeAssertion } from 'typescript-native/ast/is';
import { ElementFlags, ModuleKind, ModuleResolutionKind, SymbolFlags, TypeFlags, type Signature, type Symbol, type TupleTypeReference, type Type, type TypeReference } from 'typescript-native/sync';
import type { Plugin } from 'esbuild';
import { resolveManifest, moduleManifestPath, apiPackageMetadata, scriptOutputManifest } from '@bedrock-core/builder-manifest';
import { apiShapeSource } from './api-source.ts';
import { findConfigFile, moduleResolutionOptions, trackedCompiler } from './typescript.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type ApiValueSource = { source: string; name: string };
export type ApiParametersShape = { items: (ApiDataShape | null)[]; rest?: ApiDataShape };
export type ApiCallShape = { parameters?: ApiParametersShape; result?: ApiDataShape };
export type ApiReferenceShape = (
  | { reference: 'entity' | 'player' | 'dimension' | 'block' | 'entity-component' | 'block-component' | 'container' | 'container-slot'; nativeType?: string }
  | { reference: 'api'; contract: string; shape: Extract<ApiShape, { kind: 'object' }> }
) & { kind: 'reference'; missing?: 'undefined' | 'null' };
export type ApiDataShape
  = | { kind: 'codec'; codec: ApiValueSource }
    | { kind: 'native-value'; value: 'item-stack' | 'block-permutation' }
    | ApiReferenceShape
    | ({ kind: 'callback' } & ApiCallShape)
    | { kind: 'map'; key?: ApiDataShape; value?: ApiDataShape }
    | { kind: 'set'; item: ApiDataShape }
    | { kind: 'array'; item: ApiDataShape }
    | { kind: 'tuple'; items: (ApiDataShape | null)[]; rest?: ApiDataShape }
    | { kind: 'object'; members: Record<string, ApiDataShape>; index?: ApiDataShape };

/** Checked public export kinds and immutable constants used by generated bindings. */
export type ApiShape
  = | ({ kind: 'function' } & ApiCallShape)
    | { kind: 'state' | 'event'; data?: ApiDataShape }
    | { kind: 'local'; value: ApiValueSource }
    | { kind: 'value'; value: Json }
    | { kind: 'object'; members: Record<string, ApiShape> };

/** A package export inspected without importing its implementation. */
export interface ApiModule {
  moduleName: string;
  namespace: string;
  uuid: string;
  source: string;
  declaration?: string;
  consumerView?: boolean;
  shape: ApiShape & { kind: 'object' };
  inputs: string[];
}

export interface ApiLibraryFactory {
  contract: string;
  shape: ApiModule['shape'];
}

interface Package {
  root: string;
  metadata: Record<string, unknown>;
  inputs: Set<string>;
}

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);

  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function readPackage(root: string, name?: string): Package {
  root = path.resolve(root);
  const inputs = new Set<string>([path.join(root, 'package.json')]);
  const require = createRequire(path.join(root, 'package.json'));
  const candidates = name === undefined
    ? [path.join(root, 'package.json')]
    : (require.resolve.paths(name) ?? []).map(directory => path.join(directory, name, 'package.json'));

  for (const candidate of candidates) {
    inputs.add(candidate);
    inputs.add(path.dirname(candidate));

    if (!existsSync(candidate)) {
      continue;
    }

    const file = realpathSync(candidate);

    inputs.add(file);
    const metadata: unknown = JSON.parse(readFileSync(file, 'utf8'));

    if (!record(metadata) || typeof metadata.name !== 'string' || !packageName.test(metadata.name) || (name !== undefined && name !== metadata.name)) {
      throw new Error(`Package ${name ?? root} must declare its exact installed package name in ${file}`);
    }

    return { root: path.dirname(file), metadata, inputs };
  }

  throw new Error(`Package ${name} is not installed for ${root}`);
}

function exportsMap(metadata: Record<string, unknown>): Record<string, unknown> {
  const exports = metadata.exports;

  return record(exports) && Object.keys(exports).some(key => key.startsWith('.')) ? exports : { '.': exports };
}

function target(value: unknown, types: boolean, conditions: readonly string[] = []): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => target(item, types, conditions)).find(item => item !== undefined);
  }

  if (!record(value)) {
    return;
  }

  for (const condition of types ? ['types', ...conditions, 'import', 'default', 'require'] : [...conditions, 'import', 'default', 'require']) {
    const found = target(value[condition], types, conditions);

    if (found !== undefined) {
      return found;
    }
  }
}

function exportedTarget(pkg: Package, subpath: string, types: boolean, conditions: readonly string[] = []): string | undefined {
  const exports = exportsMap(pkg.metadata);
  const value = exports[subpath];

  if (value === undefined) {
    const patterns = Object.keys(exports).filter(key => key.includes('*')).sort((a, b) => b.length - a.length);

    for (const pattern of patterns) {
      const [before, after] = pattern.split('*');

      if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= before.length + after.length) {
        throw new Error(`Core public API exports need explicit package subpaths; replace wildcard ${pattern} with named exports`);
      }
    }
  }

  const selected = target(value, types, conditions);

  if (selected === undefined) {
    return;
  }

  if (!selected.startsWith('./') || !inside(pkg.root, path.resolve(pkg.root, selected))) {
    throw new Error(`Public export ${subpath} must target a file inside ${pkg.root}`);
  }

  const file = path.resolve(pkg.root, selected);
  const stem = /\.[cm]?jsx?$/.test(file) ? file.replace(/\.[cm]?jsx?$/, '') : file;
  const candidates = [file, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}.d.ts`, path.join(file, 'index.ts'), path.join(file, 'index.js')];

  for (const candidate of candidates) {
    pkg.inputs.add(candidate);

    if (existsSync(candidate)) {
      const actual = realpathSync(candidate);

      if (!inside(pkg.root, actual)) {
        throw new Error(`Public export ${subpath} must stay inside ${pkg.root}`);
      }

      pkg.inputs.add(actual);

      return actual;
    }
  }

  throw new Error(`Public export ${subpath} does not exist: ${file}`);
}

async function identity(pkg: Package, moduleName = String(pkg.metadata.name), provider = false): Promise<{ namespace: string; uuid: string } | undefined> {
  const file = moduleManifestPath(pkg.root, pkg.metadata, moduleName, file => pkg.inputs.add(file));

  const resolved = await resolveManifest(file, { root: pkg.root, validate: false });

  for (const input of resolved.inputs) {
    pkg.inputs.add(input);
  }

  const manifest = resolved.manifest;
  const header = manifest.header;
  const scripted = Array.isArray(manifest.modules) && manifest.modules.some(module => record(module) && module.type === 'script');

  if (provider && !scripted) {
    return;
  }

  if (typeof manifest.namespace !== 'string' || !/^[a-z0-9_]+$/.test(manifest.namespace) || manifest.namespace === 'minecraft'
    || !record(header) || typeof header.uuid !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(header.uuid) || !scripted) {
    throw new Error(`Addon package ${String(pkg.metadata.name)} must export a scripted Core manifest with namespace and header.uuid`);
  }

  return { namespace: manifest.namespace, uuid: header.uuid };
}

function inspect(pkg: Package, moduleName: string, source: string, declaration: string, allowTypesOnly = false, projection?: { required: boolean }, factories?: Record<string, ApiLibraryFactory>): ApiModule['shape'] {
  const track = (file: string): void => {
    pkg.inputs.add(file);
  };

  using api = trackedCompiler(track);
  const config = findConfigFile(path.dirname(declaration), track);
  const configured = config && api.parseConfigFile(config);
  const program = api.createProgram([declaration], {
    ...configured && moduleResolutionOptions(configured.options),
    target: ts.ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
    allowJs: true, checkJs: true, strict: true, skipLibCheck: true, types: [], noEmit: true, allowImportingTsExtensions: true, resolveJsonModule: true,
  });
  const checker = program.getProject().checker;
  const file = program.getSourceFile(declaration)!;
  const module = checker.getSymbolAtLocation(file);

  const fail = (member: string, reason: string): never => {
    throw new Error(`External addon API ${moduleName} export ${member}: ${reason}; expose async functions, ReadonlyObservable<T | undefined> state, Signal<T> events, plain objects or immutable JSON constants`);
  };

  const nodeOf = (symbol: Symbol): ts.Node => symbol.valueDeclaration?.resolve() ?? symbol.declarations[0]?.resolve() ?? file;
  const unalias = (symbol: Symbol): Symbol => symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const typeOf = (symbol: Symbol): Type => checker.getTypeOfSymbolAtLocation(symbol, nodeOf(symbol));
  const isClass = (type: Type): boolean => !!type.getSymbol()?.declarations.some(node => node.kind === ts.SyntaxKind.ClassDeclaration || node.kind === ts.SyntaxKind.ClassExpression);
  const unwrap = (node: ts.Expression): ts.Expression => ts.isAsExpression(node) || isTypeAssertion(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;

  const modifiers = (node: ts.Node) => (node as Partial<ts.ModifiersBase>).modifiers;

  const readonly = (symbol: Symbol): boolean => {
    const declaration = nodeOf(symbol);

    if (modifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) {
      return true;
    }

    let node: ts.Node | undefined = declaration;

    while (node && !ts.isSourceFile(node)) {
      if (ts.isAsExpression(node) && node.type.getText() === 'const') {
        return true;
      }

      if (ts.isVariableDeclaration(node) && node.initializer && ts.isAsExpression(node.initializer) && node.initializer.type.getText() === 'const') {
        return true;
      }

      node = node.parent;
    }

    return false;
  };

  const classSources = new Map<Symbol, ApiValueSource>();

  function valueClass(type: Type, member: string): ApiValueSource {
    const symbol = type.getSymbol();

    if (!symbol || !isClass(type)) {
      return fail(member, `unsupported transport type ${checker.typeToString(type)}`);
    }

    const cached = classSources.get(symbol);

    if (cached) {
      return cached;
    }

    const constructor = typeOf(symbol);
    const codec = checker.getPropertyOfType(constructor, 'codec');

    if (!codec || !readonly(codec)) {
      return fail(member, `unsupported transport type ${checker.typeToString(type)}; value classes need a static readonly codec`);
    }

    const encode = checker.getPropertyOfType(typeOf(codec), 'encode');
    const decode = checker.getPropertyOfType(typeOf(codec), 'decode');
    const encodeSignatures = encode && typeOf(encode).getCallSignatures();
    const decodeSignatures = decode && typeOf(decode).getCallSignatures();
    const encoding = encodeSignatures?.[0];
    const decoding = decodeSignatures?.[0];

    if (encodeSignatures?.length !== 1 || decodeSignatures?.length !== 1 || !encoding || !decoding
      || encoding.typeParameters?.length || decoding.typeParameters?.length || encoding.parameters.length !== 1 || decoding.parameters.length !== 1
      || !checker.isTypeAssignableTo(type, typeOf(encoding.getParameters()[0])) || !checker.isTypeAssignableTo(checker.getReturnTypeOfSignature(decoding), type)) {
      return fail(member, 'value codecs need synchronous encode(value) and decode(data) functions returning the declared class');
    }

    const encoded = checker.getReturnTypeOfSignature(encoding);

    if (encoded.flags & (TypeFlags.Void | TypeFlags.Undefined) || (encoded.isUnionType() && encoded.getTypes().some(type => type.flags & (TypeFlags.Void | TypeFlags.Undefined)))
      || checker.getAwaitedType(encoded) !== encoded || !checker.isTypeAssignableTo(encoded, typeOf(decoding.getParameters()[0]))) {
      return fail(member, 'value codec encode must return defined JSON data accepted by decode');
    }

    jsonType(encoded, `${member}.codec`, [], 'json');

    const declaringFile = nodeOf(symbol).getSourceFile().fileName;
    let owner = pkg;

    if (!inside(pkg.root, declaringFile)) {
      let directory = path.dirname(declaringFile);

      while (path.dirname(directory) !== directory) {
        const metadata = path.join(directory, 'package.json');

        pkg.inputs.add(metadata);

        if (existsSync(metadata)) {
          const value: unknown = JSON.parse(readFileSync(metadata, 'utf8'));

          if (record(value) && typeof value.name === 'string') {
            owner = readPackage(directory);
            break;
          }
        }

        directory = path.dirname(directory);
      }
    }

    for (const subpath of Object.keys(exportsMap(owner.metadata))) {
      if (subpath.includes('*')) {
        continue;
      }

      const types = exportedTarget(owner, subpath, true);

      if (types === undefined || path.resolve(types) !== path.resolve(declaringFile)) {
        continue;
      }

      const shared = program.getSourceFile(types);
      const sharedModule = shared && checker.getSymbolAtLocation(shared);
      const exported = sharedModule && checker.getExportsOfModule(sharedModule).find(candidate => unalias(candidate) === symbol);
      const runtime = exportedTarget(owner, subpath, false);

      if (exported && runtime && !/\.d\.[cm]?ts$/.test(runtime)) {
        const callable = (type: Type, seen: readonly Type[] = []): boolean => {
          if (seen.includes(type) || type.getConstructSignatures().length || checker.isArrayType(type) || checker.isTupleType(type)
            || type.getSymbol()?.name === 'ReadonlyArray') { return false; }

          return type.getCallSignatures().length > 0 || (!!(type.flags & TypeFlags.Object)
            && checker.getPropertiesOfType(type).some(property => callable(typeOf(property), [...seen, type])));
        };

        if (sharedModule && checker.getExportsOfModule(sharedModule).some(value => !!(unalias(value).flags & SymbolFlags.Value) && callable(typeOf(unalias(value))))) {
          return fail(member, 'shared value entries must export classes and data; keep remote functions, state and signals in the API entry');
        }

        const value = { source: runtime, name: exported.name };

        classSources.set(symbol, value);
        pkg.inputs.add(runtime);
        owner.inputs.forEach(file => pkg.inputs.add(file));

        return value;
      }
    }

    return fail(member, 'export the value class from its own shared package entry so consumers can load its class and codec');
  }

  type CallDescription = { parameters: { value: Json; rest: boolean }[]; result: Json };

  function describeCall(signature: Signature, member: string, callbacks: boolean): CallDescription {
    const result = checker.getReturnTypeOfSignature(signature);
    const awaited = checker.getAwaitedType(result);

    if (signature.typeParameters?.length || signature.thisParameter || awaited === undefined || awaited === result) {
      return fail(member, 'functions and callbacks must return Promise<T> with concrete arguments/results');
    }

    return {
      parameters: signature.getParameters().map((parameter) => {
        const declaration = parameter.valueDeclaration?.resolve();

        return {
          value: jsonType(typeOf(parameter), member, [], callbacks ? 'arguments' : 'value'),
          rest: !!declaration && isParameterDeclaration(declaration) && !!declaration.dotDotDotToken,
        };
      }),
      result: awaited.flags & TypeFlags.Never ? 'never' : jsonType(awaited, member),
    };
  }

  function parameterShape(parameters: CallDescription['parameters'], member: string): ApiParametersShape | undefined {
    const items: (ApiDataShape | null)[] = [];
    let rest: ApiDataShape | undefined;

    for (const parameter of parameters) {
      if (!parameter.rest) {
        items.push(dataShape(parameter.value, member) ?? null);
      } else if (record(parameter.value) && 'array' in parameter.value) {
        rest = dataShape(parameter.value.array as Json, member);
      } else if (record(parameter.value) && Array.isArray(parameter.value.tuple) && Array.isArray(parameter.value.flags)) {
        const values = parameter.value.tuple as Json[];
        const flags = parameter.value.flags as number[];

        for (let index = 0; index < values.length; index++) {
          if (flags[index] & (ElementFlags.Rest | ElementFlags.Variadic)) {
            if (index !== values.length - 1) {
              return fail(member, 'value codecs and callbacks require a trailing rest parameter');
            }

            rest = dataShape(values[index], member);
          } else {
            items.push(dataShape(values[index], member) ?? null);
          }
        }
      } else {
        return fail(member, 'rest arguments must have a concrete array or tuple type');
      }
    }

    if (!rest) {
      while (items.length && items[items.length - 1] === null) {
        items.pop();
      }
    }

    return items.some(item => item !== null) || rest ? { items, ...rest && { rest } } : undefined;
  }

  function callShape(description: CallDescription, member: string): ApiCallShape {
    const parameters = parameterShape(description.parameters, member);
    const result = dataShape(description.result, member);

    return { ...parameters && { parameters }, ...result && { result } };
  }

  function dataShape(description: Json, member: string): ApiDataShape | undefined {
    if (!record(description)) {
      return;
    }

    if (description.reference === 'entity' || description.reference === 'player' || description.reference === 'dimension' || description.reference === 'block'
      || description.reference === 'entity-component' || description.reference === 'block-component' || description.reference === 'container' || description.reference === 'container-slot') {
      return { kind: 'reference', reference: description.reference, ...typeof description.nativeType === 'string' && { nativeType: description.nativeType } };
    }

    if (description.nativeValue === 'item-stack' || description.nativeValue === 'block-permutation') {
      return { kind: 'native-value', value: description.nativeValue };
    }

    if (description.reference === 'api' && typeof description.contract === 'string' && record(description.shape)) {
      return { kind: 'reference', reference: 'api', contract: description.contract, shape: description.shape as Extract<ApiShape, { kind: 'object' }> };
    }

    if (record(description.codec) && typeof description.codec.source === 'string' && typeof description.codec.name === 'string') {
      return { kind: 'codec', codec: { source: description.codec.source, name: description.codec.name } };
    }

    if (record(description.callback)) {
      return { kind: 'callback', ...callShape(description.callback as CallDescription, member) };
    }

    if (Array.isArray(description.union)) {
      const choices = (description.union as Json[]).filter(value => value !== 'undefined' && value !== 'null');
      const plans = choices.map(value => dataShape(value, member));

      if (plans.some(Boolean) && plans.some(plan => JSON.stringify(plan) !== JSON.stringify(plans[0]))) {
        return fail(member, 'union alternatives must use the same value codecs and callback signatures');
      }

      const plan = plans[0];

      if (plan?.kind === 'reference') {
        const missing = description.union.includes('undefined') ? 'undefined' : description.union.includes('null') ? 'null' : undefined;

        return { ...plan, ...missing && { missing } };
      }

      return plan;
    }

    if (Array.isArray(description.map)) {
      const key = dataShape(description.map[0] as Json, member);
      const value = dataShape(description.map[1] as Json, member);

      return key || value ? { kind: 'map', ...key && { key }, ...value && { value } } : undefined;
    }

    if ('set' in description) {
      const item = dataShape(description.set as Json, member);

      return item && { kind: 'set', item };
    }

    if ('array' in description) {
      const item = dataShape(description.array as Json, member);

      return item && { kind: 'array', item };
    }

    if (Array.isArray(description.tuple)) {
      const plan = parameterShape([{ value: description as Json, rest: true }], member);

      return plan && { kind: 'tuple', ...plan };
    }

    if (record(description.object)) {
      const members: Record<string, ApiDataShape> = {};

      for (const [key, property] of Object.entries(description.object)) {
        if (record(property)) {
          const plan = dataShape(property.type as Json, `${member}.${key}`);

          if (plan) {
            members[key] = plan;
          }
        }
      }

      const indexes = Array.isArray(description.indexes) ? description.indexes as { value: Json }[] : [];
      const indexPlans = indexes.map(index => dataShape(index.value, member));
      const index = indexPlans.find(Boolean);

      if (index && indexPlans.some(plan => JSON.stringify(plan) !== JSON.stringify(index))) {
        return fail(member, 'index signatures must use the same value codec');
      }

      return Object.keys(members).length || index ? { kind: 'object', members, ...index && { index } } : undefined;
    }
  }

  const referenceContracts = new Map<Type, Json>();
  const checkingReferences = new Set<Type>();

  function publicProperties(type: Type): Symbol[] {
    return checker.getPropertiesOfType(type).filter(property => !property.declarations.some((handle) => {
      const declaration = handle.resolve();

      return !!declaration && ((ts.isPropertyDeclaration(declaration) && ts.isPrivateIdentifier(declaration.name))
        || modifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword));
    }));
  }

  function referenceCandidate(type: Type, seen: readonly Type[] = []): boolean {
    if (seen.includes(type) || !(type.flags & TypeFlags.Object) || type.getCallSignatures().length || type.getConstructSignatures().length
      || checker.isArrayType(type) || checker.isTupleType(type) || builtin(type)) {
      return false;
    }

    const symbol = type.getSymbol();

    if (symbol) {
      const constructor = isClass(type) ? typeOf(symbol) : undefined;

      if (constructor && checker.getPropertyOfType(constructor, 'codec')) {
        return false;
      }

      const metadata = findConfigFile(path.dirname(nodeOf(symbol).getSourceFile().fileName), track, 'package.json');
      const owner: unknown = metadata && JSON.parse(readFileSync(metadata, 'utf8'));

      if (record(owner) && typeof owner.name === 'string' && owner.name.startsWith('@minecraft/')) {
        return false;
      }
    }

    return publicProperties(type).some((property) => {
      const value = typeOf(property);
      const members = checker.getPropertiesOfType(value);

      if (members.some(member => member.name === 'subscribe')) {
        return true;
      }

      const method = property.declarations.some(node => node.kind === ts.SyntaxKind.MethodDeclaration || node.kind === ts.SyntaxKind.MethodSignature);

      if (method && value.getCallSignatures().some(signature => checker.getAwaitedType(checker.getReturnTypeOfSignature(signature)) !== checker.getReturnTypeOfSignature(signature))) {
        return true;
      }

      return !value.getCallSignatures().length && referenceCandidate(value, [...seen, type]);
    });
  }

  function referenceContract(type: Type, member: string): Json {
    const cached = referenceContracts.get(type);

    if (cached) {
      return cached;
    }

    if (checkingReferences.has(type)) {
      return fail(member, 'API object contracts must have a finite, non-recursive shape');
    }

    checkingReferences.add(type);
    const properties = publicProperties(type).sort((left, right) => left.name.localeCompare(right.name));
    const members: Record<string, ApiShape> = {};

    for (const property of properties) {
      if (property.flags & SymbolFlags.Optional || ['__proto__', 'constructor', 'prototype'].includes(property.name)) {
        return fail(member, 'API object members must be required, named public members');
      }

      members[property.name] = shape(property, `${member}.${property.name}`, [type]);
    }

    const contractShape = { kind: 'object', members } as const;

    const signatureOf = (type: Type, branch: ApiShape): unknown => {
      if (branch.kind === 'function') {
        return type.getCallSignatures().map(signature => describeCall(signature, member, true));
      }

      if (branch.kind === 'state') {
        const get = checker.getPropertyOfType(type, 'get')!;

        return { state: jsonType(checker.getReturnTypeOfSignature(typeOf(get).getCallSignatures()[0]), member) };
      }

      if (branch.kind === 'event') {
        return { event: jsonType(subscription(checker.getPropertyOfType(type, 'subscribe')!, member).payload, member) };
      }

      if (branch.kind === 'object') {
        return Object.fromEntries(Object.entries(branch.members).map(([name, value]) => [name, signatureOf(typeOf(checker.getPropertyOfType(type, name)!), value)]));
      }

      return branch;
    };

    const signature = signatureOf(type, contractShape);
    const canonical = JSON.stringify({ signature, shape: contractShape }, (key, value: unknown) => {
      if (key !== 'source' || typeof value !== 'string') {
        return value;
      }

      const metadata = findConfigFile(path.dirname(value), track, 'package.json');
      const owner: unknown = metadata && JSON.parse(readFileSync(metadata, 'utf8'));

      return record(owner) && typeof owner.name === 'string' ? owner.name : path.basename(value);
    });
    const contract = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
    const result = { reference: 'api', contract, shape: contractShape } as unknown as Json;

    checkingReferences.delete(type);
    referenceContracts.set(type, result);

    return result;
  }

  function builtin(type: Type): string | undefined {
    const symbol = type.getSymbol();
    const name = symbol?.name;

    return name && ['Map', 'ReadonlyMap', 'Set', 'ReadonlySet', 'Date', 'RegExp', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'].includes(name)
      && symbol?.declarations.every(handle => /[/\\]lib\.[^/\\]+\.d\.ts$/.test(handle.resolve()?.getSourceFile().fileName ?? ''))
      ? name
      : undefined;
  }

  function plainJson(type: Type, seen = new Set<Type>()): boolean {
    if (seen.has(type)) {
      return true;
    }

    seen.add(type);
    const flags = type.flags;

    if (flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.Never | TypeFlags.TypeParameter | TypeFlags.ESSymbolLike)) {
      return false;
    }

    if (type.isUnionType()) {
      return type.getTypes().every(value => plainJson(value, new Set(seen)));
    }

    if (flags & (TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.BooleanLike | TypeFlags.BigIntLike | TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void)) {
      return true;
    }

    const standard = builtin(type);

    if (standard) {
      return !['Map', 'ReadonlyMap', 'Set', 'ReadonlySet'].includes(standard)
        || checker.getTypeArguments(type as TypeReference).every(value => plainJson(value, new Set(seen)));
    }

    if (!(flags & TypeFlags.Object) || isClass(type) || type.getCallSignatures().length || type.getConstructSignatures().length) {
      return false;
    }

    if (checker.isArrayType(type) || checker.isTupleType(type) || type.getSymbol()?.name === 'ReadonlyArray') {
      return checker.getTypeArguments(type as TypeReference).every(value => plainJson(value, new Set(seen)));
    }

    return checker.getPropertiesOfType(type).every(property => plainJson(typeOf(property), new Set(seen)))
      && checker.getIndexInfosOfType(type).every(index => plainJson(index.keyType, new Set(seen)) && plainJson(index.valueType, new Set(seen)));
  }

  function jsonType(type: Type, member: string, ancestors: readonly Type[] = [], mode: 'json' | 'value' | 'arguments' = 'value'): Json {
    if (ancestors.includes(type)) {
      if (plainJson(type)) {
        return { recursive: true };
      }

      return fail(member, 'recursive transport types need a finite JSON contract');
    }

    const flags = type.flags;

    if (flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.Never | TypeFlags.TypeParameter | TypeFlags.ESSymbolLike)) {
      return fail(member, `unsupported transport type ${checker.typeToString(type)}`);
    }

    if (type.isUnionType()) {
      return { union: type.getTypes().map(item => jsonType(item, member, [...ancestors, type], mode)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
    }

    if (type.isStringLiteralType() || type.isNumberLiteralType()) {
      return { literal: type.value };
    }

    if (flags & TypeFlags.BooleanLiteral) {
      return { literal: checker.typeToString(type) === 'true' };
    }

    for (const [flag, name] of [[TypeFlags.String, 'string'], [TypeFlags.Number, 'number'], [TypeFlags.BigIntLike, 'bigint'], [TypeFlags.Boolean, 'boolean'], [TypeFlags.Null, 'null'], [TypeFlags.Undefined | TypeFlags.Void, 'undefined']] as const) {
      if (flags & flag) {
        return name;
      }
    }

    if (checker.isTupleType(type)) {
      const reference = type as TupleTypeReference;

      return { tuple: checker.getTypeArguments(reference).map(item => jsonType(item, member, [...ancestors, type], mode)), flags: [...reference.getTarget().elementFlags] };
    }

    if (checker.isArrayType(type) || type.getSymbol()?.name === 'ReadonlyArray') {
      return { array: jsonType(checker.getTypeArguments(type as TypeReference)[0], member, [...ancestors, type], mode) };
    }

    const symbol = type.getSymbol();
    const standard = builtin(type);

    if (standard) {
      if (standard === 'Map' || standard === 'ReadonlyMap') {
        const parameters = checker.getTypeArguments(type as TypeReference);

        return { map: parameters.map(value => jsonType(value, member, [...ancestors, type], mode)) };
      }

      if (standard === 'Set' || standard === 'ReadonlySet') {
        const parameters = checker.getTypeArguments(type as TypeReference);

        return { set: jsonType(parameters[0], member, [...ancestors, type], mode) };
      }

      return { builtin: standard };
    }

    if (mode !== 'json' && symbol && isClass(type)) {
      const metadata = findConfigFile(path.dirname(nodeOf(symbol).getSourceFile().fileName), track, 'package.json');
      const owner: unknown = metadata && JSON.parse(readFileSync(metadata, 'utf8'));

      if (record(owner) && owner.name === '@minecraft/server') {
        if (metadata) {
          pkg.inputs.add(metadata);
        }

        if (['Entity', 'Player', 'Dimension', 'Block'].includes(symbol.name)) {
          return { reference: symbol.name.toLowerCase() };
        }

        if (symbol.name === 'ItemStack' || symbol.name === 'BlockPermutation') {
          return { nativeValue: symbol.name === 'ItemStack' ? 'item-stack' : 'block-permutation' };
        }

        if (symbol.name === 'Container' || symbol.name === 'ContainerSlot') {
          return { reference: symbol.name === 'Container' ? 'container' : 'container-slot', nativeType: symbol.name };
        }

        const componentOwner = (value: Type): 'entity-component' | 'block-component' | undefined => {
          if (value.getSymbol()?.name === 'EntityComponent') {
            return 'entity-component';
          }

          if (value.getSymbol()?.name === 'BlockComponent') {
            return 'block-component';
          }

          return value.getBaseTypes()?.map(componentOwner).find(value => value !== undefined);
        };

        const component = componentOwner(type);

        if (component) {
          return {

            reference: component, nativeType: symbol.name };
        }

        return fail(member, `unsupported Minecraft class ${symbol.name}; no native reference adapter or value codec`);
      }
    }

    if (mode !== 'json' && referenceCandidate(type)) {
      return referenceContract(type, member);
    }

    if (isClass(type) && mode !== 'json') {
      return { codec: valueClass(type, member) };
    }

    if (type.getCallSignatures().length && mode === 'arguments') {
      const signatures = type.getCallSignatures();

      if (signatures.length !== 1) {
        return fail(member, 'callbacks need one concrete async signature');
      }

      return { callback: describeCall(signatures[0], member, false) };
    }

    if (!(flags & TypeFlags.Object) || type.getCallSignatures().length || type.getConstructSignatures().length
      || isClass(type)) {
      return fail(member, `unsupported transport type ${checker.typeToString(type)}`);
    }

    const props: { [key: string]: Json } = {};

    for (const property of [...checker.getPropertiesOfType(type)].sort((a, b) => a.name.localeCompare(b.name))) {
      props[property.name] = { optional: !!(property.flags & SymbolFlags.Optional), type: jsonType(typeOf(property), `${member}.${property.name}`, [...ancestors, type], mode) };
    }

    const indexes = checker.getIndexInfosOfType(type).map(index => ({ key: jsonType(index.keyType, member, [...ancestors, type], mode), value: jsonType(index.valueType, member, [...ancestors, type], mode) }));

    return { object: props, indexes };
  }

  function constant(node: ts.Expression, member: string, ancestors: readonly ts.Node[] = []): Json {
    node = unwrap(node);

    if (ancestors.includes(node)) {
      return fail(member, 'circular constant initializer');
    }

    const next = [...ancestors, node];

    if (isStringLiteralLikeNode(node)) {
      return node.text;
    }

    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);

      return Number.isFinite(value) ? value : fail(member, 'constant numbers must be finite');
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      return node.kind === ts.SyntaxKind.TrueKeyword;
    }

    if (node.kind === ts.SyntaxKind.NullKeyword) {
      return null;
    }

    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)) {
      const value = constant(node.operand, member, next);

      if (typeof value === 'number') {
        return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
      }
    }

    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.map(element => ts.isSpreadElement(element) ? fail(member, 'constant arrays cannot use spread') : constant(element, member, next));
    }

    if (ts.isObjectLiteralExpression(node)) {
      const result: { [key: string]: Json } = {};

      const assign = (key: string, value: Json): void => {
        Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      };

      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(property);

          if (!symbol) {
            return fail(member, 'unresolved constant shorthand');
          }

          if (!ts.isIdentifier(property.name)) {
            return fail(member, 'constant objects require literal data properties');
          }

          assign(property.name.text, constantFor(symbol, member, next));
        } else if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)) {
          const name = property.name;

          if (!('text' in name)) {
            return fail(member, 'constant objects require literal data properties');
          }

          assign(name.text, constant(property.initializer, member, next));
        } else {
          return fail(member, 'constant objects require literal data properties');
        }
      }

      return result;
    }

    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node);

      if (symbol) {
        return constantFor(unalias(symbol), member, next);
      }
    }

    return fail(member, 'constant value must have a static JSON literal initializer');
  }

  function declaredConstant(type: Type, member: string, ancestors: readonly Type[] = []): Json {
    if (ancestors.includes(type)) {
      return fail(member, 'circular constant type');
    }

    if (type.isStringLiteralType() || type.isNumberLiteralType()) {
      return typeof type.value === 'number' && !Number.isFinite(type.value) ? fail(member, 'constant numbers must be finite') : type.value;
    }

    if (type.flags & TypeFlags.BooleanLiteral) {
      return checker.typeToString(type) === 'true';
    }

    if (type.flags & TypeFlags.Null) {
      return null;
    }

    if (checker.isTupleType(type)) {
      const tuple = (type as TupleTypeReference).getTarget();

      if (tuple.readonly && tuple.elementFlags.every(flag => flag === ElementFlags.Required)) {
        return checker.getTypeArguments(type as TypeReference).map(item => declaredConstant(item, member, [...ancestors, type]));
      }
    }

    if (type.flags & TypeFlags.Object && !isClass(type) && !type.getCallSignatures().length && !checker.getIndexInfosOfType(type).length) {
      const properties = checker.getPropertiesOfType(type);

      if (properties.every(property => readonly(property) && !(property.flags & SymbolFlags.Optional))) {
        return Object.fromEntries(properties.map(property => [property.name, declaredConstant(typeOf(property), `${member}.${property.name}`, [...ancestors, type])]));
      }
    }

    return fail(member, 'constant value is not known statically; publish a literal const or a readonly state handle');
  }

  function constantFor(symbol: Symbol, member: string, ancestors: readonly ts.Node[] = []): Json {
    symbol = unalias(symbol);
    const declaration = nodeOf(symbol);

    if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
      return constant(declaration.initializer, member, ancestors);
    }

    if (ts.isPropertyAssignment(declaration)) {
      return constant(declaration.initializer, member, ancestors);
    }

    if (ts.isShorthandPropertyAssignment(declaration)) {
      const original = checker.getShorthandAssignmentValueSymbol(declaration);

      if (original) {
        return constantFor(original, member, ancestors);
      }
    }

    return declaredConstant(typeOf(symbol), member);
  }

  function hasOptionalMarker(declaration: ts.ParameterDeclaration): boolean {
    if (declaration.questionToken || (declaration.type && isJSDocOptionalType(declaration.type))) {
      return true;
    }

    const name = declaration.name;

    return ts.isIdentifier(name) && !!declaration.parent?.jsDoc?.some(doc => isJSDoc(doc) && doc.tags?.some((tag) => {
      if (!isJSDocParameterTag(tag) || !ts.isIdentifier(tag.name) || tag.name.text !== name.text) {
        return false;
      }

      const type = tag.typeExpression;

      return tag.isBracketed || (!!type && isJSDocTypeExpression(type) && isJSDocOptionalType(type.type));
    }));
  }

  function optionalParameter(declaration: ts.ParameterDeclaration): boolean {
    const parent = declaration.parent as ts.FunctionLikeBase | undefined;

    return hasOptionalMarker(declaration) || (!!declaration.initializer && !!parent?.parameters
      && parent.parameters.slice(parent.parameters.indexOf(declaration) + 1).every(parameter =>
        !!(parameter.initializer || parameter.dotDotDotToken) || hasOptionalMarker(parameter)));
  }

  function subscription(symbol: Symbol, member: string, state?: Type): { payload: Type } {
    const signatures = typeOf(symbol).getCallSignatures();
    const signature = signatures[0];

    if (signatures.length !== 1 || signature.typeParameters?.length || signature.parameters.length < 1 || signature.parameters.length > 2) {
      return fail(member, 'subscribe must accept one typed listener and return an unsubscribe function');
    }

    if (signature.parameters.length === 2) {
      const options = typeOf(signature.getParameters()[1]);
      const declaration = signature.getParameters()[1].valueDeclaration?.resolve();

      if (!declaration || !isParameterDeclaration(declaration) || !optionalParameter(declaration)
        || !(options.flags & (TypeFlags.Never | TypeFlags.Undefined))) {
        return fail(member, 'public API subscriptions do not support filter options; filter events in the provider');
      }
    }

    const listeners = typeOf(signature.getParameters()[0]).getCallSignatures();
    const listener = listeners[0];
    const returned = checker.getReturnTypeOfSignature(signature);
    const noRequiredArguments = (signature: Signature): boolean => signature.getParameters().every((parameter) => {
      const declaration = parameter.valueDeclaration?.resolve();

      if (!declaration || !isParameterDeclaration(declaration)) {
        return !!(parameter.flags & SymbolFlags.Optional);
      }

      if (optionalParameter(declaration)) {
        return true;
      }

      const type = typeOf(parameter);

      return !!declaration.dotDotDotToken && (!checker.isTupleType(type) || !(type as TupleTypeReference).getTarget().elementFlags.some(flag => flag & (ElementFlags.Required | ElementFlags.Variadic)));
    });

    if (listeners.length !== 1 || listener.typeParameters?.length || listener.parameters.length < 1 || listener.parameters.length > 2) {
      return fail(member, 'subscribe needs one typed payload listener');
    }

    const isCleanup = (value: Type): boolean => {
      const signatures = value.getCallSignatures();

      return signatures.length === 1 && noRequiredArguments(signatures[0])
        && !!(checker.getReturnTypeOfSignature(signatures[0]).flags & (TypeFlags.Void | TypeFlags.Undefined));
    };

    const choices = returned.isUnionType() ? returned.getTypes() : [returned];

    if (state && !choices.every(isCleanup)) {
      return fail(member, 'observable subscribe must return a zero-argument unsubscribe function returning void');
    }

    if (!choices.every(isCleanup)) {
      return fail(member, 'subscribe must return a zero-argument unsubscribe function returning void; convert native signals with toSignal()');
    }

    if (state) {
      const expected = JSON.stringify(jsonType(state, member));

      if (listener.getParameters().some(parameter => JSON.stringify(jsonType(typeOf(parameter), member)) !== expected)) {
        return fail(member, 'state listener values must match get(), including undefined before availability');
      }
    } else if (listener.parameters.length !== 1) {
      return fail(member, 'Signal<T> listeners accept one payload parameter');
    }

    return { payload: typeOf(listener.getParameters()[0]) };
  }

  function shape(symbol: Symbol, member: string, ancestors: readonly Type[] = []): ApiShape {
    symbol = unalias(symbol);
    const type = typeOf(symbol);
    const signatures = type.getCallSignatures();

    if (signatures.length) {
      const plans = signatures.map(signature => callShape(describeCall(signature, member, true), member));

      if (plans.some(plan => JSON.stringify(plan) !== JSON.stringify(plans[0]))) {
        return fail(member, 'overloads must use the same value codecs and callback signatures');
      }

      return { kind: 'function', ...plans[0] };
    }

    if (type.getConstructSignatures().length && isClass(type)) {
      return { kind: 'local', value: valueClass(checker.getDeclaredTypeOfSymbol(type.getSymbol() ?? symbol), member) };
    }

    if (type.flags & (TypeFlags.Any | TypeFlags.Unknown) || type.getConstructSignatures().length || isClass(type)) {
      return fail(member, `unsupported public value ${checker.typeToString(type)}`);
    }

    const properties = checker.getPropertiesOfType(type);
    const subscribe = properties.find(property => property.name === 'subscribe');
    const get = properties.find(property => property.name === 'get');

    if (subscribe && properties.every(property => ['subscribe', 'unsubscribe', 'get', get ? 'set' : 'emit'].includes(property.name))) {
      if (!get && properties.some(property => property.name === 'unsubscribe')) {
        return fail(member, 'native signals must be converted with toSignal() before export');
      }

      if (get) {
        if (properties.some(property => property.name === 'unsubscribe')) {
          return fail(member, 'readonly observables expose only get and subscribe');
        }

        const signatures = typeOf(get).getCallSignatures();
        const signature = signatures[0];

        if (signatures.length !== 1 || signature.typeParameters?.length || signature.parameters.length) {
          return fail(member, 'readonly state get() must have no parameters');
        }

        const value = checker.getReturnTypeOfSignature(signature);

        if (projection && (properties.some(property => property.name === 'set')
          || (!(value.flags & TypeFlags.Undefined) && !(value.isUnionType() && value.getTypes().some(type => type.flags & TypeFlags.Undefined))))) {
          projection.required = true;
        }

        subscription(subscribe, member, value);

        const data = dataShape(jsonType(value, member), member);

        return { kind: 'state', ...data && { data } };
      }

      const { payload } = subscription(subscribe, member);
      const data = dataShape(jsonType(payload, member), member);

      if (projection && properties.some(property => property.name === 'emit')) {
        projection.required = true;
      }

      return { kind: 'event', ...data && { data } };
    }

    if (type.flags & TypeFlags.Object && !checker.isArrayType(type) && !checker.isTupleType(type) && type.getSymbol()?.name !== 'ReadonlyArray') {
      if (ancestors.includes(type) || checker.getIndexInfosOfType(type).length) {
        return fail(member, 'public objects need a finite set of named members');
      }

      const members: Record<string, ApiShape> = {};

      for (const property of properties) {
        if (property.flags & SymbolFlags.Optional) {
          return fail(`${member}.${property.name}`, 'public module members cannot be optional');
        }

        if (['__proto__', 'constructor', 'prototype'].includes(property.name)) {
          return fail(`${member}.${property.name}`, 'reserved object member name');
        }

        members[property.name] = shape(property, `${member}.${property.name}`, [...ancestors, type]);
      }

      return { kind: 'object', members };
    }

    if ((checker.isArrayType(type) || checker.isTupleType(type))
      && type.getSymbol()?.name !== 'ReadonlyArray' && !(checker.isTupleType(type) && (type as TupleTypeReference).getTarget().readonly)) {
      return fail(member, 'constant arrays must be readonly; use as const');
    }

    const declaration = nodeOf(symbol);

    if ((ts.isPropertyAssignment(declaration) || isPropertySignatureDeclaration(declaration)) && !readonly(symbol)) {
      return fail(member, 'constant object members must be readonly; use as const');
    }

    return { kind: 'value', value: constantFor(symbol, member) };
  }

  if (!module) {
    return fail(moduleName, 'entrypoint must be an ES module with public exports');
  }

  function runtimeNames(source: ts.SourceFile, ancestors: readonly ts.SourceFile[] = []): Set<string> {
    const names = new Set<string>();

    if (ancestors.includes(source)) {
      return names;
    }

    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) {
          continue;
        }

        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          statement.exportClause.elements.filter(element => !element.isTypeOnly).forEach(element => names.add(element.name.text));
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          names.add(statement.exportClause.name.text);
        } else if (statement.moduleSpecifier) {
          const imported = checker.getSymbolAtLocation(statement.moduleSpecifier);
          const declaration = imported?.declarations.find(node => node.kind === ts.SyntaxKind.SourceFile)?.resolve();

          if (declaration && ts.isSourceFile(declaration)) {
            runtimeNames(declaration, [...ancestors, source]).forEach(name => name !== 'default' && names.add(name));
          }
        }
      } else if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) {
          fail(moduleName, 'public entrypoints must use ES module exports');
        }

        names.add('default');
      } else if (modifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if (modifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          names.add('default');
        } else if (ts.isVariableStatement(statement)) {
          const add = (name: ts.BindingName): void => {
            if (ts.isIdentifier(name)) {
              names.add(name.text);
            } else {
              name.elements.forEach(element => element.name && add(element.name));
            }
          };

          statement.declarationList.declarations.forEach(declaration => add(declaration.name));
        } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
          names.add((statement.name as ts.Identifier).text);
        }
      }
    }

    return names;
  }

  const members: Record<string, ApiShape> = {};
  const exportedNames = runtimeNames(file);

  for (const exported of [...checker.getExportsOfModule(module)].sort((a, b) => a.name.localeCompare(b.name))) {
    const symbol = unalias(exported);
    const typeOnly = exported.declarations.some((handle) => {
      if (handle.kind !== ts.SyntaxKind.ExportSpecifier) {
        return false;
      }

      const declaration = handle.resolve();
      const statement = declaration?.parent?.parent;

      return !!declaration && ts.isExportSpecifier(declaration)
        && (declaration.isTypeOnly || (!!statement && ts.isExportDeclaration(statement) && statement.isTypeOnly));
    });

    if (!typeOnly && exportedNames.has(exported.name) && symbol.flags & SymbolFlags.Value) {
      if (factories) {
        const signatures = typeOf(symbol).getCallSignatures();
        const signature = signatures[0];

        if (!signature) {
          continue;
        }

        const returned = checker.getReturnTypeOfSignature(signature);
        const declaration = returned.getSymbol();
        const metadata = declaration && findConfigFile(path.dirname(nodeOf(declaration).getSourceFile().fileName), track, 'package.json');
        const owner: unknown = metadata && JSON.parse(readFileSync(metadata, 'utf8'));

        if (declaration?.name !== 'ApiDeclaration' || !record(owner) || owner.name !== '@bedrock-core/server-runtime') {
          continue;
        }

        if (signatures.length !== 1 || signature.typeParameters?.length) {
          return fail(exported.name, 'API declaration factories need one concrete signature');
        }

        const implementation = checker.getPropertyOfType(returned, 'api');
        const plan = implementation && dataShape(referenceContract(typeOf(implementation), exported.name), exported.name);

        if (!plan || plan.kind !== 'reference' || plan.reference !== 'api') {
          return fail(exported.name, 'API declaration factory must expose a concrete implementation object');
        }

        factories[exported.name] = { contract: plan.contract, shape: plan.shape };
      } else {
        members[exported.name] = shape(symbol, exported.name);
      }
    }
  }

  if (!Object.keys(members).length && !allowTypesOnly) {
    return fail(moduleName, 'entrypoint has no supported runtime exports; import its types with import type');
  }

  pkg.inputs.add(source);

  return { kind: 'object', members };
}

/** Check reusable API declaration factories through the same public type and codec rules. */
export function inspectApiLibrary(root: string, entry: string): { moduleName: string; factories: Record<string, ApiLibraryFactory>; inputs: string[] } {
  const pkg = readPackage(root);
  const source = path.resolve(root, entry);
  const relative = path.relative(pkg.root, source).replaceAll('\\', '/');

  if (!inside(pkg.root, source) || typeof pkg.metadata.name !== 'string' || !packageName.test(pkg.metadata.name)) {
    throw new Error('API libraries require a named package and an entry inside its root');
  }

  const moduleName = `${pkg.metadata.name}/${relative.replace(/^src\//, '').replace(/\.[cm]?[jt]sx?$/, '')}`;
  const factories: Record<string, ApiLibraryFactory> = {};

  inspect(pkg, moduleName, source, source, true, undefined, factories);

  if (!Object.keys(factories).length) {
    throw new Error(`API library ${entry} has no exported ModuleDeclaration factories`);
  }

  return { moduleName, factories, inputs: [...pkg.inputs] };
}

/** Inspect one declared addon package export without evaluating provider code. */
export async function inspectApiModule(dependencyRoot: string, moduleName: string): Promise<ApiModule> {
  const parts = moduleName.split('/');
  const name = parts.slice(0, moduleName.startsWith('@') ? 2 : 1).join('/');
  const pkg = readPackage(dependencyRoot, name);
  const subpath = moduleName === name ? '.' : `.${moduleName.slice(name.length)}`;

  return inspectPackageModule(pkg, moduleName, subpath);
}

/** Inspect the project's own export without requiring a self-install in node_modules. */
export async function inspectOwnApiModule(root: string, subpath: string): Promise<ApiModule> {
  const pkg = readPackage(root);
  const moduleName = String(pkg.metadata.name) + (subpath === '.' ? '' : subpath.slice(1));

  return inspectPackageModule(pkg, moduleName, subpath, true);
}

async function inspectPackageModule(pkg: Package, moduleName: string, subpath: string, allowTypesOnly = false): Promise<ApiModule> {
  const source = exportedTarget(pkg, subpath, false) ?? (allowTypesOnly ? exportedTarget(pkg, subpath, true) : undefined);
  const declaration = exportedTarget(pkg, subpath, true);

  if (!source || !declaration) {
    throw new Error(`External addon API ${moduleName} must expose a public script entrypoint in package.json exports`);
  }

  const { namespace, uuid } = (await identity(pkg, moduleName))!;
  let shape: ApiModule['shape'];
  const projection = { required: false };

  if (source.endsWith('.json')) {
    const resolved = await resolveManifest(source, { root: pkg.root, validate: false });

    resolved.inputs.forEach(file => pkg.inputs.add(file));
    const value = scriptOutputManifest(resolved.manifest) as Json;
    const members: Record<string, ApiShape> = { default: { kind: 'value', value } };

    if (record(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key !== 'default' && !['__proto__', 'constructor', 'prototype'].includes(key)) {
          members[key] = { kind: 'value', value: item as Json };
        }
      }
    }

    shape = { kind: 'object', members };
  } else {
    shape = inspect(pkg, moduleName, source, declaration, allowTypesOnly, projection);
  }

  return { moduleName, namespace, uuid, source, declaration, shape, consumerView: projection.required, inputs: [...pkg.inputs] };
}

/** Select provenance tracing only for contracts that transfer derived native handles. */
export function needsNativeAccess(shape: unknown): boolean {
  if (Array.isArray(shape)) {
    return shape.some(needsNativeAccess);
  }

  if (!record(shape)) {
    return false;
  }

  return (shape.kind === 'reference' && ['entity-component', 'block-component', 'container', 'container-slot'].includes(String(shape.reference)))
    || Object.values(shape).some(needsNativeAccess);
}

/** Enforce native externals and replace addon API imports before aliases or custom resolvers. */
export function apiImports(moduleNames: readonly string[], native = true, dependencyRoot = process.cwd(), registerDependency?: (file: string) => void, requireNativeAccess?: () => void): Plugin {
  const modules = new Map<string, Promise<ApiModule>>();
  const owners = new Map<string, ReturnType<typeof identity>>();
  const declared = [...moduleNames].sort((left, right) => right.length - left.length);
  const values = new Set<string>();

  return {
    name: '@bedrock-core/module-api',
    setup(build) {
      build.initialOptions.metafile = true;
      build.onResolve({ filter: /.*/ }, async (args) => {
        const api = declared.find(name => args.path === name || args.path.startsWith(`${name}/`));

        if (api === undefined) {
          return;
        }

        if (api.startsWith('@minecraft/')) {
          return native ? { path: args.path, external: true } : undefined;
        }

        try {
          const parts = args.path.split('/');
          const name = parts.slice(0, args.path.startsWith('@') ? 2 : 1).join('/');
          const pkg = readPackage(dependencyRoot, name);

          const published = apiPackageMetadata(pkg.metadata);

          if (published) {
            if (published.nativeAccess) {
              requireNativeAccess?.();
            }

            const owner = await identity(pkg, args.path);
            const declaredOwner = args.path === api ? owner : await identity(pkg, api);

            if (owner?.namespace !== declaredOwner?.namespace || owner?.uuid !== declaredOwner?.uuid) {
              throw new Error(`Public export ${args.path} belongs to another script pack; declare module_name ${JSON.stringify(args.path)} in required or optional dependencies`);
            }

            const subpath = args.path === name ? '.' : `.${args.path.slice(name.length)}`;
            const file = exportedTarget(pkg, subpath, false, native ? [] : ['bedrock-core-build']);

            if (!file || /\.d\.[cm]?ts$/.test(file)) {
              throw new Error(`Published API ${args.path} must expose executable client bindings`);
            }

            pkg.inputs.forEach(file => registerDependency?.(file));

            return { path: file, watchFiles: [...pkg.inputs] };
          }

          if (!modules.has(args.path)) {
            modules.set(args.path, inspectApiModule(dependencyRoot, args.path));
          }

          const module = await modules.get(args.path)!;

          if (needsNativeAccess(module.shape)) {
            requireNativeAccess?.();
          }

          if (args.path !== api) {
            if (!owners.has(api)) {
              const parts = api.split('/');
              const pkg = readPackage(dependencyRoot, parts.slice(0, api.startsWith('@') ? 2 : 1).join('/'));

              owners.set(api, identity(pkg, api).then((owner) => {
                pkg.inputs.forEach(file => registerDependency?.(file));

                return owner;
              }));
            }

            const owner = await owners.get(api)!;

            if (owner?.namespace !== module.namespace || owner.uuid !== module.uuid) {
              throw new Error(`Public export ${args.path} belongs to another script pack; declare module_name ${JSON.stringify(args.path)} in required or optional dependencies`);
            }
          }

          module.inputs.forEach(file => registerDependency?.(file));

          return { path: args.path, namespace: 'core-api', pluginData: module, watchFiles: module.inputs };
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });
      build.onLoad({ filter: /.*/, namespace: 'core-api' }, (args) => {
        const module = args.pluginData as ApiModule;
        const shape = apiShapeSource(module.shape, (file) => {
          values.add(file);
          registerDependency?.(file);

          return file;
        });

        return {
          contents: [
            `import { createApiModule } from '@bedrock-core/server-runtime/api';`,
            ...shape.imports,
            `const api = createApiModule(${JSON.stringify(module.namespace)}, ${JSON.stringify(module.moduleName)}, ${shape.shape});`,
            ...Object.keys(module.shape.members).map((name, index) => `const member${index} = api[${JSON.stringify(name)}]; export { member${index} as ${JSON.stringify(name)} };`),
          ].join('\n'),
          loader: 'js', resolveDir: dependencyRoot, watchFiles: module.inputs,
        };
      });
      build.onEnd(async (result) => {
        if (result.errors.length || !result.metafile || !values.size) {
          return;
        }

        const inputs = result.metafile.inputs;
        const files = new Map(Object.keys(inputs).map(key => [path.resolve(build.initialOptions.absWorkingDir ?? process.cwd(), key), key]));
        const seen = new Set<string>();

        const visit = async (key: string): Promise<void> => {
          if (seen.has(key)) {
            return;
          }

          seen.add(key);

          if (key.startsWith('core-api:')) {
            const name = key.slice('core-api:'.length);
            const module = await modules.get(name);

            if (module && hasBindings(module.shape)) {
              throw new Error(`Shared API values cannot import the remote API ${name}; import its shared value entry instead`);
            }

            return;
          }

          for (const dependency of inputs[key]?.imports ?? []) {
            // esbuild's class-field helpers are not authored dependencies.
            if (dependency.path === '<runtime>' && dependency.original === undefined) {
              continue;
            }

            const specifier = dependency.original ?? dependency.path;

            if (/^@minecraft\//.test(specifier) || /^@bedrock-core\/(?:server-runtime|server)(?:\/|$)/.test(specifier)) {
              throw new Error(`Shared API values must be engine-free; ${specifier} may only be imported with import type`);
            }

            if (dependency.external) {
              throw new Error(`Shared API values must resolve to engine-free source files: ${specifier}`);
            }

            await visit(dependency.path);
          }
        };

        try {
          for (const file of values) {
            const key = files.get(path.resolve(file));

            if (key !== undefined) {
              await visit(key);
            }
          }
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });
    },
  };
}

function hasBindings(shape: ApiShape): boolean {
  return shape.kind === 'object' ? Object.values(shape.members).some(hasBindings) : shape.kind === 'function' || shape.kind === 'state' || shape.kind === 'event';
}

/** Discover the owning script pack's public package exports for automatic binding. */
export async function apiExports(dependencyRoot: string, manifest: { namespace?: unknown; header?: unknown }): Promise<{ modules: ApiModule[]; inputs: string[]; owns?: boolean }> {
  const file = path.join(dependencyRoot, 'package.json');

  if (!existsSync(file)) {
    return { modules: [], inputs: [file] };
  }

  const metadata: unknown = JSON.parse(readFileSync(file, 'utf8'));

  if (!record(metadata) || metadata.exports === undefined || typeof metadata.name !== 'string' || !Object.keys(exportsMap(metadata)).some(key => key === './manifest.json' || key.endsWith('/manifest.json'))) {
    return { modules: [], inputs: [file] };
  }

  const pkg = readPackage(dependencyRoot);
  const publicExports = exportsMap(pkg.metadata);

  if (!Object.entries(publicExports).some(([subpath, value]) => subpath !== './manifest.json' && target(value, true) !== undefined)) {
    return { modules: [], inputs: [...pkg.inputs] };
  }

  let selectedOwner = false;

  for (const subpath of Object.keys(publicExports).filter(key => key === './manifest.json' || key.endsWith('/manifest.json'))) {
    const source = exportedTarget(pkg, subpath, false);

    if (source === undefined) {
      continue;
    }

    const resolved = await resolveManifest(source, { root: pkg.root, validate: false });

    resolved.inputs.forEach(file => pkg.inputs.add(file));
    const candidate = resolved.manifest;

    if (record(candidate.header) && record(manifest.header) && candidate.header.uuid === manifest.header.uuid
      && candidate.namespace === manifest.namespace && Array.isArray(candidate.modules)
      && candidate.modules.some(module => record(module) && module.type === 'script')) { selectedOwner = true; }
  }

  if (!selectedOwner) {
    return { modules: [], inputs: [...pkg.inputs] };
  }

  const modules: ApiModule[] = [];

  for (const subpath of Object.keys(exportsMap(pkg.metadata)).sort()) {
    if (subpath.includes('*')) {
      throw new Error(`Core public API exports need explicit package subpaths; replace wildcard ${subpath} with named exports`);
    }

    if (subpath === './manifest.json' || subpath.endsWith('/manifest.json')) {
      continue;
    }

    const source = exportedTarget(pkg, subpath, false);

    if (!source || /\.(?:json|d\.[cm]?ts)$/.test(source)) {
      continue;
    }

    const declaration = exportedTarget(pkg, subpath, true)!;
    const moduleName = String(pkg.metadata.name) + (subpath === '.' ? '' : subpath.slice(1));
    const owner = await identity(pkg, moduleName, true);

    if (!owner || owner.namespace !== manifest.namespace || !record(manifest.header) || owner.uuid !== manifest.header.uuid) {
      continue;
    }

    const projection = { required: false };
    const shape = inspect(pkg, moduleName, source, declaration, true, projection);

    if (!hasBindings(shape) && !Object.values(shape.members).some(member => member.kind === 'object')) {
      continue;
    }

    modules.push({ moduleName, namespace: owner.namespace, uuid: owner.uuid, source, shape, consumerView: projection.required, inputs: [] });
  }

  const inputs = [...pkg.inputs];

  return { modules: modules.map(module => ({ ...module, inputs })), inputs, owns: true };
}
