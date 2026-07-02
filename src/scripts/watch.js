const esbuild = require('esbuild');

async function main() {
  const js = await esbuild.context({
    entryPoints: ['assets/js/main.js'],
    outfile: 'assets/js/main.min.js',
    minify: true,
  });
  const css = await esbuild.context({
    entryPoints: ['assets/css/styles.css'],
    outfile: 'assets/css/styles.min.css',
    minify: true,
  });

  await Promise.all([js.watch(), css.watch()]);
  console.log('Watching assets/js/main.js and assets/css/styles.css for changes...');
}

main();
