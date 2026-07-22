import { serve } from '@hono/node-server';
import { parseRuntimeEnvironment } from '@zuocheng/config';
import { composeApiRuntime } from './production-composition.js';
import { installGracefulShutdown } from './server-lifecycle.js';

async function start(): Promise<void> {
  try {
    const configuration = parseRuntimeEnvironment(process.env);
    const runtime = await composeApiRuntime(configuration);
    let server: ReturnType<typeof serve>;
    try {
      server = serve({
        fetch: runtime.app.fetch,
        hostname: '0.0.0.0',
        port: configuration.PORT,
      });
    } catch {
      await runtime.close().catch(() => undefined);
      throw new Error('api-listener-start-failed');
    }
    installGracefulShutdown(server, runtime);

    process.stdout.write(
      `${JSON.stringify({
        event: 'api_started',
        port: configuration.PORT,
        deploymentMode: configuration.DEPLOYMENT_MODE,
        ownerBilling: 'deny',
        projectRoutes:
          configuration.DEPLOYMENT_MODE === 'tenant-managed-production'
            ? 'customer-managed'
            : 'not-configured',
      })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({
        event: 'api_start_failed',
        reason: 'runtime-composition-failed',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

await start();
