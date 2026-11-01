// Pulls the raw <script> body out of GBA_EMULATOR_HTML so it can be run
// headlessly under Node with a minimal DOM shim — this is what lets the
// boot-trace test and the ROM-mapping unit tests exercise the ACTUAL core
// code that ships to the WebView, instead of a hand-copied re-implementation
// that could silently drift out of sync with it.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

function extractCoreScript() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'html.ts'), 'utf8');
  const htmlMatch = src.match(/GBA_EMULATOR_HTML = `([\s\S]*)`;\s*$/);
  if (!htmlMatch) throw new Error('Could not locate GBA_EMULATOR_HTML template literal');
  const template = htmlMatch[1];
  // The literal interpolates the shared build tag.
  // Validate expressions before evaluating the same cooked
  // template literal that TypeScript emits, and fail loudly on any other
  // interpolation.
  const allowed = new Set(['BUILD_TAG']);
  const interpolation = /\$\{([^}]*)\}/g;
  let match;
  while ((match = interpolation.exec(template))) {
    if (!allowed.has(match[1])) {
      throw new Error('Unexpected template interpolation in GBA_EMULATOR_HTML: ' + match[0]);
    }
  }
  const tagSrc = fs.readFileSync(path.join(__dirname, '..', 'buildTag.ts'), 'utf8');
  const tagModule = { exports: {} };
  const tagJs = ts.transpileModule(tagSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(tagJs, { exports: tagModule.exports }, { filename: 'buildTag.ts' });
  const tag = tagModule.exports.BUILD_TAG;
  if (typeof tag !== 'string' || !tag) throw new Error('Could not evaluate BUILD_TAG from buildTag.ts');
  const htmlContext = {
    BUILD_TAG: tag,
  };
  vm.runInNewContext(
    'this.__renderedHtml = `' + template + '`;',
    htmlContext,
    { filename: 'html.ts:GBA_EMULATOR_HTML' },
  );
  const html = htmlContext.__renderedHtml;
  const leftover = html.match(/\$\{[^}]*\}/);
  if (leftover) throw new Error('Unexpected template interpolation in core script: ' + leftover[0]);
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) throw new Error('Could not locate <script> body inside GBA_EMULATOR_HTML');
  const script = scriptMatch[1];
  return script;
}

module.exports = { extractCoreScript };
