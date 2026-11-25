// Wrap server pages and the root layout without changing their exports, props or rendering order.
const ts = require('typescript');
const path = require('node:path');
module.exports = function loader(source) {
  const file = this.resourcePath;
  if (!file.startsWith(path.resolve(__dirname, '../../src/app') + '/')) return source;
  if (!/\/src\/app\/(?:.*\/)?(?:page|layout)\.tsx$/.test(file)) return source;
  if (file.endsWith('/layout.tsx') && !file.endsWith('/src/app/layout.tsx')) return source;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let name;
  const result = ts.transform(sf, [context => node => ts.visitEachChild(node, function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      name = n.name?.text ?? '__OriginalPage';
      return ts.factory.updateFunctionDeclaration(n, n.modifiers.filter(m => ![ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.ExportKeyword].includes(m.kind)), n.asteriskToken, ts.factory.createIdentifier(name), n.typeParameters, n.parameters, n.type, n.body);
    }
    return n;
  }, context)]);
  if (!name) throw new Error(`Missing default server function: ${file}`);
  const helper = path.relative(path.dirname(file), path.resolve(__dirname, '../../src/i18n/client-messages.server')).replaceAll('\\', '/');
  const entry = file.endsWith('/src/app/layout.tsx') ? null : file.split('/src/app/')[1].replace(/\/page\.tsx$/, '').replace(/^page\.tsx$/, '');
  try {
    return ts.createPrinter().printFile(result.transformed[0]) + `\nimport { routeMessages as __routeMessages } from ${JSON.stringify(helper.startsWith('.') ? helper : './' + helper)};\nexport default function __WithMessages(props: Parameters<typeof ${name}>[0]) { return __routeMessages(${JSON.stringify(entry)}, ${name}, props); }\n`;
  } finally { result.dispose(); }
};
