// @flow

import semver from 'semver';
import generate from '@babel/generator';
import {Transformer} from '@parcel/plugin';
import collectDependencies from './visitors/dependencies';
import processVisitor from './visitors/process';
import fsVisitor from './visitors/fs';
import insertGlobals from './visitors/globals';
import {parse} from '@babel/parser';
import traverse from '@babel/traverse';
import * as walk from 'babylon-walk';
import * as babelCore from '@babel/core';
import {hoist} from '@parcel/scope-hoisting';
import {relativeUrl} from '@parcel/utils';
import SourceMap from '@parcel/source-map';

const IMPORT_RE = /\b(?:import\b|export\b|require\s*\()/;
const ENV_RE = /\b(?:process\.env)\b/;
const BROWSER_RE = /\b(?:process\.browser)\b/;
const GLOBAL_RE = /\b(?:process|__dirname|__filename|global|Buffer|define)\b/;
const FS_RE = /\breadFileSync\b/;
const SW_RE = /\bnavigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/;
const WORKER_RE = /\bnew\s*(?:Shared)?Worker\s*\(/;

// Sourcemap extraction
// const SOURCEMAP_RE = /\/\/\s*[@#]\s*sourceMappingURL\s*=\s*([^\s]+)/;
// const DATA_URL_RE = /^data:[^;]+(?:;charset=[^;]+)?;base64,(.*)/;

function canHaveDependencies(code) {
  return (
    IMPORT_RE.test(code) ||
    GLOBAL_RE.test(code) ||
    SW_RE.test(code) ||
    WORKER_RE.test(code)
  );
}

export default new Transformer({
  canReuseAST({ast}) {
    return ast.type === 'babel' && semver.satisfies(ast.version, '^7.0.0');
  },

  async parse({asset}) {
    let code = await asset.getCode();
    if (
      !asset.env.scopeHoist &&
      !canHaveDependencies(code) &&
      !ENV_RE.test(code) &&
      !BROWSER_RE.test(code) &&
      !FS_RE.test(code)
    ) {
      return null;
    }

    let sourceFilename: string = relativeUrl(
      options.projectRoot,
      asset.filePath,
    );

    return {
      type: 'babel',
      version: '7.0.0',
      program: parse(code, {
        filename: this.name,
        sourceFilename,
        allowReturnOutsideFunction: true,
        strictMode: false,
        sourceType: 'module',
        plugins: ['exportDefaultFrom', 'exportNamespaceFrom', 'dynamicImport'],
      }),
    };
  },

  async transform({asset, options, logger}) {
    // When this asset is an bundle entry, allow that bundle to be split to load shared assets separately.
    // Only set here if it is null to allow previous transformers to override this behavior.
    if (asset.isSplittable == null) {
      asset.isSplittable = true;
    }

    asset.type = 'js';
    let ast = await asset.getAST();
    if (!ast) {
      return [asset];
    }

    let code = await asset.getCode();

    // Inline process/ environment variables
    if (
      (!asset.env.isNode() && (!code || ENV_RE.test(code))) ||
      (asset.env.isBrowser() && (!code || BROWSER_RE.test(code)))
    ) {
      walk.ancestor(ast.program, processVisitor, {
        asset,
        ast,
        env: options.env,
        isNode: asset.env.isNode(),
        isBrowser: asset.env.isBrowser(),
      });
    }

    // Collect dependencies
    if (!code || canHaveDependencies(code)) {
      walk.ancestor(ast.program, collectDependencies, {asset, ast, options});
    }

    // If there's a hashbang, remove it and store it on the asset meta.
    // During packaging, if this is the entry asset, it will be prepended to the
    // packaged output.
    if (ast.program.program.interpreter != null) {
      asset.meta.interpreter = ast.program.program.interpreter.value;
      delete ast.program.program.interpreter;
    }

    if (!asset.env.isNode()) {
      // Inline fs calls
      let fsDep = asset
        .getDependencies()
        .find(dep => dep.moduleSpecifier === 'fs');
      if (fsDep && (!code || FS_RE.test(code))) {
        // Check if we should ignore fs calls
        // See https://github.com/defunctzombie/node-browser-resolve#skip
        let pkg = await asset.getPackage();
        let ignore =
          pkg &&
          pkg.browser &&
          typeof pkg.browser === 'object' &&
          pkg.browser.fs === false;

        if (!ignore) {
          traverse(ast.program, fsVisitor, null, {asset, logger, ast});
        }
      }

      // Insert node globals
      if (!code || GLOBAL_RE.test(code)) {
        asset.meta.globals = new Map();
        walk.ancestor(ast.program, insertGlobals, asset);
      }
    }

    if (asset.env.scopeHoist) {
      hoist(asset, ast);
    } else if (asset.meta.isES6Module) {
      // Convert ES6 modules to CommonJS
      let res = babelCore.transformFromAst(ast.program, code, {
        code: false,
        ast: true,
        filename: asset.filePath,
        babelrc: false,
        configFile: false,
        plugins: [require('@babel/plugin-transform-modules-commonjs')],
      });

      asset.setAST({
        type: 'babel',
        version: '7.0.0',
        program: res.ast,
      });
    }

    return [asset];
  },

  generate({asset, ast, options}) {
    let sourceFileName: string = relativeUrl(
      options.projectRoot,
      asset.filePath,
    );

    let generated = generate(
      ast.program,
      {
        sourceMaps: options.sourceMaps,
        sourceFileName: sourceFileName,
      },
      '',
    );

    let res = {
      code: generated.code,
      map: new SourceMap(generated.rawMappings, {
        [sourceFileName]: null,
      }),
    };

    res.code = generateGlobals(asset) + res.code;
    return res;
  },
});

function generateGlobals(asset) {
  let code = '';
  if (asset.meta.globals && asset.meta.globals.size > 0) {
    code =
      Array.from(asset.meta.globals.values())
        .map(g => (g ? g.code : ''))
        .join('\n') + '\n';
  }
  delete asset.meta.globals;
  return code;
}
