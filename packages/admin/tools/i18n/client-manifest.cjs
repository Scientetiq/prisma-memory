// Follow value declarations from server entries to client boundaries. Only catalog nodes reachable in the browser
// contribute text. Property symbols preserve key-level selection through the typed localized proxies.
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const { catalogFile, isText, textId } = require('./client-catalog.cjs');
const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'src');
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
function generate() {
  const all = files(src).filter(p => /\.tsx?$/.test(p));
  const program = ts.createProgram(all, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve, baseUrl: root, paths: { '@/*': ['./src/*'] }, skipLibCheck: true, noEmit: true });
  const checker = program.getTypeChecker();
  require('./client-split.cjs').generate(all, program, checker);
  const source = new Map(program.getSourceFiles().filter(f => f.fileName.startsWith(src + '/')).map(f => [f.fileName, f]));
  const mode = sf => sf.statements.some(s => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use client');
  const serverOnly = sf => sf.statements.some(s => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server');
  function symbol(node) { let s = checker.getSymbolAtLocation(node); if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s); return s; }
  function exported(sf) {
    const s = checker.getSymbolAtLocation(sf);
    return s ? checker.getExportsOfModule(s) : [];
  }
  // Catalog node addresses match across locales even when the Russian function has different plural logic.
  const addresses = new Map(), counterparts = new Map();
  for (const sf of source.values()) if (catalogFile(sf.fileName)) {
    function index(n, address) {
      if ((ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isFunctionDeclaration(n) || ts.isGetAccessorDeclaration(n)) && n.name) {
        address += '/' + n.name.getText(sf);
        addresses.set(n, address);
        counterparts.set(sf.fileName + ':' + address, n);
      }
      ts.forEachChild(n, child => index(child, address));
    }
    index(sf, '');
  }
  function collect(roots, initialClient = false, section = null) {
    const visited = [new WeakSet(), new WeakSet()], data = { en: {}, ru: {} }, boundaries = new Set();
    function addDeclaration(decl, client) {
      const sf = decl.getSourceFile();
      if (!source.has(sf.fileName) || ts.isTypeNode(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl) || serverOnly(sf)) return;
      if (mode(sf)) { boundaries.add(sf.fileName); client = true; }
      if (catalogFile(sf.fileName)) {
        if (!client) return;
        const address = addresses.get(decl);
        if (address) {
          const otherFile = sf.fileName.replace(/\/(en|ru)\.ts$/, (_m, locale) => '/' + Object.keys(data).find(other => other !== locale) + '.ts');
          const other = counterparts.get(otherFile + ':' + address);
          if (other) walk(other, true);
        }
      }
      walk(decl, client);
    }
    function reference(node, client) {
      const s = symbol(node);
      for (const d of s?.declarations ?? []) addDeclaration(d, client);
    }
    function walk(n, client) {
      // Distinct AST nodes can share a span (for example a JSX attribute and its attribute list).
      const seen = visited[client ? 1 : 0];
      if (seen.has(n)) return;
      seen.add(n);
      if (ts.isTypeNode(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
      const sf = n.getSourceFile();
      if (client && section && sf.fileName.endsWith('/components/section-settings-form.tsx')) {
        const unbox = n => { while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) n = n.expression; return n; };
        const evaluate = n => {
          n = unbox(n);
          if (ts.isIdentifier(n) && n.text === 'section') return section;
          if (ts.isStringLiteral(n)) return n.text;
          if (ts.isBinaryExpression(n)) {
            const a = evaluate(n.left), b = evaluate(n.right);
            if (a !== undefined && b !== undefined) {
              if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(n.operatorToken.kind)) return a === b;
              if ([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) return a !== b;
            }
          }
        };
        if (ts.isConditionalExpression(n)) {
          const condition = evaluate(n.condition);
          if (typeof condition === 'boolean') { walk(condition ? n.whenTrue : n.whenFalse, client); return; }
        }
        if (ts.isIfStatement(n)) {
          const condition = evaluate(n.expression);
          if (typeof condition === 'boolean') { const body = condition ? n.thenStatement : n.elseStatement; if (body) walk(body, client); return; }
        }
        if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'SECTIONS') {
          const object = unbox(n.initializer.arguments[0].body);
          const selected = object.properties.find(p => p.name.getText(sf) === section);
          if (!selected) throw new Error('Unknown settings section: ' + section);
          walk(selected.initializer, client); return;
        }
      }
      if (client && catalogFile(sf.fileName) && isText(n)) data[path.basename(sf.fileName, '.ts')][textId(sf.fileName, n)] = n.text;
      if (ts.isPropertyAccessExpression(n)) {
        const declarations = symbol(n.name)?.declarations ?? [];
        const catalog = declarations.filter(d => catalogFile(d.getSourceFile().fileName));
        if (catalog.length) {
          for (const d of catalog) addDeclaration(d, client);
          return;
        }
        reference(n.name, client);
        walk(n.expression, client);
        return;
      }
      if (ts.isIdentifier(n) && !((ts.isVariableDeclaration(n.parent) || ts.isFunctionDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isPropertyAssignment(n.parent)) && n.parent.name === n)) reference(n, client);
      ts.forEachChild(n, child => walk(child, client));
    }
    for (const r of roots) addDeclaration(r, initialClient);
    return { ...data, boundaries: [...boundaries].map(f => path.relative(root, f)).sort() };
  }
  function rootsFor(sf, allExports = false) {
    if (mode(sf)) return [sf];
    return exported(sf).filter(s => allExports || s.name === 'default').flatMap(s => s.declarations ?? []);
  }
  const entries = {};
  for (const file of all.filter(f => /\/app\/.*\/page\.tsx$/.test(f) || f === src + '/app/page.tsx')) {
    const entry = path.relative(src + '/app', file).replace(/\/page\.tsx$/, '').replace(/^page\.tsx$/, '');
    const roots = rootsFor(source.get(file));
    let dir = path.dirname(file);
    while (dir.startsWith(src + '/app')) {
      for (const name of ['layout.tsx', 'error.tsx', 'not-found.tsx']) {
        const sf = source.get(path.join(dir, name)); if (sf) roots.push(...rootsFor(sf));
      }
      if (dir === src + '/app') break;
      dir = path.dirname(dir);
    }
    // A literal section prop selects the shared editor's branch; no cross-route catalog is needed for that editor.
    const sections = new Set();
    function sectionProps(n) {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n))
        && symbol(n.tagName)?.declarations?.some(d => d.getSourceFile().fileName.endsWith('/components/section-settings-form.tsx') && d.name?.getText() === 'SectionSettingsForm')) {
        const attribute = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.text === 'section');
        if (attribute?.initializer && ts.isStringLiteral(attribute.initializer)) sections.add(attribute.initializer.text);
      }
      ts.forEachChild(n, sectionProps);
    }
    sectionProps(source.get(file));
    entries[entry] = collect(roots, false, sections.size === 1 ? [...sections][0] : null);
  }
  // Root not-found can also render without a matched page.
  entries['_not-found'] = collect([...(source.get(src + '/app/not-found.tsx') ? rootsFor(source.get(src + '/app/not-found.tsx')) : []), ...rootsFor(source.get(src + '/app/layout.tsx'))]);
  const out = { entries };
  const dest = root + '/.i18n/client-messages.json';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const serialized = JSON.stringify(out);
  if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== serialized) fs.writeFileSync(dest, serialized);
  return out;
}
module.exports = { generate };
if (require.main === module) { const out = generate(); console.log(`Client message entries: ${Object.keys(out.entries).length}`); }
