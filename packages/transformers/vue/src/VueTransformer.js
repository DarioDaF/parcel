// @flow

import {Transformer} from '@parcel/plugin';
import {md5FromObject} from '@parcel/utils';
import {
  parse,
  compileTemplate,
  compileStyle,
} from '@vue/component-compiler-utils';
import SourceMap from '@parcel/source-map';
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

  async transform({asset, options, logger}) {
    const id = md5FromObject({
      file: asset.filePath,
      id: asset.id,
      key: asset.uniqueKey,
    }).slice(-6);
    const scopeId = `data-v-scope-${id}`; // If not scoped flag sould check! no need for null...

    const code = await asset.getCode();

    if (!vueTemplateCompiler) {
      logger.error({message: 'Invalid compiler!!!'});
      throw new Error('Invalid vue-template-compiler!!!');
    }

    const parseOpts = {
      filename: asset.filePath,
      compiler: vueTemplateCompiler,
    };

    const sfcDesc = parse({
      source: code,
      compiler: vueTemplateCompiler,
      ...parseOpts,
      sourceRoot: '',
      needMap: options.sourceMaps,
      copmilerOptions: {
        scopeId,
      },
    });
    failOnError(sfcDesc);

    console.warn(
      sfcDesc.customBlocks.map(
        customBlock => `Unknown block found: "${customBlock.type}"`,
      ),
    );

    let blocks = [];

    // TODO: production???

    if (sfcDesc.script !== null) {
      logger.log({message: 'Found script'});
      // TODO: ? script.content is the js
      // Maybe same block as template???
      blocks.push({
        type: sfcDesc.script.lang || 'js',
        code: sfcDesc.script.content,
        map: sfcDesc.script.map,
      });
    }
    if (sfcDesc.template !== null) {
      // TODO: functional???
      logger.log({message: 'Found template'});

      const isFunctional = sfcDesc.template.attrs.functional || false;
      const template = compileTemplate({
        source: sfcDesc.template.content,
        lang: sfcDesc.template.lang || 'html',
        isFunctional: isFunctional,
        ...parseOpts,
      });
      failOnError(template);

      blocks.push({
        type: 'js',
        code: `
var $${id} = exports.default || module.exports;
if(typeof $${id} === 'function') {
  $${id} = $${id}.options;
}

/* template */
Object.assign($${id}, (function () {
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
      logger.log({message: 'Found style'});

      if (style.scoped) {
        // Should "compile" also non scoped?
        logger.log({message: 'Scoped style'});

        const compiledStyle = compileStyle({
          source: style.content,
          preprocessLang: style.lang || 'css', // Only css? use other preprocs?
          // Compile stylesheet in post to allow any preproc (should use AST and generate...)
          scoped: style.scoped || false, // Alwais true in this case...
          id: scopeId,
          ...parseOpts,
        });
        failOnError(compiledStyle);

        blocks.push({
          type: 'css', // Already processed by vue
          code: compiledStyle.code,
        });
      } else {
        blocks.push({
          type: style.lang || 'css',
          code: style.content,
        });
      }
    }
    // TODO: HMR???

    logger.log({message: 'Result: ' + JSON.stringify(blocks)});

    return blocks;
  },

  async postProcess({assets, logger}) {
    // Merge js assets in same module
    const results = [];
    let js = '';
    let map = new SourceMap();
    let deps = [];
    for (const asset of assets) {
      if (asset.type !== 'js') {
        results.push(asset);
      } else {
        const baseColumn = js.length;
        js += await asset.getCode();
        map.addMap(await asset.getMap(), 0, baseColumn);
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
            meta: dep.meta,
            target: dep.target,
            symbols: dep.symbols,
          });
        }
      }
    }
    logger.warn({message: JSON.stringify(deps)});
    return [
      {
        type: 'js',
        code: js,
        map: map,
        dependencies: deps,
      },
      ...results,
    ];
  },
});
