// @flow

import type {Bundle, Asset, Symbol, BundleGraph} from '@parcel/types';
import type {CallExpression, Identifier, Statement} from '@babel/types';

import {parse as babelParse} from '@babel/parser';
import path from 'path';
import * as t from '@babel/types';
import {
  isArrayPattern,
  isExpressionStatement,
  isIdentifier,
  isObjectPattern,
  isProgram,
  isStringLiteral,
  isForInStatement,
  isForOfStatement,
  isForStatement,
} from '@babel/types';
import traverse from '@babel/traverse';
import {simple as walkSimple} from '@parcel/babylon-walk';
import {PromiseQueue} from '@parcel/utils';
import invariant from 'assert';
import fs from 'fs';
import nullthrows from 'nullthrows';
import {getName, getIdentifier, needsPrelude} from './utils';

const HELPERS_PATH = path.join(__dirname, 'helpers.js');
const HELPERS = fs.readFileSync(path.join(__dirname, 'helpers.js'), 'utf8');

const PRELUDE_PATH = path.join(__dirname, 'prelude.js');
const PRELUDE = fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8');

type AssetASTMap = Map<string, Array<Statement>>;
type TraversalContext = {|
  parent: ?AssetASTMap,
  children: AssetASTMap,
|};

// eslint-disable-next-line no-unused-vars
export async function concat(bundle: Bundle, bundleGraph: BundleGraph) {
  let queue = new PromiseQueue({maxConcurrent: 32});
  bundle.traverse((node, shouldWrap) => {
    switch (node.type) {
      case 'dependency':
        // Mark assets that should be wrapped, based on metadata in the incoming dependency tree
        if (shouldWrap || node.value.meta.shouldWrap) {
          let resolved = bundleGraph.getDependencyResolution(node.value);
          if (resolved) {
            resolved.meta.shouldWrap = true;
          }
          return true;
        }
        break;
      case 'asset':
        queue.add(() => processAsset(bundle, node.value));
    }
  });

  let outputs = new Map<string, Array<Statement>>(await queue.run());
  let result = [...parse(HELPERS, HELPERS_PATH)];
  if (needsPrelude(bundle, bundleGraph)) {
    result.unshift(...parse(PRELUDE, PRELUDE_PATH));
  }

  let usedExports = getUsedExports(bundle, bundleGraph);

  bundle.traverseAssets<TraversalContext>({
    enter(asset, context) {
      if (shouldExcludeAsset(asset, usedExports)) {
        return context;
      }

      return {
        parent: context && context.children,
        children: new Map(),
      };
    },
    exit(asset, context) {
      if (!context || shouldExcludeAsset(asset, usedExports)) {
        return;
      }

      let statements = nullthrows(outputs.get(asset.id));
      let statementIndices: Map<string, number> = new Map();
      for (let i = 0; i < statements.length; i++) {
        let statement = statements[i];
        if (isExpressionStatement(statement)) {
          for (let depAsset of findRequires(bundleGraph, asset, statement)) {
            if (!statementIndices.has(depAsset.id)) {
              statementIndices.set(depAsset.id, i);
            }
          }
        }
      }

      for (let [assetId, ast] of [...context.children].reverse()) {
        let index = statementIndices.has(assetId)
          ? nullthrows(statementIndices.get(assetId))
          : 0;
        statements.splice(index, 0, ...ast);
      }

      // If this module is referenced by another JS bundle, or is an entry module in a child bundle,
      // add code to register the module with the module system.

      if (context.parent) {
        context.parent.set(asset.id, statements);
      } else {
        result.push(...statements);
      }
    },
  });

  return t.file(t.program(result));
}

async function processAsset(bundle: Bundle, asset: Asset) {
  let code = await asset.getCode();
  let statements: Array<Statement> = parse(code, asset.filePath);

  if (statements[0]) {
    t.addComment(statements[0], 'leading', ` ASSET: ${asset.filePath}`, true);
  }

  if (asset.meta.shouldWrap) {
    statements = wrapModule(asset, statements);
  }

  return [asset.id, statements];
}

function parse(code, filename) {
  let ast = babelParse(code, {
    sourceFilename: filename,
    allowReturnOutsideFunction: true,
    plugins: ['dynamicImport'],
  });

  return ast.program.body;
}

function getUsedExports(
  bundle: Bundle,
  bundleGraph: BundleGraph,
): Map<string, Set<Symbol>> {
  let usedExports: Map<string, Set<Symbol>> = new Map();

  let entry = bundle.getMainEntry();
  if (entry) {
    for (let {asset, symbol} of bundleGraph.getExportedSymbols(entry)) {
      if (symbol) {
        markUsed(asset, symbol);
      }
    }
  }

  bundle.traverseAssets(asset => {
    for (let dep of bundleGraph.getDependencies(asset)) {
      let resolvedAsset = bundleGraph.getDependencyResolution(dep);
      if (!resolvedAsset) {
        continue;
      }

      for (let [symbol, identifier] of dep.symbols) {
        if (identifier === '*') {
          continue;
        }

        if (symbol === '*') {
          for (let {asset, symbol} of bundleGraph.getExportedSymbols(
            resolvedAsset,
          )) {
            if (symbol) {
              markUsed(asset, symbol);
            }
          }
        }

        markUsed(resolvedAsset, symbol);
      }
    }

    // If the asset is referenced by another bundle, include all exports.
    if (bundleGraph.isAssetReferencedByAssetType(asset, 'js')) {
      markUsed(asset, '*');
      for (let {asset: a, symbol} of bundleGraph.getExportedSymbols(asset)) {
        if (symbol) {
          markUsed(a, symbol);
        }
      }
    }
  });

  function markUsed(asset, symbol) {
    let resolved = bundleGraph.resolveSymbol(asset, symbol);

    let used = usedExports.get(resolved.asset.id);
    if (!used) {
      used = new Set();
      usedExports.set(resolved.asset.id, used);
    }

    used.add(resolved.exportSymbol);
  }

  return usedExports;
}

function shouldExcludeAsset(
  asset: Asset,
  usedExports: Map<string, Set<Symbol>>,
) {
  return (
    asset.sideEffects === false &&
    !asset.meta.isCommonJS &&
    (!usedExports.has(asset.id) ||
      nullthrows(usedExports.get(asset.id)).size === 0)
  );
}

const FIND_REQUIRES_VISITOR = {
  CallExpression(
    node: CallExpression,
    {
      bundleGraph,
      asset,
      result,
    }: {|bundleGraph: BundleGraph, asset: Asset, result: Array<Asset>|},
  ) {
    let {arguments: args, callee} = node;
    if (!isIdentifier(callee)) {
      return;
    }

    if (callee.name === '$parcel$require') {
      let [, src] = args;
      invariant(isStringLiteral(src));
      let dep = bundleGraph
        .getDependencies(asset)
        .find(dep => dep.moduleSpecifier === src.value);
      if (!dep) {
        throw new Error(`Could not find dep for "${src.value}`);
      }
      // can be undefined if AssetGraph#resolveDependency optimized
      // ("deferred") this dependency away as an unused reexport
      let resolution = bundleGraph.getDependencyResolution(dep);
      if (resolution) {
        result.push(resolution);
      }
    }
  },
};

function findRequires(
  bundleGraph: BundleGraph,
  asset: Asset,
  ast: mixed,
): Array<Asset> {
  let result = [];
  walkSimple(ast, FIND_REQUIRES_VISITOR, {asset, bundleGraph, result});

  return result;
}

// Toplevel var/let/const declarations, function declarations and all `var` declarations
// in a non-function scope need to be hoisted.
const WRAP_MODULE_VISITOR = {
  noScope: true,
  VariableDeclaration(path, {decls}) {
    let {node, parent} = path;
    let replace = [];
    if (node.kind === 'var' || isProgram(path.parent)) {
      for (let decl of node.declarations) {
        let {id, init} = decl;
        if (isObjectPattern(id) || isArrayPattern(id)) {
          // $FlowFixMe it is an identifier
          for (let prop: Identifier of Object.values(
            t.getBindingIdentifiers(id),
          )) {
            decls.push(t.variableDeclarator(prop));
          }
        } else {
          decls.push(t.variableDeclarator(id));
          invariant(t.isIdentifier(id));
        }
        if (
          isForInStatement(parent, {left: node}) ||
          isForOfStatement(parent, {left: node})
        ) {
          invariant(!init);
          replace.push(id);
        } else if (init) {
          if (isForStatement(parent, {init: node})) {
            replace.push(t.assignmentExpression('=', id, init));
          } else {
            replace.push(
              t.expressionStatement(t.assignmentExpression('=', id, init)),
            );
          }
        }
      }
    }

    if (replace.length > 1) {
      path.replaceWithMultiple(replace).forEach(p => p.skip());
    } else if (replace.length == 1) {
      path.replaceWith(replace[0]);
      path.skip();
    } else {
      path.remove();
    }
  },
  FunctionDeclaration(path, {fns}) {
    fns.push(path.node);
    path.remove();
  },
  FunctionExpression(path) {
    path.skip();
  },
  ClassDeclaration(path, {decls}) {
    let {node} = path;
    let {id} = node;
    invariant(isIdentifier(id));

    // Class declarations are not hoisted. We declare a variable outside the
    // function and convert to a class expression assignment.
    decls.push(t.variableDeclarator(id));
    path.replaceWith(
      t.expressionStatement(
        t.assignmentExpression('=', id, t.toExpression(node)),
      ),
    );
    path.skip();
  },
};

function wrapModule(asset: Asset, statements) {
  let decls = [];
  let fns = [];
  let program = t.program(statements);
  traverse(t.file(program), WRAP_MODULE_VISITOR, null, {decls, fns});

  let executed = getName(asset, 'executed');
  decls.push(
    t.variableDeclarator(t.identifier(executed), t.booleanLiteral(false)),
  );

  let init = t.functionDeclaration(
    getIdentifier(asset, 'init'),
    [],
    t.blockStatement([
      t.ifStatement(t.identifier(executed), t.returnStatement()),
      t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.identifier(executed),
          t.booleanLiteral(true),
        ),
      ),
      ...program.body,
    ]),
  );

  return ([
    t.variableDeclaration('var', decls),
    ...fns,
    init,
  ]: Array<Statement>);
}
