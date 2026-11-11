import { createHash } from 'node:crypto';
import path from 'node:path';
import * as ts from './syntax.ts';
const marker = '@bedrock-core/ui/compiler/callbacks';

/** Stabilize callback sites with native semantic capture analysis, without author annotations. */
export function callbackSourceId(fileName: string, root: string): string {
  const relative = path.relative(root, fileName);

  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    ? relative.replaceAll('\\', '/')
    : fileName.replaceAll('\\', '/');
}

export function cacheInlineCallbacks(source: string, fileName = 'screen.tsx', identity = fileName): string {
  if (!/\.[jt]sx$/i.test(fileName) || !source.includes('=>') || source.includes(marker)) {
    return source;
  }

  using analysis = ts.analyzeSource(fileName, source);
  const { file, checker } = analysis;
  const symbol = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
  const names = new Set<string>();
  const writes = new Set<ts.Symbol>();
  let dynamic = false;

  const scanTarget = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return;
    }

    const value = ts.isShorthandPropertyAssignment(node)
      ? checker.getShorthandAssignmentValueSymbol(node)
      : ts.isIdentifier(node) ? symbol(node) : undefined;

    if (value) {
      writes.add(value);
    } else {
      ts.forEachChild(node, scanTarget);
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
      scanTarget(node.left);
    }

    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      scanTarget(node.operand);
    }

    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      scanTarget(node.initializer);
    }

    ts.forEachChild(node, scan);
  };

  scan(file);

  if (dynamic || checker.getSymbolsInScope(file, ts.SymbolFlags.Value).some(value => value.name === 'Reflect')) {
    return source;
  }

  if (!file.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
    && /^@bedrock-core\/(?:ui|ui-runtime)$/.test(statement.moduleSpecifier.text))) {
    return source;
  }

  const unique = (base: string): string => {
    let name = base;

    while (names.has(name)) {
      name += '_';
    }

    names.add(name);

    return name;
  };

  const namespace = unique('__coreCallbackRuntime');
  const helper = unique('__coreCallback');
  const contains = (outer: ts.Node, inner: ts.Node): boolean => inner.pos >= outer.pos && inner.end <= outer.end;
  const edits: {
    start: number;
    end: number;
    text: string;
  }[] = [];

  const analyze = (component: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction): void => {
    if (!component.body) {
      return;
    }

    let jsx = false;

    const findJsx = (node: ts.Node): void => {
      if (node !== component && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
        return;
      }

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        jsx = true;
      }

      ts.forEachChild(node, findJsx);
    };

    findJsx(component);

    if (!jsx) {
      return;
    }

    const immutable = (declaration: ts.Node): boolean => {
      let binding = declaration;

      while (ts.isBindingElement(binding) || ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
        binding = binding.parent;
      }

      return ts.isParameterDeclaration(binding) || (ts.isVariableDeclaration(binding) && (binding.parent.flags & ts.NodeFlags.Const) !== 0);
    };

    const candidate = (callback: ts.ArrowFunction): void => {
      const parent = callback.parent;
      const attribute = ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent) && /^on[A-Z]/.test(parent.parent.name.getText(file));
      const variable = ts.isVariableDeclaration(parent) && parent.initializer === callback && (parent.parent.flags & ts.NodeFlags.Const) !== 0;

      if (!attribute && !variable) {
        return;
      }

      const captures = new Map<ts.Symbol, string>();
      let safe = true;

      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword
          || (ts.isIdentifier(node) && node.text === 'arguments') || ts.isMetaProperty(node)) {
          safe = false;
        }

        if (ts.isIdentifier(node)) {
          const parent = node.parent;

          if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
            || (ts.isPropertyAssignment(parent) && parent.name === node)
            || (ts.isBindingElement(parent) && parent.propertyName === node)) {
            return;
          }

          const value = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : symbol(node);
          const declaration = value?.valueDeclaration?.resolve();

          if (value && declaration && contains(component, declaration) && !contains(callback, declaration)) {
            if (!immutable(declaration) || writes.has(value) || contains(declaration, callback)
              || declaration.getStart(file) >= callback.getStart(file)) {
              safe = false;
            }

            captures.set(value, node.text);
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(callback);

      if (!safe) {
        return;
      }

      const text = callback.getText(file);
      const site = createHash('sha256').update(`${identity.replaceAll('\\', '/')}:${String(callback.getStart(file))}:${text}`).digest('hex').slice(0, 20);

      edits.push({ start: callback.getStart(file), end: callback.end, text: `${helper}(${JSON.stringify(site)}, [${[...captures.values()].join(', ')}], ${text})` });
    };

    const visit = (node: ts.Node): void => {
      if (node !== component && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
        if (ts.isArrowFunction(node)) {
          candidate(node);
        }

        return;
      }

      if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(component);
  };

  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      analyze(statement);
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          analyze(declaration.initializer);
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

  const support = `\n/* ${marker} */\nimport * as ${namespace} from '@bedrock-core/ui/jsx-runtime';\nfunction ${helper}(site, dependencies, callback) { const cache = Reflect.get(${namespace}, '__cacheCallback'); return typeof cache === 'function' ? cache(site, dependencies, callback) : callback; }\n`;

  return source + support;
}
