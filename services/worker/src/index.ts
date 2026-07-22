import { parseRuntimeEnvironment } from '@zuocheng/config';
import { assertWorkerPolicy } from './policy.js';

const configuration = parseRuntimeEnvironment(process.env);
assertWorkerPolicy(configuration);

process.stdout.write(
  `${JSON.stringify({
    event: 'worker_started',
    deploymentMode: configuration.DEPLOYMENT_MODE,
    ownerBilling: 'deny',
    queue: 'postgres-outbox',
  })}\n`,
);

setInterval(() => {
  process.stdout.write(
    `${JSON.stringify({ event: 'worker_heartbeat', ownerBilling: 'deny' })}\n`,
  );
}, 30_000);
