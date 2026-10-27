import assert from 'node:assert/strict';
import ts from 'typescript';

/** Add an inert DOM event registration to the native text-field component. */
export function patchOreInputBundle(source: string): string {
  assert(!source.includes('__coreOreBindNativeInput'), 'Use an unmodified native Ore bundle');
  const file = ts.createSourceFile('gameplay.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches: { position: number; react: string; ref: string; change: string }[] = [];

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.body) {
      let marker = false;
      const changes = new Set<string>(), react = new Set<string>();
      const refs = new Set<string>();

      function inspect(child: ts.Node): void {
        if (ts.isStringLiteral(child) && child.text === 'BaseTextField') {
          marker = true;
        }

        if (ts.isBindingElement(child) && child.propertyName?.getText(file) === 'onChange' && ts.isIdentifier(child.name)) {
          changes.add(child.name.text);
        }

        if (ts.isPropertyAccessExpression(child) && ['useEffect', 'useCallback', 'useRef'].includes(child.name.text) && ts.isIdentifier(child.expression)) {
          react.add(child.expression.text);
        }

        ts.forEachChild(child, inspect);
      }

      inspect(node.body);

      if (marker && changes.size === 1 && react.size === 1) {
        const change = [...changes][0];

        function inputRef(child: ts.Node): void {
          if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === change) {
            const value = child.arguments[0];

            if (value && ts.isPropertyAccessExpression(value) && value.name.text === 'value' && ts.isPropertyAccessExpression(value.expression)
              && value.expression.name.text === 'current' && ts.isIdentifier(value.expression.expression)) {
              refs.add(value.expression.expression.text);
            }
          }

          ts.forEachChild(child, inputRef);
        }

        inputRef(node.body);
        const returns = node.body.statements.filter(ts.isReturnStatement);

        if (refs.size === 1 && returns.length === 1) {
          matches.push({ position: returns[0].getStart(file), react: [...react][0], ref: [...refs][0], change });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  assert.equal(matches.length, 1, 'Unsupported Ore text-field bundle: expected one BaseTextField callback/ref; live inputs require a compatible client');
  const { position, react, ref, change } = matches[0];
  const hook = `;${react}.useEffect(function(){var bind=window.__coreOreBindNativeInput;if(typeof bind==='function')return bind(${ref}.current,${change});},[${ref},${change}]);`;

  return source.slice(0, position) + hook + source.slice(position);
}
