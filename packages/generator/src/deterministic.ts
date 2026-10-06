import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import path from 'node:path';

/** Recognize data expressions conservatively; arbitrary Node programs still execute. */
export async function deterministicData(files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    const content = await readFile(file, 'utf8');

    if (file.endsWith('.json')) {
      try {
        JSON.parse(content);
        continue;
      } catch {
        return false;
      }
    }

    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const bindings = new Set<string>();

    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
          return false;
        }

        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            return false;
          }

          bindings.add(declaration.name.text);
        }
      } else if (ts.isImportDeclaration(statement)) {
        if (!statement.importClause) {
          return false;
        }

        const clause = statement.importClause;

        if (!clause.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)
          && !statement.moduleSpecifier.text.startsWith('.') && !path.isAbsolute(statement.moduleSpecifier.text)) {
          return false;
        }

        if (clause.name) {
          bindings.add(clause.name.text);
        }

        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          clause.namedBindings.elements.forEach(element => bindings.add(element.name.text));
        } else if (clause.namedBindings) {
          bindings.add(clause.namedBindings.name.text);
        }
      }
    }

    function pure(node: ts.Node, names = bindings): boolean {
      if (ts.isIdentifier(node)) {
        return names.has(node.text);
      }

      if (ts.isLiteralExpression(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) {
        return true;
      }

      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
        return pure(node.expression, names);
      }

      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.every(element => pure(ts.isSpreadElement(element) ? element.expression : element, names));
      }

      if (ts.isObjectLiteralExpression(node)) {
        return node.properties.every((property) => {
          if (ts.isSpreadAssignment(property)) {
            return pure(property.expression, names);
          }

          if (ts.isShorthandPropertyAssignment(property)) {
            return !property.objectAssignmentInitializer && pure(property.name, names);
          }

          return ts.isPropertyAssignment(property)
            && (!ts.isComputedPropertyName(property.name) || pure(property.name.expression, names))
            && pure(property.initializer, names);
        });
      }

      if (ts.isArrowFunction(node)) {
        const local = new Set(names);

        for (const parameter of node.parameters) {
          if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) {
            return false;
          }

          local.add(parameter.name.text);
        }

        if (ts.isBlock(node.body)) {
          return node.body.statements.length === 1 && ts.isReturnStatement(node.body.statements[0])
            && !!node.body.statements[0].expression && pure(node.body.statements[0].expression, local);
        }

        return pure(node.body, local);
      }

      if (ts.isPropertyAccessExpression(node)) {
        return pure(node.expression, names);
      }

      if (ts.isElementAccessExpression(node)) {
        return pure(node.expression, names) && pure(node.argumentExpression, names);
      }

      if (ts.isBinaryExpression(node)) {
        return !(node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
          && pure(node.left, names) && pure(node.right, names);
      }

      if (ts.isPrefixUnaryExpression(node)) {
        return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(node.operator)
          && pure(node.operand, names);
      }

      if (ts.isConditionalExpression(node)) {
        return pure(node.condition, names) && pure(node.whenTrue, names) && pure(node.whenFalse, names);
      }

      if (ts.isTemplateExpression(node)) {
        return node.templateSpans.every(span => pure(span.expression, names));
      }

      return false;
    }

    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        if (!statement.declarationList.declarations.every(declaration => declaration.initializer && pure(declaration.initializer))) {
          return false;
        }
      } else if (ts.isExportAssignment(statement)) {
        if (!pure(statement.expression)) {
          return false;
        }
      } else if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)
        && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEmptyStatement(statement)) {
        return false;
      }

      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier) && !statement.moduleSpecifier.text.startsWith('.')
        && !path.isAbsolute(statement.moduleSpecifier.text)) {
        return false;
      }
    }
  }

  return true;
}
