import { compatibilityProvider } from '../../../packages/compatibility/src/sdk';
import { defineContentProvider } from '@readest/plugin-sdk';
import { inspectVenera, inspectVeneraList, VeneraEngine } from './engine';
const provider = compatibilityProvider(
  'venera',
  (content, host) => new VeneraEngine(inspectVenera(content), host),
  (content) => [inspectVenera(content)],
);
export const veneraProvider = defineContentProvider({
  ...provider,
  inspect: async (input, host) => {
    if (input.format === 'venera-list' || input.content.trim().startsWith('['))
      return {
        definitions: [],
        references: inspectVeneraList(input.content, input.baseUrl).map(
          (reference) => ({ ...reference, format: 'venera' }),
        ),
      };
    return provider.inspect!(input, host);
  },
});
