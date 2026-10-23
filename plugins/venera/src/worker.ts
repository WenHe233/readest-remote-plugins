import { definePlugin, pluginManifestSchema } from '@readest/plugin-sdk';
import manifest from '../manifest.json';
import { veneraProvider } from './plugin';
definePlugin({
  manifest: pluginManifestSchema.parse(manifest),
  contentProviders: [veneraProvider],
}).start();
