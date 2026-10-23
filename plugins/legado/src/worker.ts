import { definePlugin, pluginManifestSchema } from '@readest/plugin-sdk';
import manifest from '../manifest.json';
import { legadoProvider } from './plugin';
definePlugin({
  manifest: pluginManifestSchema.parse(manifest),
  contentProviders: [legadoProvider],
}).start();
