import * as ts from './syntax.ts';
const marker = '@bedrock-core/ui/compiler/pure';
const callbackMarker = '@bedrock-core/ui/compiler/callback-props';

/**
 * Mark JSX components whose render bodies depend only on props, local constants
 * and immutable module scalars. The same source pass feeds build and runtime.
 * Hooks, calls, mutations, mutable globals and unknown syntax remain unoptimized.
 * Runtime additionally excludes object props, which may expose mutable engine data.
 * Function props are reusable only when every read forwards the value as a handler.
 */
export function markPureComponents(source: string, fileName = 'screen.tsx'): string {
  if (!/\.[jt]sx$/i.test(fileName) || !source.includes('<') || source.includes(marker)) {
    return source;
  }

  const name = fileName.replaceAll('\\', '/');

  using analysis = ts.analyzeSource(name, source);
  const { file, checker } = analysis;
  const symbol = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const scope = checker.getSymbolsInScope(file, ts.SymbolFlags.Value);

  if (scope.some(value => value.name === 'Object' || value.name === 'Symbol')) {
    return source;
  }

  const core = new Set<ts.Symbol>();
  const assigned = new Set<ts.Symbol>();
  let dynamicScope = false;

  const assign = (node: ts.Node): void => {
    if (ts.isShorthandPropertyAssignment(node)) {
      const value = checker.getShorthandAssignmentValueSymbol(node);

      if (value) {
        assigned.add(value);
      }

      return;
    }

    if (ts.isPropertyAssignment(node)) {
      assign(node.initializer);

      return;
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      assign(node.expression);

      return;
    }

    const value = symbol(node);

    if (value && ts.isIdentifier(node)) {
      assigned.add(value);
    } else {
      ts.forEachChild(node, assign);
    }
  };

  const writes = (node: ts.Node): void => {
    if (ts.isWithStatement(node) || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval')) {
      dynamicScope = true;
    }

    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      assign(node.initializer);
    }

    if ((ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    || ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))) {
      const target = ts.isBinaryExpression(node) ? node.left : node.operand;

      assign(target);
    }

    ts.forEachChild(node, writes);
  };

  writes(file);

  if (dynamicScope) {
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

    const names = ts.isNamespaceImport(bindings)
      ? [bindings.name]
      : bindings.elements.filter(binding => !binding.isTypeOnly).map(binding => binding.name);

    for (const name of names) {
      const value = symbol(name);

      if (value) {
        core.add(value);
      }
    }
  }

  const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
  const primitive = (node: ts.Expression): boolean => ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword;
  const binary = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

  const scalar = (input: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const node = unwrap(input);

    if (primitive(node)) {
      return true;
    }

    if (ts.isIdentifier(node)) {
      const value = symbol(node);

      if (!value) {
        return ['undefined', 'NaN', 'Infinity'].includes(node.text);
      }

      if (seen.has(value) || assigned.has(value)) {
        return false;
      }

      const declaration = value.valueDeclaration?.resolve();

      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
        return false;
      }

      return scalar(declaration.initializer, new Set([...seen, value]));
    }

    if (ts.isPrefixUnaryExpression(node)) {
      return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken].includes(node.operator) && scalar(node.operand, seen);
    }

    if (ts.isBinaryExpression(node)) {
      return binary.has(node.operatorToken.kind) && scalar(node.left, seen) && scalar(node.right, seen);
    }

    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.every(span => scalar(span.expression, seen));
    }

    return false;
  };

  const stableTag = (node: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(node)) {
      let root: ts.Expression = node.expression;

      while (ts.isPropertyAccessExpression(root)) {
        root = root.expression;
      }

      const value = symbol(root);

      return value !== undefined && core.has(value) && !assigned.has(value);
    }

    const value = symbol(node);

    if (!value || assigned.has(value)) {
      return false;
    }

    if (core.has(value)) {
      return true;
    }

    const declaration = value.valueDeclaration?.resolve();

    return declaration !== undefined && (ts.isFunctionDeclaration(declaration)
      || (ts.isVariableDeclaration(declaration) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
        && declaration.initializer !== undefined
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))));
  };

  const edits: {
    end: number;
    name: string;
    callbacks: string[];
  }[] = [];

  const analyze = (name: ts.Identifier, fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction, end: number): void => {
    if (!fn.body || fn.asteriskToken || fn.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword)) {
      return;
    }

    const value = symbol(name);

    if (!value || assigned.has(value)) {
      return;
    }

    const locals = new Set<ts.Symbol>();
    const props = new Set<ts.Symbol>();
    const propBindings = new Map<ts.Symbol, string>();
    const forwarded = new Set<string>();
    const read = new Set<string>();
    let escapes = false;
    let hasJsx = false;

    const bind = (binding: ts.BindingName): boolean => {
      if (ts.isIdentifier(binding)) {
        const value = symbol(binding);

        if (value) {
          locals.add(value);
        }

        return value !== undefined;
      }

      return binding.elements.every(item => ts.isOmittedExpression(item) || item.name === undefined
        || ((!item.initializer || scalar(item.initializer)) && !item.dotDotDotToken
          && (!item.propertyName || !ts.isComputedPropertyName(item.propertyName)) && bind(item.name)));
    };

    if (!fn.parameters.every(parameter => !parameter.dotDotDotToken
      && (!parameter.initializer || scalar(parameter.initializer)) && bind(parameter.name))) {
      return;
    }

    for (const parameter of fn.parameters) {
      const value = ts.isIdentifier(parameter.name) && symbol(parameter.name);

      if (value) {
        props.add(value);
      }

      if (ts.isObjectBindingPattern(parameter.name)) {
        for (const binding of parameter.name.elements) {
          if (!binding.name || !ts.isIdentifier(binding.name) || binding.dotDotDotToken) {
            continue;
          }

          const value = symbol(binding.name);
          const key = binding.propertyName ?? binding.name;

          if (value && (ts.isIdentifier(key) || ts.isStringLiteral(key))) {
            propBindings.set(value, key.text);
          }
        }
      }
    }

    const propReference = (node: ts.Expression): string | undefined => {
      if (ts.isIdentifier(node)) {
        const value = symbol(node);

        return value === undefined ? undefined : propBindings.get(value);
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const value = ts.isIdentifier(node.expression) ? symbol(node.expression) : undefined;

        if (value === undefined || !props.has(value)) {
          return undefined;
        }

        if (ts.isPropertyAccessExpression(node)) {
          return node.name.text;
        }

        const key = node.argumentExpression && unwrap(node.argumentExpression);

        if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
          return key.text;
        }

        escapes = true;
      }

      return undefined;
    };

    const pure = (input: ts.Expression, forwarding = false): boolean => {
      const node = unwrap(input);
      const prop = propReference(node);

      if (prop !== undefined) {
        (forwarding ? forwarded : read).add(prop);
      }

      if (primitive(node)) {
        return true;
      }

      if (ts.isIdentifier(node)) {
        const value = symbol(node);

        if (value !== undefined && props.has(value)) {
          escapes = true;
        }

        return (value !== undefined && locals.has(value)) || scalar(node);
      }

      if (ts.isPropertyAccessExpression(node)) {
        const value = ts.isIdentifier(node.expression) ? symbol(node.expression) : undefined;

        return value !== undefined && props.has(value);
      }

      if (ts.isElementAccessExpression(node)) {
        const value = ts.isIdentifier(node.expression) ? symbol(node.expression) : undefined;

        return value !== undefined && props.has(value)
          && !!node.argumentExpression && scalar(node.argumentExpression);
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

      if (ts.isTemplateExpression(node)) {
        return node.templateSpans.every(span => pure(span.expression));
      }

      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.every(item => ts.isOmittedExpression(item) || (!ts.isSpreadElement(item) && pure(item)));
      }

      if (ts.isObjectLiteralExpression(node)) {
        return node.properties.every(item => ts.isPropertyAssignment(item)
          ? !ts.isComputedPropertyName(item.name) && pure(item.initializer)
          : ts.isShorthandPropertyAssignment(item) && ts.isIdentifier(item.name) && pure(item.name));
      }

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;

        if (ts.isJsxNamespacedName(opening.tagName) || !stableTag(opening.tagName) || !opening.attributes.properties.every(item => ts.isJsxAttribute(item)
          && (!item.initializer || ts.isStringLiteral(item.initializer)
            || (ts.isJsxExpression(item.initializer) && !!item.initializer.expression
              && pure(item.initializer.expression, /^on[A-Z]/.test(item.name.getText(file))))))) {
          return false;
        }

        hasJsx = true;

        return !ts.isJsxElement(node) || node.children.every(child => ts.isJsxText(child)
          || (ts.isJsxExpression(child) ? !child.expression || pure(child.expression) : pure(child)));
      }

      if (ts.isJsxFragment(node)) {
        hasJsx = true;

        return node.children.every(child => ts.isJsxText(child)
          || (ts.isJsxExpression(child) ? !child.expression || pure(child.expression) : pure(child)));
      }

      return false;
    };

    let valid: boolean;

    if (ts.isBlock(fn.body)) {
      const statements = fn.body.statements;

      valid = statements.length > 0 && statements.every((statement, index) => {
        if (ts.isReturnStatement(statement)) {
          return index === statements.length - 1 && !!statement.expression && pure(statement.expression);
        }

        return ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
          && statement.declarationList.declarations.every(declaration => !!declaration.initializer && pure(declaration.initializer) && bind(declaration.name));
      }) && ts.isReturnStatement(statements[statements.length - 1]);
    } else {
      valid = pure(fn.body);
    }

    if (valid && hasJsx) {
      edits.push({ end, name: name.text, callbacks: escapes ? [] : [...forwarded].filter(key => !read.has(key)).sort() });
    }
  };

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      analyze(statement.name, statement, statement.end);
    }

    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of statement.declarationList.declarations) {
        const fn = declaration.initializer && unwrap(declaration.initializer);

        if (ts.isIdentifier(declaration.name) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          analyze(declaration.name, fn, statement.end);
        }
      }
    }
  }

  for (const { end, name, callbacks } of edits.sort((a, b) => b.end - a.end)) {
    const metadata = callbacks.length === 0
      ? ''
      : `Object.defineProperty(${name}, Symbol.for(${JSON.stringify(callbackMarker)}), { value: Object.freeze(${JSON.stringify(callbacks)}) });\n`;

    source = source.slice(0, end) + `\nObject.defineProperty(${name}, Symbol.for(${JSON.stringify(marker)}), { value: true });\n${metadata}` + source.slice(end);
  }

  return source;
}
