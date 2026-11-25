// Give the bundler a real module boundary for each pure dictionary/helper. A PURE comment alone does not remove
// unused namespace exports in Turbopack. The generated subtree declares its lack of side effects explicitly.
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const { compile, catalogFile } = require('./client-catalog.cjs');
const root = path.resolve(__dirname, '../..');
const PURE_LIBS = new Set(['plain', 'labels', 'stages', 'stage-errors', 'closed-class', 'mime-plain', 'meeting-state', 'process-state', 'setting-labels']);
function splitFile(file) { return file.includes('/src/messages/') || (path.dirname(file) === root + '/src/lib' && PURE_LIBS.has(path.basename(file, '.ts'))); }
function modulePath(file) { return root + '/.i18n/client/' + path.relative(root + '/src', file).replace(/\.tsx?$/, ''); }
function ref(from, target) { let p = path.relative(path.dirname(from), target).replaceAll('\\', '/').replace(/\.tsx?$/, ''); return p.startsWith('.') ? p : './' + p; }
// Keys of .i18n/client-barrels.json are relative to the package root, so the file names no folder of the machine that built it.
function barrelKey(file) { return path.relative(root, file).replaceAll('\\', '/'); }
function generateFile(file, source, program, checker) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter();
  const compiledCatalog = catalogFile(file) ? compile(source, file, { sourceFile: program?.getSourceFile(file), checker }) : null;
  const exports = new Map(), locals = new Map();
  const hasExport = n => n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) {
        const statement = ts.factory.updateVariableStatement(stmt, stmt.modifiers, ts.factory.updateVariableDeclarationList(stmt.declarationList, [d]));
        (hasExport(stmt) ? exports : locals).set(d.name.text, statement);
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) (hasExport(stmt) ? exports : locals).set(stmt.name.text, stmt);
  }
  const directory = modulePath(file);
  fs.mkdirSync(directory, { recursive: true });
  const barrel = [];
  for (const [name, stmt] of exports) {
    const dest = directory + '/' + name + '.ts';
    const selected = new Set(), needed = new Set();
    function refs(n) {
      if (ts.isIdentifier(n)) {
        if (locals.has(n.text) && !selected.has(n.text)) { selected.add(n.text); refs(locals.get(n.text)); }
        if (exports.has(n.text) && n.text !== name) needed.add(n.text);
      }
      ts.forEachChild(n, refs);
    }
    refs(stmt);
    let code;
    if (catalogFile(file)) {
      // Keep original positions for stable text IDs; compile first, then select the named declaration.
      const compiled = ts.createSourceFile(dest, compiledCatalog, ts.ScriptTarget.Latest, true);
      code = printer.printFile(ts.factory.updateSourceFile(compiled, compiled.statements.filter(s => ts.isImportDeclaration(s)
        || (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(compiled) === name)))));
    } else {
      const nodes = [...sf.statements.filter(ts.isImportDeclaration), ...[...locals].filter(([key]) => selected.has(key)).map(([, s]) => s), stmt];
      code = compile(printer.printFile(ts.factory.updateSourceFile(sf, nodes)), file);
    }
    // Relocate original imports and the browser data helper from their source directory to the generated module.
    const parsed = ts.createSourceFile(dest, code, ts.ScriptTarget.Latest, true);
    const edits = [];
    for (const s of parsed.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const spec = s.moduleSpecifier.text;
      if (spec.startsWith('.')) edits.push({ start: s.moduleSpecifier.getStart(parsed), end: s.moduleSpecifier.end, text: JSON.stringify(ref(dest, path.resolve(path.dirname(file), spec))) });
    }
    for (const e of edits.reverse()) code = code.slice(0, e.start) + e.text + code.slice(e.end);
    if (needed.size) code = `import { ${[...needed].join(', ')} } from ${JSON.stringify(ref(dest, file))};\n` + code;
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== code) fs.writeFileSync(dest, code);
    barrel.push(`export { ${name} } from ${JSON.stringify(ref(file, dest))};`);
  }
  // Local export lists may refer to imported values. Keep just those import bindings in the barrel, including aliases,
  // default and namespace imports; the bundler can then follow the same value re-exports as in the original module.
  const reExported = new Set(sf.statements.filter(s => ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause))
    .flatMap(s => s.exportClause.elements.map(e => (e.propertyName ?? e.name).text)));
  for (const s of sf.statements) if (ts.isImportDeclaration(s) && s.importClause) {
    const clause = s.importClause;
    const name = clause.name && reExported.has(clause.name.text) ? clause.name : undefined;
    let bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      const selected = bindings.elements.filter(e => reExported.has(e.name.text));
      bindings = selected.length ? ts.factory.updateNamedImports(bindings, selected) : undefined;
    } else if (bindings && !reExported.has(bindings.name.text)) bindings = undefined;
    if (name || bindings) barrel.push(printer.printNode(ts.EmitHint.Unspecified,
      ts.factory.updateImportDeclaration(s, s.modifiers, ts.factory.updateImportClause(clause, clause.isTypeOnly, name, bindings), s.moduleSpecifier, s.attributes), sf));
  }
  // Preserve explicit re-exports (including aliases) and type exports. These contain no computations.
  for (const s of sf.statements) if (ts.isExportDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) barrel.push(printer.printNode(ts.EmitHint.Unspecified, s, sf));
  return barrel.join('\n') + '\n';
}
function generate(all, program, checker) {
  const dest = root + '/.i18n/client/package.json';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ sideEffects: false }));
  const barrels = {};
  for (const file of all.filter(splitFile)) barrels[barrelKey(file)] = generateFile(file, fs.readFileSync(file, 'utf8'), program, checker);
  fs.writeFileSync(root + '/.i18n/client-barrels.json', JSON.stringify(barrels));
}
module.exports = function loader(source) {
  if (!this.resourcePath.startsWith(root + '/src/')) return source;
  if (!splitFile(this.resourcePath)) return compile(source, this.resourcePath);
  const barrels = JSON.parse(fs.readFileSync(root + '/.i18n/client-barrels.json', 'utf8'));
  const key = barrelKey(this.resourcePath);
  if (!Object.hasOwn(barrels, key)) throw new Error('Missing client module: ' + this.resourcePath);
  return barrels[key];
};
module.exports.generate = generate;
