import type { MetadataRoute } from 'next';

/**
 * Served as `application/manifest+json` - the third of the three types that were
 * all `application/octet-stream`, and the one with the least common extension, so
 * the one most likely to be missed by a fix that only handles `.txt` and `.xml`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'cdk-nextjs App Playground',
    short_name: 'app-playground',
    description: 'Fixture app for cdk-nextjs end-to-end tests',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
  };
}
