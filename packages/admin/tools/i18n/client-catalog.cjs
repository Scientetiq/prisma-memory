// Build-time catalog transform. Catalog text is request data; browser code keeps only the functions and lookup IDs.
const ts = require('typescript');
const { createHash } = require('node:crypto');
const { relative, resolve, dirname } = require('node:path');
const root = resolve(__dirname, '../..');
const printer = ts.createPrinter();
const f = ts.factory;
function catalogFile(file) { return /\/src\/messages\/[^/]+\/(en|ru)\.ts$/.test(file); }
function textId(file, node) {
  return createHash('sha256').update(relative(root, file).replaceAll('\\', '/') + ':' + node.getStart()).digest('hex').slice(0, 12);
}
function isText(node) {
  if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))) return false;
  const p = node.parent;
  return !(ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p)
    || ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === node));
}
function unbox(n) { while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression; return n; }
function pure(n) { return ts.addSyntheticLeadingComment(n, ts.SyntaxKind.MultiLineCommentTrivia, '#__PURE__', false); }

function compile(source, file, binding = {}) {
  const sf = binding.sourceFile ?? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const catalog = catalogFile(file);
  const locals = new Map();
  const localDeclarations = new Set();
  if (catalog) for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt) && !stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) { localDeclarations.add(d); locals.set(d.name.text, f.createVariableStatement(undefined, f.createVariableDeclarationList([d], ts.NodeFlags.Const))); }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) { localDeclarations.add(stmt); locals.set(stmt.name.text, stmt); }
  }
  function localDependencies(node, used = new Set()) {
    function scan(n) { if (ts.isIdentifier(n) && locals.has(n.text) && !used.has(n.text)) { used.add(n.text); scan(locals.get(n.text)); } ts.forEachChild(n, scan); }
    scan(node); return [...locals].filter(([name]) => used.has(name)).map(([, stmt]) => stmt);
  }
  const out = ts.transform(sf, [context => {
    const lookup = n => f.createCallExpression(f.createIdentifier('__clientText'), undefined, [f.createStringLiteral(textId(file, n))]);
    function visit(n) {
      if (ts.isTypeNode(n)) return n;
      if (catalog && ts.isIdentifier(n) && locals.has(n.text)) {
        const declarations = binding.checker?.getSymbolAtLocation(n)?.declarations ?? [];
        const parent = n.parent;
        const isName = parent && ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)
          || ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent) || ts.isParameter(parent)) && parent.name === n);
        if (!isName && (binding.checker ? declarations.some(d => localDeclarations.has(d)) : true)) {
          return f.createPropertyAccessExpression(f.createIdentifier('__locals'), n.text);
        }
      }
      // Locale self-names are the two intentional labels in the language chooser, available before hydration.
      if (file.endsWith('/messages/language/index.ts') && ts.isPropertyAccessExpression(n)
        && n.name.text === 'name' && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'language' && ts.isIdentifier(n.expression.expression)
        && ['en', 'ru'].includes(n.expression.expression.text)) {
        const locale = n.expression.expression.text;
        const text = require('node:fs').readFileSync(resolve(dirname(file), locale + '.ts'), 'utf8');
        const pack = ts.createSourceFile(locale + '.ts', text, ts.ScriptTarget.Latest, true);
        let label;
        const scan = node => { if (ts.isPropertyAssignment(node) && node.name.getText(pack) === 'name' && ts.isStringLiteral(node.initializer)) label = node.initializer.text; ts.forEachChild(node, scan); };
        scan(pack);
        if (!label) throw new Error('Missing locale self-name: ' + locale);
        return f.createStringLiteral(label);
      }
      if (catalog && ts.isTemplateExpression(n)) {
        let result = lookup(n.head);
        for (const span of n.templateSpans) {
          // Template interpolation always converts to a string, including numbers and null.
          result = f.createBinaryExpression(f.createBinaryExpression(result, ts.SyntaxKind.PlusToken, f.createTemplateExpression(f.createTemplateHead(''), [f.createTemplateSpan(ts.visitNode(span.expression, visit), f.createTemplateTail(''))])), ts.SyntaxKind.PlusToken, lookup(span.literal));
        }
        return result;
      }
      if (catalog && isText(n)) return lookup(n);
      if (catalog && ts.isPropertyAssignment(n) && !ts.isComputedPropertyName(n.name)) {
        return f.createGetAccessorDeclaration(undefined, n.name, [], undefined,
          f.createBlock([f.createReturnStatement(ts.visitNode(n.initializer, visit))], true));
      }
      // The shared settings editor selects one section. Building the other section specs must not read their text.
      if (!catalog && file.endsWith('/components/section-settings-form.tsx') && ts.isCallExpression(n)
        && ts.isIdentifier(n.expression) && n.expression.text === 'derived' && n.arguments.length === 1
        && ts.isArrowFunction(n.arguments[0])) {
        const callback = n.arguments[0], object = unbox(callback.body);
        if (ts.isObjectLiteralExpression(object)) {
          const properties = object.properties.map(p => ts.isPropertyAssignment(p)
            ? f.createGetAccessorDeclaration(undefined, p.name, [], undefined, f.createBlock([f.createReturnStatement(ts.visitNode(p.initializer, visit))], true)) : p);
          const body = f.createParenthesizedExpression(f.updateObjectLiteralExpression(object, properties));
          return pure(f.updateCallExpression(n, n.expression, n.typeArguments, [f.updateArrowFunction(callback, callback.modifiers, callback.typeParameters, callback.parameters, callback.type, callback.equalsGreaterThanToken, body)]));
        }
      }
      // These typed proxy constructors have no observable effects for catalog constants. Keep unused exports removable.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (['localized', 'derived', 'derivedList'].includes(n.expression.text) || (file.endsWith('/lib/setting-labels.ts') && n.expression.text === 'L'))) {
        return pure(ts.visitEachChild(n, visit, context));
      }
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Proxy' && file.endsWith('/lib/setting-labels.ts')) return pure(ts.visitEachChild(n, visit, context));
      return ts.visitEachChild(n, visit, context);
    }
    if (!catalog) return node => ts.visitNode(node, visit);
    return node => {
      const statements = [];
      let helper = relative(dirname(file), resolve(root, 'src/i18n/client-data.ts')).replaceAll('\\', '/').replace(/\.ts$/, '');
      if (!helper.startsWith('.')) helper = './' + helper;
      statements.push(f.createImportDeclaration(undefined, f.createImportClause(false, undefined, f.createNamedImports([
        f.createImportSpecifier(false, f.createIdentifier('clientText'), f.createIdentifier('__clientText')),
        f.createImportSpecifier(false, f.createIdentifier('clientCatalog'), f.createIdentifier('__clientCatalog')),
        f.createImportSpecifier(false, f.createIdentifier('clientLocal'), f.createIdentifier('__clientLocal')),
      ])), f.createStringLiteral(helper)));
      for (const stmt of node.statements) {
        if (ts.isImportDeclaration(stmt)) { statements.push(stmt); continue; }
        if (!ts.isVariableStatement(stmt) || !stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        const declarations = stmt.declarationList.declarations.map(d => {
          if (!d.initializer) return d;
          const init = unbox(d.initializer);
          if (ts.isStringLiteral(init)) return f.updateVariableDeclaration(d, d.name, d.exclamationToken, d.type, init);
          if (!ts.isObjectLiteralExpression(init) && !ts.isArrayLiteralExpression(init)) throw new Error(`Client catalog export must be an object or array: ${file}:${d.name.getText(sf)}`);
          const dependencies = localDependencies(d.initializer);
          const props = dependencies.map(stmt => {
            const declaration = ts.isVariableStatement(stmt) ? stmt.declarationList.declarations[0] : stmt;
            const name = declaration.name.text;
            const expression = ts.isVariableDeclaration(declaration) ? declaration.initializer
              : f.createFunctionExpression(undefined, declaration.asteriskToken, declaration.name, declaration.typeParameters, declaration.parameters, declaration.type, declaration.body);
            return f.createGetAccessorDeclaration(undefined, name, [], undefined, f.createBlock([
              f.createReturnStatement(f.createCallExpression(f.createIdentifier('__clientLocal'), undefined, [
                f.createIdentifier('__cache'), f.createStringLiteral(name),
                f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.visitNode(expression, visit)),
              ])),
            ], true));
          });
          const local = (name, value) => f.createVariableStatement(undefined, f.createVariableDeclarationList([
            f.createVariableDeclaration(name, undefined, undefined, value),
          ], ts.NodeFlags.Const));
          const body = [
            ...(dependencies.length ? [local('__cache', f.createNewExpression(f.createIdentifier('Map'), undefined, [])), local('__locals', f.createObjectLiteralExpression(props, true))] : []),
            f.createReturnStatement(ts.visitNode(d.initializer, visit)),
          ];
          const call = pure(f.createCallExpression(f.createIdentifier('__clientCatalog'), undefined, [
            f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), f.createBlock(body, true)),
            ts.isArrayLiteralExpression(init) ? f.createTrue() : f.createFalse(),
          ]));
          return f.updateVariableDeclaration(d, d.name, d.exclamationToken, d.type, call);
        });
        statements.push(f.updateVariableStatement(stmt, stmt.modifiers, f.updateVariableDeclarationList(stmt.declarationList, declarations)));
      }
      return f.updateSourceFile(node, statements);
    };
  }]);
  try { return printer.printFile(out.transformed[0]); } finally { out.dispose(); }
}
module.exports = function loader(source) { return compile(source, this.resourcePath); };
module.exports.compile = compile;
module.exports.textId = textId;
module.exports.isText = isText;
module.exports.catalogFile = catalogFile;
