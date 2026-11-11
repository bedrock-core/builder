import { createHash } from 'node:crypto';
import * as ts from './syntax.ts';
const marker = '@bedrock-core/ui/compiler/values';

/** Cache scalar formatting expressions in reactive components, using native semantic dependencies. */
export function cacheDerivedValues(source: string, fileName = 'screen.tsx', identity = fileName): string {
  if (!/\.[jt]sx$/i.test(fileName) || !source.includes('${') || source.includes(marker)) {
    return source;
  }

  using analysis = ts.analyzeSource(fileName, source);
  const { file, checker } = analysis;
  const symbol = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const names = new Set<string>();
  const writes = new Set<ts.Symbol>();
  const hooks = new Set<ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  let dynamic = false;

  const target = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return;
    }

    const value = ts.isShorthandPropertyAssignment(node)
      ? checker.getShorthandAssignmentValueSymbol(node)
      : ts.isIdentifier(node) ? symbol(node) : undefined;

    if (value) {
      writes.add(value);
    } else {
      ts.forEachChild(node, target);
    }
  };

  const scan = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }

    if (ts.isWithStatement(node) || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval')) {
      dynamic = true;
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      target(node.left);
    }

    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      target(node.operand);
    }

    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      target(node.initializer);
    }

    ts.forEachChild(node, scan);
  };

  scan(file);

  if (dynamic || checker.getSymbolsInScope(file, ts.SymbolFlags.Value).some(value => value.name === 'Reflect')) {
    return source;
  }

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !/^@bedrock-core\/(?:ui|ui-runtime)$/.test(statement.moduleSpecifier.text)
      || statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      continue;
    }

    const bindings = statement.importClause?.namedBindings;

    if (!bindings) {
      continue;
    }

    if (ts.isNamespaceImport(bindings)) {
      const value = symbol(bindings.name);

      if (value) {
        namespaces.add(value);
      }
    } else {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly && ['useState', 'useReducer', 'useContext'].includes(binding.propertyName?.text ?? binding.name.text)) {
          const value = symbol(binding.name);

          if (value) {
            hooks.add(value);
          }
        }
      }
    }
  }

  if (!hooks.size && !namespaces.size) {
    return source;
  }

  const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
  const contains = (outer: ts.Node, inner: ts.Node): boolean => inner.pos >= outer.pos && inner.end <= outer.end;
  const binary = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
  const edits: {
    start: number;
    end: number;
    text: string;
  }[] = [];

  const unique = (base: string): string => {
    let name = base;

    while (names.has(name)) {
      name += '_';
    }

    names.add(name);

    return name;
  };

  const helper = unique('__coreValue');
  const namespace = unique('__coreValueRuntime');

  const component = (fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): void => {
    if (!fn.body || !ts.isBlock(fn.body)) {
      return;
    }

    let jsx = false;
    let reactive = false;

    const inspect = (node: ts.Node): void => {
      if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
        return;
      }

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        jsx = true;
      }

      if (ts.isCallExpression(node)) {
        const call = unwrap(node.expression);
        const value = symbol(call);

        if (value && hooks.has(value) && !writes.has(value)) {
          reactive = true;
        }

        if (ts.isPropertyAccessExpression(call)) {
          const owner = symbol(call.expression);

          if (owner && namespaces.has(owner) && !writes.has(owner) && ['useState', 'useReducer', 'useContext'].includes(call.name.text)) {
            reactive = true;
          }
        }
      }

      ts.forEachChild(node, inspect);
    };

    inspect(fn);

    if (!jsx || !reactive) {
      return;
    }

    for (const statement of fn.body.statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }

        const captures = new Map<ts.Symbol, string>();
        let formats = false;

        const pure = (input: ts.Expression): boolean => {
          const node = unwrap(input);

          if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) {
            return true;
          }

          if (ts.isIdentifier(node)) {
            const value = symbol(node);
            const defined = value?.valueDeclaration?.resolve();

            if (!value || !defined || !contains(fn, defined) || writes.has(value)) {
              return false;
            }

            let binding: ts.Node = defined;

            while (ts.isBindingElement(binding) || ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
              binding = binding.parent;
            }

            const parameter = ts.isParameterDeclaration(binding);

            if (!parameter && (!ts.isVariableDeclaration(binding) || (binding.parent.flags & ts.NodeFlags.Const) === 0 || binding.end > declaration.getStart(file))) {
              return false;
            }

            if (contains(declaration, defined)) {
              return false;
            }

            captures.set(value, node.text);

            return true;
          }

          if (ts.isTemplateExpression(node)) {
            formats = true;

            return node.templateSpans.every(span => pure(span.expression));
          }

          if (ts.isPrefixUnaryExpression(node)) {
            return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken].includes(node.operator) && pure(node.operand);
          }

          if (ts.isBinaryExpression(node)) {
            return binary.has(node.operatorToken.kind) && pure(node.left) && pure(node.right);
          }

          if (ts.isConditionalExpression(node)) {
            return pure(node.condition) && pure(node.whenTrue) && pure(node.whenFalse);
          }

          return false;
        };

        if (!pure(declaration.initializer) || !formats || !captures.size) {
          continue;
        }

        const text = declaration.initializer.getText(file);
        const site = 'value:' + createHash('sha256').update(`${identity.replaceAll('\\', '/')}:${String(declaration.initializer.getStart(file))}:${text}`).digest('hex').slice(0, 20);

        edits.push({ start: declaration.initializer.getStart(file), end: declaration.initializer.end,
          text: `${helper}(${JSON.stringify(site)}, [${[...captures.values()].join(', ')}], () => (${text}))` });
      }
    }
  };

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      component(statement);
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          component(declaration.initializer);
        }
      }
    }
  }

  if (!edits.length) {
    return source;
  }

  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }

  return source + `\n/* ${marker} */\nimport * as ${namespace} from '@bedrock-core/ui/jsx-runtime';\nfunction ${helper}(site, dependencies, compute) { const cache = Reflect.get(${namespace}, '__cacheValue'); return typeof cache === 'function' ? cache(site, dependencies, compute) : compute(); }\n`;
}
