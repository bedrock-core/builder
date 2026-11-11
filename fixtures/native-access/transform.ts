import ts from 'typescript';
import type { ResultKind } from './runtime.ts';
interface Operation {
  id: string;
  result: ResultKind;
  member?: string;
}
export interface Instrumented {
  code: string;
  operations: Record<string, number>;
}

/** Checked native operations and guarded erased JavaScript lookups share the same tracker. */
export function instrument(program: ts.Program, source: ts.SourceFile, runtimeImport: string, format: 'esm' | 'cjs' = source.fileName.endsWith('.cjs') ? 'cjs' : 'esm'): Instrumented {
  const checker = program.getTypeChecker();
  const operations: Record<string, number> = {};
  const javascript = /\.[cm]?js$/.test(source.fileName);
  const nativeDeclaration = (node: ts.Node | undefined): boolean => !!node && node.getSourceFile().fileName.replaceAll('\\', '/').includes('/@minecraft/server/');

  const locationError = (node: ts.Node, message: string): never => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));

    throw new Error(`${source.fileName}:${line + 1}:${character + 1}: ${message}`);
  };

  const nativeType = (type: ts.Type): boolean => type.isUnion() ? type.types.some(nativeType) : !!type.getSymbol()?.declarations?.some(nativeDeclaration);

  const unwrapped = (expression: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      expression = expression.expression;
    }

    return expression;
  };

  const javascriptOperation = (expression: ts.Expression, getter = false, seen = new Set<ts.Symbol>()): Operation | undefined => {
    if (!javascript) {
      return;
    }

    const node = unwrapped(expression);

    if (!getter && ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;

      if (symbol && !seen.has(symbol) && declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) {
        seen.add(symbol);

        return javascriptOperation(declaration.initializer, false, seen);
      }
    }

    if (!getter && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'bind') {
      return javascriptOperation(node.expression.expression, false, seen);
    }

    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
      return;
    }

    if (!(checker.getTypeAtLocation(node.expression).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
      return;
    }

    if (getter && ((ts.isBinaryExpression(node.parent) && node.parent.left === node)
      || ts.isDeleteExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent)
      || (ts.isPrefixUnaryExpression(node.parent) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.parent.operator))
      || ((ts.isForInStatement(node.parent) || ts.isForOfStatement(node.parent)) && node.parent.initializer === node))) {
      return;
    }

    const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;

    // Erased calls are candidates. Runtime infers operations only from real native roots or
    // previously captured receivers, so ordinary lookalikes cannot invent provenance.
    if (key && (getter ? key === 'container' : ['getComponent', 'getSlot'].includes(key))) {
      return { id: '', member: key, result: 'native' };
    }
  };

  const nativeSource = (node: ts.Expression, seen = new Set<ts.Symbol>()): ts.Type | undefined => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(node));

    if (nativeType(type)) {
      return type;
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return nativeSource(node.expression, seen);
    }

    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;

      if (symbol && !seen.has(symbol) && declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) {
        seen.add(symbol);

        return nativeSource(declaration.initializer, seen);
      }
    }
  };

  const resultKind = (type: ts.Type): ResultKind => {
    if (type.isUnion()) {
      return type.types.map(resultKind).find(kind => kind !== 'data') ?? 'data';
    }

    if (!(type.flags & ts.TypeFlags.Object)) {
      return 'data';
    }

    const symbol = type.getSymbol();

    if (!symbol?.declarations?.some(node => nativeDeclaration(node) && ts.isClassDeclaration(node))) {
      return 'data';
    }

    if (['Entity', 'Player'].includes(symbol.name)) {
      return 'entity';
    }

    if (symbol.name === 'Dimension') {
      return 'dimension';
    }

    if (symbol.name === 'Block') {
      return 'block';
    }

    if (symbol.name === 'World') {
      return 'data';
    }

    return 'native';
  };

  const operation = (declaration: ts.SignatureDeclaration | ts.Declaration | undefined, name: string, result: ts.Type): Operation | undefined => {
    if (!nativeDeclaration(declaration)) {
      return;
    }

    const parent = declaration!.parent;
    const owner = ts.isClassDeclaration(parent) && parent.name ? parent.name.text : 'module';
    const kind = resultKind(result);

    // Identity roots are resolved directly; ordinary data needs no provenance.
    if (kind !== 'native' || owner === 'module') {
      return;
    }

    return { id: `${owner}.${name}`, result: kind };
  };

  const callable = (expression: ts.Expression): Operation | undefined => {
    const signature = checker.getNonNullableType(checker.getTypeAtLocation(expression)).getCallSignatures()[0];
    const name = signature?.getDeclaration()?.name?.getText() ?? (ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText(source));
    const declared = signature && operation(signature.getDeclaration(), name, checker.getReturnTypeOfSignature(signature));

    return declared ?? (signature && resultKind(checker.getReturnTypeOfSignature(signature)) === 'native' ? { id: '', member: name, result: 'native' } : javascriptOperation(expression));
  };

  const callOperation = (node: ts.CallExpression): Operation | undefined => {
    const callee = unwrapped(node.expression);
    const signature = checker.getResolvedSignature(node);
    const name = signature?.getDeclaration()?.name?.getText() ?? (ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(source));
    const declared = signature && operation(signature.getDeclaration(), name, checker.getTypeAtLocation(node));

    if (declared) {
      return declared;
    }

    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const key = ts.isPropertyAccessExpression(callee) ? callee.name.text : checker.getTypeAtLocation(callee.argumentExpression).isStringLiteral() ? checker.getTypeAtLocation(callee.argumentExpression) as ts.StringLiteralType : undefined;
      const member = typeof key === 'string' ? key : key?.value;
      const receiver = nativeSource(callee.expression);
      const property = receiver && member ? checker.getPropertyOfType(receiver, member) : undefined;
      const nativeSignature = property && checker.getTypeOfSymbolAtLocation(property, callee).getCallSignatures()[0];
      const recovered = nativeSignature && operation(nativeSignature.getDeclaration(), member!, checker.getReturnTypeOfSignature(nativeSignature));

      if (recovered) {
        return recovered;
      }

      if (member && resultKind(checker.getTypeAtLocation(node)) === 'native') {
        return { id: '', member, result: 'native' };
      }
    }

    if (resultKind(checker.getTypeAtLocation(node)) === 'native') {
      return { id: '', member: name, result: 'native' };
    }

    return javascriptOperation(callee);
  };

  const transformed = ts.transform(source, [(context) => {
    const f = context.factory;
    const helper = f.createUniqueName('__nativeAccess');
    const str = (value: string): ts.StringLiteral => f.createStringLiteral(value);

    const typeNode = (type: ts.Type): ts.TypeNode => {
      if (type.isUnion()) {
        return f.createUnionTypeNode(type.types.map(typeNode));
      }

      if (checker.isArrayType(type)) {
        return f.createArrayTypeNode(typeNode(checker.getTypeArguments(type as ts.TypeReference)[0]));
      }

      const symbol = type.getSymbol();

      if (symbol?.declarations?.some(node => nativeDeclaration(node) && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node)))) {
        return f.createImportTypeNode(f.createLiteralTypeNode(str('@minecraft/server')), undefined, f.createIdentifier(symbol.name));
      }

      return checker.typeToTypeNode(type, source, ts.NodeBuilderFlags.NoTruncation) ?? f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    };

    const typed = (expression: ts.Expression, node: ts.Node): ts.Expression => javascript ? expression : f.createAsExpression(expression, typeNode(checker.getTypeAtLocation(node)));
    const argsArray = (args: readonly ts.Expression[]): ts.ArrayLiteralExpression => f.createArrayLiteralExpression(args.map(arg => ts.visitNode(arg, visit) as ts.Expression));

    const emit = (method: string, args: ts.Expression[], op?: Operation): ts.CallExpression => {
      if (op) {
        const key = op.id || `lookup:${op.member}`;

        operations[key] = (operations[key] ?? 0) + 1;
      }

      return f.createCallExpression(f.createPropertyAccessExpression(helper, method), undefined, args);
    };

    const member = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): {
      receiver: ts.Expression;
      key: ts.Expression;
      name: string;
    } => {
      if (ts.isPropertyAccessExpression(node)) {
        return { receiver: node.expression, key: str(node.name.text), name: node.name.text };
      }

      const keyType = checker.getTypeAtLocation(node.argumentExpression);

      if (!keyType.isStringLiteral()) {
        return locationError(node, 'dynamic native member names require a known string literal');
      }

      return { receiver: node.expression, key: ts.visitNode(node.argumentExpression, visit) as ts.Expression, name: keyType.value };
    };

    const chain = (node: ts.Node): boolean => !!(node.flags & ts.NodeFlags.OptionalChain)
      && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node) || ts.isNonNullExpression(node));

    const trackedChain = (node: ts.Expression): boolean => {
      while (chain(node)) {
        if (ts.isCallExpression(node) && callOperation(node)) {
          return true;
        }

        if (ts.isCallExpression(node)) {
          const callee = unwrapped(node.expression);

          if (ts.isPropertyAccessExpression(callee) && ['bind', 'call', 'apply'].includes(callee.name.text) && callable(callee.expression)) {
            return true;
          }
        }

        if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && (resultKind(checker.getTypeAtLocation(node)) === 'native' || javascriptOperation(node, true))) {
          return true;
        }

        node = (node as ts.PropertyAccessExpression | ts.CallExpression | ts.NonNullExpression).expression;
      }

      return false;
    };

    const optional = (node: ts.Expression, bindResult = false): ts.Expression => {
      const steps: ts.Expression[] = [];
      let base = node;

      while (chain(base)) {
        steps.unshift(base);
        base = (base as ts.PropertyAccessExpression | ts.CallExpression | ts.NonNullExpression).expression;
      }

      const reference = unwrapped(base);
      const first = steps[0];

      if (first && ts.isCallExpression(first) && first.questionDotToken && (ts.isPropertyAccessExpression(reference) || ts.isElementAccessExpression(reference))) {
        base = reference;

        do {
          steps.unshift(base);
          base = (base as ts.PropertyAccessExpression).expression;
        } while (chain(base));
      }

      const withValue = (value: ts.Expression, original: ts.Expression, run: (name: ts.Expression) => ts.Expression): ts.Expression => {
        const name = f.createUniqueName('__nativeOptional');
        const parameter = f.createParameterDeclaration(undefined, undefined, name, undefined, javascript ? undefined : typeNode(checker.getTypeAtLocation(original)));

        return f.createCallExpression(f.createParenthesizedExpression(f.createArrowFunction(undefined, undefined, [parameter], undefined, undefined, run(javascript ? name : f.createNonNullExpression(name)))), undefined, [value]);
      };

      const guarded = (value: ts.Expression, enabled: boolean, run: () => ts.Expression): ts.Expression => enabled
        ? f.createConditionalExpression(f.createBinaryExpression(value, ts.SyntaxKind.EqualsEqualsToken, f.createNull()), undefined, f.createVoidZero(), undefined, run())
        : run();

      const next = (index: number, value: ts.Expression): ts.Expression => {
        const step = steps[index];

        if (!step) {
          return value;
        }

        if (ts.isNonNullExpression(step)) {
          return next(index + 1, value);
        }

        if (ts.isPropertyAccessExpression(step) || ts.isElementAccessExpression(step)) {
          const call = steps[index + 1];
          const entry = member(step);

          return withValue(value, step.expression, receiver => guarded(receiver, !!step.questionDotToken, () => {
            if (call && ts.isCallExpression(call)) {
              const borrowed = ['bind', 'call', 'apply'].includes(entry.name) ? callable(step.expression) : undefined;

              if (borrowed) {
                const args = argsArray(call.arguments);
                const owner = args.elements[0] ?? f.createVoidZero();
                const tail = f.createArrayLiteralExpression(args.elements.slice(1));
                const result = entry.name === 'bind'
                  ? emit('bind', [receiver, owner, tail, str(borrowed.id), str(borrowed.member ?? '')], borrowed)
                  : emit('invoke', [receiver, owner, entry.name === 'apply' ? args.elements[1] ?? f.createArrayLiteralExpression() : tail, str(borrowed.id), str(borrowed.result), str(borrowed.member ?? '')], borrowed);

                return next(index + 2, typed(result, call));
              }

              const op = callOperation(call);
              const read = f.createElementAccessExpression(receiver, entry.key);

              const invoke = (fn?: ts.Expression): ts.Expression => {
                const args = argsArray(call.arguments);
                const result = op
                  ? emit('invoke', [fn ?? read, receiver, args, str(op.id), str(op.result), str(entry.name)], op)
                  : f.createCallExpression(fn ? f.createPropertyAccessExpression(fn, 'call') : read, undefined, fn ? [receiver, ...args.elements] : [...args.elements]);

                return next(index + 2, typed(result, call));
              };

              return call.questionDotToken ? withValue(read, step, fn => guarded(fn, true, () => invoke(fn))) : invoke();
            }

            const type = checker.getTypeAtLocation(step);

            if (bindResult && index === steps.length - 1 && (checker.getNonNullableType(type).getCallSignatures().length || javascriptOperation(step))) {
              const op = callable(step);
              const read = f.createElementAccessExpression(receiver, entry.key);

              return withValue(read, step, fn => guarded(fn, true, () => typed(emit('bind', [fn, receiver, f.createArrayLiteralExpression(), str(op?.id ?? ''), str(op?.member ?? entry.name)], op), step)));
            }

            const receiverType = nativeSource(step.expression);
            const property = receiverType && checker.getPropertyOfType(receiverType, entry.name);
            const op = property && operation(property.valueDeclaration ?? property.declarations?.[0], entry.name, type);
            const selected = op ?? (resultKind(type) === 'native' ? { id: '', member: entry.name, result: 'native' as const } : javascriptOperation(step, true));
            const result = selected && !type.getCallSignatures().length && !type.getConstructSignatures().length
              ? typed(emit('get', [receiver, entry.key, str(selected.id), str(selected.result)], selected), step)
              : f.createElementAccessExpression(receiver, entry.key);

            return next(index + 1, result);
          }));
        }

        if (ts.isCallExpression(step)) {
          return withValue(value, step.expression, fn => guarded(fn, !!step.questionDotToken, () => {
            const op = callOperation(step);
            const result = op
              ? emit('invoke', [fn, f.createVoidZero(), argsArray(step.arguments), str(op.id), str(op.result)], op)
              : f.createCallExpression(fn, undefined, step.arguments.map(argument => ts.visitNode(argument, visit) as ts.Expression));

            return next(index + 1, typed(result, step));
          }));
        }

        return value;
      };

      return typed(next(0, ts.visitNode(base, visit) as ts.Expression), node);
    };

    const strictSource = ts.isExternalModule(source) || source.statements.some(statement => ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression) && statement.expression.text === 'use strict');
    const immutableBodies = new WeakMap<ts.Node, boolean>();

    const eagerArgument = (argument: ts.Expression, call: ts.CallExpression): boolean => {
      const value = unwrapped(argument);

      if (ts.isNumericLiteral(value) || ts.isStringLiteralLike(value)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind)) {
        return true;
      }

      if (!strictSource || !ts.isIdentifier(value)) {
        return false;
      }

      const parameter = checker.getSymbolAtLocation(value)?.valueDeclaration;
      let owner: ts.Node | undefined = call.parent;

      while (owner && !ts.isFunctionLike(owner)) {
        owner = owner.parent;
      }

      if (!parameter || !ts.isParameter(parameter) || parameter.parent !== owner) {
        return false;
      }

      const body = (owner as ts.FunctionLikeDeclaration).body;

      if (!body || (ts.isBlock(body) && (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])))) {
        return false;
      }

      const cached = immutableBodies.get(body);

      if (cached !== undefined) {
        return cached;
      }

      let immutable = true;

      const scan = (part: ts.Node): void => {
        if (ts.isFunctionLike(part) || (ts.isIdentifier(part) && part.text === 'arguments')
          || (ts.isBinaryExpression(part) && part.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && part.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
          || ts.isPostfixUnaryExpression(part)
          || (ts.isPrefixUnaryExpression(part) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(part.operator))
          || (ts.isCallExpression(part) && ts.isIdentifier(unwrapped(part.expression)) && unwrapped(part.expression).getText(source) === 'eval')) {
          immutable = false;
        }

        ts.forEachChild(part, scan);
      };

      scan(body);
      immutableBodies.set(body, immutable);

      return immutable;
    };

    const inventoryChain = (node: ts.CallExpression): ts.Expression | undefined => {
      const callee = node.expression;

      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'getSlot' || callee.questionDotToken
        || node.questionDotToken || node.arguments.length !== 1 || ts.isSpreadElement(node.arguments[0])) {
        return;
      }

      const container = unwrapped(callee.expression);

      if (!ts.isPropertyAccessExpression(container) || container.name.text !== 'container' || container.questionDotToken) {
        return;
      }

      const component = unwrapped(container.expression);

      if (!ts.isCallExpression(component) || component.questionDotToken || component.arguments.length !== 1
        || !ts.isStringLiteralLike(component.arguments[0]) || component.arguments[0].text !== 'minecraft:inventory') {
        return;
      }

      const getter = component.expression;

      if (!ts.isPropertyAccessExpression(getter) || getter.name.text !== 'getComponent' || getter.questionDotToken) {
        return;
      }

      const first = callOperation(component);
      const last = callOperation(node);

      if (!first || !last || (first.id && !['Entity.getComponent', 'Block.getComponent'].includes(first.id))
        || (last.id && last.id !== 'Container.getSlot') || (!javascript && (!first.id || !last.id))) {
        return;
      }

      let lexical = true;

      const check = (part: ts.Node): void => {
        if (ts.isAwaitExpression(part) || ts.isYieldExpression(part)
          || (ts.isCallExpression(part) && ts.isIdentifier(unwrapped(part.expression)) && unwrapped(part.expression).getText(source) === 'eval')) {
          lexical = false;
        }

        ts.forEachChild(part, check);
      };

      check(node.arguments[0]);

      if (!lexical) {
        return;
      }

      for (const key of [first.id || 'lookup:getComponent', first.id
        ? first.id === 'Entity.getComponent' ? 'EntityInventoryComponent.container' : 'BlockInventoryComponent.container'
        : 'lookup:container']) {
        operations[key] = (operations[key] ?? 0) + 1;
      }

      const eager = eagerArgument(node.arguments[0], node);
      const value = ts.visitNode(node.arguments[0], visit) as ts.Expression;
      const argument = eager ? value : f.createArrowFunction(undefined, undefined, [], undefined, undefined, value);

      return typed(emit('inventorySlot', [ts.visitNode(getter.expression, visit) as ts.Expression, argument, str(first.id), eager ? f.createFalse() : f.createTrue()], last), node);
    };

    const visit: ts.Visitor = (node) => {
      if (javascript && ts.isDeleteExpression(node)) {
        return node;
      }

      if (chain(node) && trackedChain(node as ts.Expression)) {
        return optional(node as ts.Expression);
      }

      if (ts.isCallExpression(node)) {
        const inventory = inventoryChain(node);

        if (inventory) {
          return inventory;
        }

        const callee = unwrapped(node.expression);

        if (ts.isPropertyAccessExpression(callee) && ['bind', 'call', 'apply'].includes(callee.name.text)) {
          const op = callable(callee.expression);

          if (op) {
            const fn = ts.visitNode(callee.expression, visit) as ts.Expression;
            const receiver = node.arguments[0] ? ts.visitNode(node.arguments[0], visit) as ts.Expression : f.createVoidZero();

            if (callee.name.text === 'bind') {
              return typed(emit('bind', [fn, receiver, argsArray(node.arguments.slice(1)), str(op.id), str(op.member ?? '')], op), node);
            }

            const args = callee.name.text === 'apply' ? (ts.visitNode(node.arguments[1], visit) as ts.Expression ?? f.createArrayLiteralExpression()) : argsArray(node.arguments.slice(1));

            return typed(emit('invoke', [fn, receiver, args, str(op.id), str(op.result), str(op.member ?? '')], op), node);
          }
        }

        const op = callOperation(node);

        if (op) {
          if (callee !== node.expression && chain(callee)) {
            return typed(emit('invoke', [typed(optional(callee, true), node.expression), f.createVoidZero(), argsArray(node.arguments), str(op.id), str(op.result), str(op.member ?? '')], op), node);
          }

          if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
            const entry = member(callee);

            const receiver = ts.visitNode(entry.receiver, visit) as ts.Expression;
            const args = argsArray(node.arguments);

            if (!op.id || callee !== node.expression) {
              const owner = f.createUniqueName('__nativeReceiver');
              const parameter = f.createParameterDeclaration(undefined, undefined, owner, undefined, javascript ? undefined : typeNode(checker.getTypeAtLocation(entry.receiver)));
              const result = emit('invoke', [f.createElementAccessExpression(owner, entry.key), owner, args, str(op.id), str(op.result), str(entry.name)], op);

              return typed(f.createCallExpression(f.createParenthesizedExpression(f.createArrowFunction(undefined, undefined, [parameter], undefined, undefined, result)), undefined, [receiver]), node);
            }

            const single = args.elements.length === 1 && !ts.isSpreadElement(args.elements[0]);

            return typed(emit(single ? 'call1' : 'call', [receiver, entry.key, single ? args.elements[0] : args, str(op.id), str(op.result)], op), node);
          }

          return typed(emit('invoke', [ts.visitNode(callee, visit) as ts.Expression, f.createVoidZero(), argsArray(node.arguments), str(op.id), str(op.result), str(op.member ?? '')], op), node);
        }
      }

      if (ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const op = signature && operation(signature.getDeclaration(), 'constructor', checker.getTypeAtLocation(node));

        if (op) {
          return typed(emit('construct', [ts.visitNode(node.expression, visit) as ts.Expression, argsArray(node.arguments ?? []), str(op.id)], op), node);
        }
      }

      if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
        const declaration = node.declarationList.declarations[0];
        const erased = javascript && declaration.initializer && !!(checker.getTypeAtLocation(declaration.initializer).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
          && ts.isObjectBindingPattern(declaration.name) && declaration.name.elements.some(binding => (binding.propertyName?.getText(source) ?? binding.name.getText(source)) === 'container')
          && declaration.name.elements.every(binding => !binding.dotDotDotToken && !binding.initializer && ts.isIdentifier(binding.name));

        if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer && (nativeType(checker.getTypeAtLocation(declaration.initializer)) || erased)) {
          const temp = f.createUniqueName('__nativeBinding');
          const declarations: ts.VariableDeclaration[] = [f.createVariableDeclaration(temp, undefined, undefined, ts.visitNode(declaration.initializer, visit) as ts.Expression)];

          for (const binding of declaration.name.elements) {
            if (binding.dotDotDotToken || binding.initializer || !ts.isIdentifier(binding.name)) {
              return locationError(binding, 'only flat native destructuring is supported by this prototype');
            }

            const name = binding.propertyName?.getText(source) ?? binding.name.text;
            const property = checker.getPropertyOfType(checker.getTypeAtLocation(declaration.initializer), name);
            const type = property && checker.getTypeOfSymbolAtLocation(property, binding);
            const op = (property && type && operation(property.valueDeclaration ?? property.declarations?.[0], name, type))
              ?? (erased && name === 'container' ? { id: '', member: name, result: 'native' as const } : undefined);
            const value = op && !type?.getCallSignatures().length ? typed(emit('get', [temp, str(name), str(op.id), str(op.result)], op), binding.name) : f.createPropertyAccessExpression(temp, name);

            declarations.push(f.createVariableDeclaration(binding.name, undefined, undefined, value));
          }

          return f.updateVariableStatement(node, node.modifiers, f.updateVariableDeclarationList(node.declarationList, declarations));
        }
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const target = nativeSource(node.expression);
        const type = checker.getTypeAtLocation(node);
        const erased = javascriptOperation(node, true);

        if (target || erased || (resultKind(type) === 'native' && (ts.isPropertyAccessExpression(node) || checker.getTypeAtLocation(node.argumentExpression).isStringLiteral()))) {
          const entry = member(node);
          const symbol = target && checker.getPropertyOfType(target, entry.name);

          if (type.getCallSignatures().length || type.getConstructSignatures().length) {
            return ts.visitEachChild(node, visit, context);
          }

          const op = (symbol && operation(symbol.valueDeclaration ?? symbol.declarations?.[0], entry.name, type))
            ?? (resultKind(type) === 'native' ? { id: '', member: entry.name, result: 'native' as const } : erased);

          if (op) {
            if (ts.isBinaryExpression(node.parent) && node.parent.left === node) {
              if (erased && !target) {
                return ts.visitEachChild(node, visit, context);
              }

              return locationError(node, 'native property assignments are outside this prototype; native method mutations are supported');
            }

            return typed(emit('get', [ts.visitNode(entry.receiver, visit) as ts.Expression, entry.key, str(op.id), str(op.result)], op), node);
          }
        }
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (file) => {
      const result = ts.visitEachChild(file, visit, context);

      if (!Object.keys(operations).length) {
        return result;
      }

      const declaration = format === 'cjs'
        ? f.createVariableStatement(undefined, f.createVariableDeclarationList([
            f.createVariableDeclaration(f.createObjectBindingPattern([f.createBindingElement(undefined, 'nativeAccess', helper)]), undefined, undefined,
              f.createCallExpression(f.createIdentifier('require'), undefined, [str(runtimeImport)])),
          ], ts.NodeFlags.Const))
        : f.createImportDeclaration(undefined, f.createImportClause(false, undefined, f.createNamedImports([f.createImportSpecifier(false, f.createIdentifier('nativeAccess'), helper)])), str(runtimeImport));

      let directives = 0;

      while (result.statements[directives] && ts.isExpressionStatement(result.statements[directives]) && ts.isStringLiteral((result.statements[directives] as ts.ExpressionStatement).expression)) {
        directives++;
      }

      return f.updateSourceFile(result, [...result.statements.slice(0, directives), declaration, ...result.statements.slice(directives)]);
    };
  }]);
  const code = ts.createPrinter().printFile(transformed.transformed[0] as ts.SourceFile);

  transformed.dispose();

  return { code, operations };
}
