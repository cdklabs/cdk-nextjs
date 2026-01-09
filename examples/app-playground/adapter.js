// @ts-check
// TODO: consider adapter in future so that Next*Functions can not run in container and
// doesn't require lambda-web-adapter (perf improvement)
// https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath#configuration

/** @type {import('next').NextAdapter} */
const adapter = {
  name: 'my-custom-adapter',

  async modifyConfig(config, { phase }) {
    // Modify the Next.js config based on the build phase
    if (phase === 'phase-production-build') {
      return {
        ...config,
        // Add your modifications
      };
    }
    return config;
  },

  async onBuildComplete({
    buildId,
    config,
    distDir,
    nextVersion,
    outputs,
    projectDir,
    repoRoot,
    routing,
  }) {
    console.log({
      buildId,
      config,
      distDir,
      nextVersion,
      projectDir,
      repoRoot,
      routing: JSON.stringify(routing, null, 2),
    });
    // Process the build output
    console.log('Build completed with', outputs.pages.length, 'pages');

    // Access different output types
    for (const page of outputs.pages) {
      console.log('Page:', page.pathname, 'at', page.filePath);
    }

    for (const apiRoute of outputs.pagesApi) {
      console.log('API Route:', apiRoute.pathname, 'at', apiRoute.filePath);
    }

    for (const appPage of outputs.appPages) {
      console.log('App Page:', appPage.pathname, 'at', appPage.filePath);
    }

    for (const prerender of outputs.prerenders) {
      console.log('Prerendered:', prerender.pathname);
    }
  },
};

export default adapter;
