const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

// Nx's @nx/webpack pins swc-loader options with NO jsc.target and loose:true,
// which downcompiles classes to ES5 (`function extends` via _inherits helper).
// That breaks `class PrismaService extends PrismaClient` because PrismaClient
// is a native ES6 class and can't be called without `new`. Patch the rule after
// Nx sets it up.
const OverrideSwcTarget = {
  apply(compiler) {
    compiler.hooks.afterEnvironment.tap('OverrideSwcTarget', () => {
      const rules = compiler.options.module && compiler.options.module.rules;
      if (!rules) return;
      for (const rule of rules) {
        const loader = rule && rule.loader;
        if (typeof loader === 'string' && loader.includes('swc-loader')) {
          rule.options = rule.options || {};
          rule.options.jsc = rule.options.jsc || {};
          rule.options.jsc.target = 'es2022';
          rule.options.jsc.loose = false;
          rule.options.jsc.keepClassNames = true;
        }
      }
    });
  },
};

module.exports = {
  output: {
    path: join(__dirname, 'dist'),
    clean: true,
    ...(process.env.NODE_ENV !== 'production' && {
      devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    }),
  },
  externals: [
    function ({ request }, callback) {
      if (
        /^@prisma\/client($|\/)/.test(request) ||
        /(^|\/)node_modules\/\.prisma\//.test(request) ||
        /(^|\/)\.prisma\//.test(request)
      ) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'swc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
    OverrideSwcTarget,
  ],
};
