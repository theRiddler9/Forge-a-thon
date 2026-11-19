const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const extensionConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  };

  const webviewConfig = {
    entryPoints: ['webview/main.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'dist/webview.js',
    logLevel: 'info',
  };

  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webviewCtx = await esbuild.context(webviewConfig);
    await Promise.all([extCtx.watch(), webviewCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
