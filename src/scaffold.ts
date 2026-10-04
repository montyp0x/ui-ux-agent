import { suiteSchema, type Suite } from './contracts.js';

export function starterSuite(
  baseURL: string,
  destination: string,
  goal?: string,
): Suite {
  const escaped = destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return suiteSchema.parse({
    name: 'Website user journeys',
    baseURL,
    requiresAuth: false,
    viewports: [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'narrow', width: 390, height: 844 },
    ],
    journeys: [
      {
        id: 'discover-destination',
        goal:
          goal ??
          `Find and open ${destination} through the site's visible navigation`,
        persona:
          'A first-time visitor who knows their goal but does not know the site structure.',
        startPath: '/',
        allowedPaths: ['/', ...(destination === '/' ? [] : [destination])],
        ready: { kind: 'visible', target: { by: 'css', value: 'body' } },
        success: [{ kind: 'path', pattern: `^${escaped}/?$` }],
      },
    ],
  });
}
