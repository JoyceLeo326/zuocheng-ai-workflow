import { serve } from '@hono/node-server';
import { parseRuntimeEnvironment } from '@zuocheng/config';
import { createApp } from './app.js';

const configuration = parseRuntimeEnvironment(process.env);
const app = createApp(configuration.DEPLOYMENT_MODE);

serve({
  fetch: app.fetch,
  hostname: '0.0.0.0',
  port: configuration.PORT,
});

process.stdout.write(
  `${JSON.stringify({
    event: 'api_started',
    port: configuration.PORT,
    deploymentMode: configuration.DEPLOYMENT_MODE,
    ownerBilling: 'deny',
  })}\n`,
);

