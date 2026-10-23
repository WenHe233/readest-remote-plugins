import { compatibilityProvider } from '../../../packages/compatibility/src/sdk';
import { inspectLegado, LegadoEngine } from './engine';
export const legadoProvider = compatibilityProvider(
  'legado',
  (content, host) => new LegadoEngine(inspectLegado(content)[0], host),
  inspectLegado,
);
