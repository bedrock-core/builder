import ts from 'typescript';

/** Mark Core text expressions whose values cannot be proven constant from their source. */
export function markRuntimeText(source: string, fileName = 'screen.tsx'): string {
  if (!source.includes('Text')) {
    return source;
  }

  const name = fileName.replaceAll('\\', '/');
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/i.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);

  host.getSourceFile = candidate => candidate.replaceAll('\\', '/') === name ? file : undefined;
  host.fileExists = candidate => candidate.replaceAll('\\', '/') === name;
  host.readFile = candidate => candidate.replaceAll('\\', '/') === name ? source : undefined;

  const checker = ts.createProgram([name], options, host).getTypeChecker();
  const texts = new Set<ts.Symbol>();
  const namespaces = new Set<ts.Symbol>();
  const factories = new Set<ts.Symbol>();
  const symbol = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);

  const remember = (set: Set<ts.Symbol>, node: ts.Node): void => {
    const value = symbol(node);

    if (value !== undefined) {
      set.add(value);
    }
  };

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    const core = /^@bedrock-core\/(?:ui|ui-runtime)$/.test(specifier)
      || (name.includes('/ui-runtime/') && specifier.startsWith('.') && /(?:^|\/)(?:Text|components)(?:\.[jt]sx?)?$/.test(specifier));
    const factory = /^@bedrock-core\/(?:ui|ui-runtime)\/jsx(?:-dev)?-runtime$/.test(specifier);
    const bindings = statement.importClause?.namedBindings;

    if (bindings === undefined) {
      continue;
    }

    if (ts.isNamespaceImport(bindings)) {
      if (core) {
        remember(namespaces, bindings.name);
      }
    } else {
      for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;

        if (!binding.isTypeOnly && core && imported === 'Text') {
          remember(texts, binding.name);
        }

        if (!binding.isTypeOnly && factory && /^(?:jsx|jsxs|jsxDEV)$/.test(imported)) {
          remember(factories, binding.name);
        }
      }
    }
  }

  if (texts.size === 0 && namespaces.size === 0) {
    return source;
  }

  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)
      ? unwrap(node.expression)
      : node;

  const isText = (input: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const node = unwrap(input);

    if (ts.isPropertyAccessExpression(node)) {
      const owner = symbol(node.expression);

      return node.name.text === 'Text' && owner !== undefined && namespaces.has(owner);
    }

    const value = symbol(node);

    if (value === undefined || seen.has(value)) {
      return false;
    }

    if (texts.has(value)) {
      return true;
    }

    seen.add(value);
    const declaration = value.valueDeclaration;

    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && isText(declaration.initializer, seen);
  };

  const constant = (input: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
    const node = unwrap(input);

    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
      return true;
    }

    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.every(span => constant(span.expression, new Set(seen)));
    }

    if (ts.isPrefixUnaryExpression(node)) {
      return constant(node.operand, seen);
    }

    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every(item => !ts.isSpreadElement(item) && constant(item, new Set(seen)));
    }

    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every(item => ts.isPropertyAssignment(item) && !ts.isComputedPropertyName(item.name) && constant(item.initializer, new Set(seen)));
    }

    if (!ts.isIdentifier(node)) {
      return false;
    }

    const value = symbol(node);

    if (value === undefined || seen.has(value)) {
      return false;
    }

    seen.add(value);
    const declaration = value.valueDeclaration;

    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
      return false;
    }

    const initializer = unwrap(declaration.initializer);

    return !ts.isObjectLiteralExpression(initializer) && !ts.isArrayLiteralExpression(initializer) && constant(initializer, seen);
  };

  const edits: { at: number; text: string }[] = [];
  const propertyName = (node: ts.Node & { name?: ts.PropertyName }): string | undefined =>
    node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;

  const markObject = (input: ts.Expression): void => {
    const node = unwrap(input);

    if (!ts.isObjectLiteralExpression(node)) {
      edits.push({ at: input.getStart(file), text: '{ ...(' }, { at: input.end, text: '), __textDynamic: true }' });

      return;
    }

    if (node.properties.some(item => propertyName(item) === '__textDynamic')) {
      return;
    }

    const caption = node.properties.findLast(item => propertyName(item) === 'children');
    const lastSpread = node.properties.findLastIndex(ts.isSpreadAssignment);

    if (caption === undefined && lastSpread < 0) {
      return;
    }

    if (caption !== undefined && node.properties.indexOf(caption) > lastSpread && ts.isPropertyAssignment(caption) && constant(caption.initializer)) {
      return;
    }

    edits.push({ at: node.end - 1, text: (node.properties.length > 0 && !node.properties.hasTrailingComma ? ', ' : ' ') + '__textDynamic: true' });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;

      if (!ts.isJsxNamespacedName(opening.tagName) && isText(opening.tagName) && !opening.attributes.properties.some(item => ts.isJsxAttribute(item) && item.name.getText(file) === '__textDynamic')) {
        const attributes = opening.attributes.properties;
        const caption = attributes.find(item => ts.isJsxAttribute(item) && item.name.getText(file) === 'children');
        const dynamicAttribute = caption !== undefined && ts.isJsxAttribute(caption) && caption.initializer !== undefined
          && ts.isJsxExpression(caption.initializer) && caption.initializer.expression !== undefined && !constant(caption.initializer.expression);
        const dynamicChildren = ts.isJsxElement(node) && node.children.some(child => ts.isJsxExpression(child) && child.expression !== undefined && !constant(child.expression));

        if (dynamicChildren || dynamicAttribute || attributes.some(ts.isJsxSpreadAttribute)) {
          edits.push({ at: opening.attributes.end, text: ' __textDynamic={true}' });
        }
      }
    } else if (ts.isCallExpression(node)) {
      if (isText(node.expression) && node.arguments[0] !== undefined) {
        markObject(node.arguments[0]);
      } else {
        const factory = symbol(node.expression);

        if (factory !== undefined && factories.has(factory) && node.arguments[0] !== undefined && isText(node.arguments[0]) && node.arguments[1] !== undefined) {
          markObject(node.arguments[1]);
        }
      }
    }

    node.forEachChild(visit);
  };

  visit(file);
  edits.sort((a, b) => b.at - a.at);

  let result = source;

  for (const edit of edits) {
    result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
  }

  return result;
}
