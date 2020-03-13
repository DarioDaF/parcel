// @flow

import {Transformer} from '@parcel/plugin';
import {md5FromObject} from '@parcel/utils';
import {
  parse,
  compileTemplate,
  compileStyle,
} from '@vue/component-compiler-utils';
import SourceMap from '@parcel/source-map';
import generateBundleReport from '@parcel/utils/lib/generateBundleReport';
//import vueTemplateCompiler from "vue-template-compiler";
const vueTemplateCompiler = require('vue-template-compiler');
// Should be devDep and dynamically loaded? how?

function failOnError(obj, logger) {
  if (obj.errors.length !== 0) {
    logger.error(
      obj.errors.map(e => {
        return {message: e};
      }),
    );
    throw new Error(obj.errors[0]);
  }
}

export default new Transformer({
  // Deprecated?
  async getConfig({asset}) {
    let config = await asset.getConfig([], {
      packageKey: 'vue-sfc',
    });

    if (config === null) {
      config = {};
    }

    config.filename = asset.filePath; // Needed?
    return config;
  },

  async parse({asset, options, logger}) {
    const vueId = md5FromObject({
      file: asset.filePath,
      id: asset.id,
      key: asset.uniqueKey,
    }).slice(-6);
    const scopeId = `data-v-scope-${vueId}`; // If not scoped flag sould check! no need for null...

    const code = await asset.getCode();

    if (!vueTemplateCompiler) {
      logger.error({message: 'Invalid compiler!!!'});
      throw new Error('Invalid vue-template-compiler!!!');
    }

    const sfcDesc = parse({
      source: code,
      compiler: vueTemplateCompiler,
      filename: asset.filePath,
      compiler: vueTemplateCompiler,
      sourceRoot: '',
      needMap: options.sourceMaps,
      copmilerOptions: {
        scopeId,
      },
    });
    failOnError(sfcDesc, logger);

    return {
      vueId,
      scopeId,
      sfcDesc,
    };
  },

  async generate({asset}) {
    return {code: await asset.getCode(), map: await asset.getMap()};
  },

  async transform({asset, logger}) {
    const {vueId, scopeId, sfcDesc} = asset.ast;

    asset.ast.scopedStyle = [];

    let parts = [];

    // TODO: production???

    if (sfcDesc.script !== null) {
      parts.push({
        type: sfcDesc.script.lang || 'js',
        code: sfcDesc.script.content,
        map: sfcDesc.script.map,
      });
    }
    if (sfcDesc.template !== null) {
      // TODO: functional???

      const isFunctional = sfcDesc.template.attrs.functional || false;
      const template = compileTemplate({
        source: sfcDesc.template.content,
        lang: sfcDesc.template.lang || 'html',
        isFunctional: isFunctional,
        filename: asset.filePath,
        compiler: vueTemplateCompiler,
      });
      failOnError(template, logger);

      parts.push({
        type: 'js',
        code: `
var $${vueId} = exports.default || module.exports;
if(typeof $${vueId} === 'function') {
  $${vueId} = $${vueId}.options;
}

/* template */
Object.assign($${vueId}, (function () {
  ${template.code}
  return {
    render: render,
    staticRenderFns: staticRenderFns,
    _compiled: true,
    _scopeId: ${JSON.stringify(scopeId)},
    functional: ${JSON.stringify(isFunctional)}
  };
})());
`,
      });
    }
    for (const style of sfcDesc.styles) {
      // TODO: CSS modules???
      asset.ast.scopedStyle.push(style.scoped || false);
      parts.push({
        type: style.lang || 'css',
        code: style.content,
        map: style.map,
        ast: {
          scoped: style.scoped || false,
        },
      });
    }
    // TODO: HMR???

    return parts;
  },

  async postProcess({assets, logger}) {
    const results = [];

    // Merge js assets in same module (template and code)
    let js = '';
    const map = new SourceMap();
    let deps = [];

    // Style counter
    let styleIdx = 0;

    for (const asset of assets) {
      logger.warn({message: JSON.stringify(asset.ast)});
      switch (asset.type) {
        case 'js':
          const baseColumn = js.length;
          js += await asset.getCode();
          const cmap = await asset.getMap();
          if (cmap) {
            map.addMap(cmap, 0, baseColumn);
          }
          for (const dep of asset.getDependencies()) {
            deps.push({
              // Dependency is not populated unless copied?
              moduleSpecifier: dep.moduleSpecifier,
              isAsync: dep.isAsync,
              isEntry: dep.isEntry,
              isOptional: dep.isOptional,
              isURL: dep.isURL,
              isWeak: dep.isWeak,
              loc: dep.loc,
              env: dep.env,
              //meta: dep.meta, // Should drop meta???
              target: dep.target,
              symbols: dep.symbols,
            });
          }
          break;
        case 'css':
          if (asset.ast.scopedStyle[styleIdx++]) {
            const compiledStyle = compileStyle({
              source: await asset.getCode(),
              scoped: true,
              id: asset.ast.scopeId,
              filename: asset.filePath,
              compiler: vueTemplateCompiler,
            });
            failOnError(compiledStyle, logger);

            blocks.push({
              type: 'css',
              code: compiledStyle.code,
              map: compiledStyle.map,
            });
            break;
          }
        // Volountary fall-trough
        default:
          results.push({
            // Like dependency? need copy?
            type: asset.type,
            code: await asset.getCode(),
            map: await asset.getMap(),
          });
      }
    }

    results.push({
      type: 'js',
      code: js,
      map: map,
      dependencies: deps,
    });

    return results;
  },
});
