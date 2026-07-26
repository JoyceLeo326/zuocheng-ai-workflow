import type { RuntimeEnvironment } from '@zuocheng/config';
import type { Pool } from 'pg';
import { BetterAuthSessionVerifier } from './auth/better-auth-session-verifier.js';
import type {
  IdentityHttpSecurityPort,
  IdentityLifecycleService,
  IdentityRateLimiter,
} from './auth/http/identity-lifecycle-service.js';
import { PostgresMembershipRepository } from './auth/postgres-membership-repository.js';
import {
  createBetterAuthRuntime,
  isCustomerManagedIdentityRuntimeConfig,
  type BetterAuthRuntime,
  type CustomerManagedIdentityRuntimeConfig,
} from './auth/runtime/better-auth-runtime.js';
import { TenantSessionResolver } from './auth/tenant-session.js';
import {
  createApp,
  type ProductionDependencyStatus,
} from './app.js';
import { createUuidV7 } from './http/request-id.js';
import {
  nodePostgresTenantPools,
  PostgresProjectStore,
} from './projects/postgres-project-store.js';
import { ProjectService } from './projects/project-service.js';

export type CustomerManagedRuntimeAdapter = Readonly<{
  kind: 'customer-managed-production';
  identity: CustomerManagedIdentityRuntimeConfig;
  identityLifecycleService: IdentityLifecycleService;
  identityHttpSecurity: IdentityHttpSecurityPort;
  identityRateLimiter: IdentityRateLimiter;
  principalPoolForContext: (tenantId: string, userId: string) => Pool;
  checkReadiness: () => Promise<ProductionDependencyStatus>;
  close: () => Promise<void>;
}>;

type CustomerManagedRuntimeAdapterModule = Readonly<{
  createCustomerManagedRuntimeAdapter: () =>
    | CustomerManagedRuntimeAdapter
    | Promise<CustomerManagedRuntimeAdapter>;
}>;

export type ApiRuntime = Readonly<{
  app: ReturnType<typeof createApp>;
  close: () => Promise<void>;
}>;

type ComposeApiRuntimeOptions = Readonly<{
  clock?: () => Date;
  createRequestId?: () => string;
  importer?: (specifier: string) => Promise<unknown>;
  identityRuntimeFactory?: (
    config: CustomerManagedIdentityRuntimeConfig,
  ) => BetterAuthRuntime;
}>;

type ProductionCompositionErrorCode =
  | 'CUSTOMER_RUNTIME_ADAPTER_REQUIRED'
  | 'INVALID_CUSTOMER_RUNTIME_ADAPTER';

export class ProductionCompositionError extends Error {
  constructor(readonly code: ProductionCompositionErrorCode) {
    super(
      code === 'CUSTOMER_RUNTIME_ADAPTER_REQUIRED'
        ? 'Tenant-managed production requires a customer runtime adapter module'
        : 'The customer runtime adapter module does not satisfy the production contract',
    );
    this.name = 'ProductionCompositionError';
  }
}

export async function composeApiRuntime(
  configuration: RuntimeEnvironment,
  options: ComposeApiRuntimeOptions = {},
): Promise<ApiRuntime> {
  const clock = options.clock ?? (() => new Date());
  const createRequestId =
    options.createRequestId ?? (() => createUuidV7(clock));

  if (configuration.DEPLOYMENT_MODE !== 'tenant-managed-production') {
    return {
      app: createApp(configuration.DEPLOYMENT_MODE, {
        clock,
        createRequestId,
      }),
      close: async () => undefined,
    };
  }

  const moduleSpecifier = configuration.TENANT_RUNTIME_ADAPTER_MODULE;
  if (moduleSpecifier === undefined) {
    throw new ProductionCompositionError('CUSTOMER_RUNTIME_ADAPTER_REQUIRED');
  }

  const imported = await safelyImport(
    options.importer ?? ((specifier) => import(specifier) as Promise<unknown>),
    moduleSpecifier,
  );
  const adapterModule = parseAdapterModule(imported);
  const adapter = await createAdapter(adapterModule);
  const identityRuntime = await safelyCreateIdentityRuntime(
    adapter,
    options.identityRuntimeFactory ?? createBetterAuthRuntime,
  );
  const pools = nodePostgresTenantPools((tenantId, userId) =>
    adapter.principalPoolForContext(tenantId, userId),
  );
  const resolver = new TenantSessionResolver(
    new BetterAuthSessionVerifier(identityRuntime.api, clock),
    new PostgresMembershipRepository(pools),
  );
  // ProjectService owns its own clock/UUID hooks; pass the production UUIDv7
  // generator explicitly so no resource creation can fall back to a mock ID.
  const service = new ProjectService(new PostgresProjectStore(pools), {
    createId: () => createUuidV7(clock),
    now: clock,
  });

  const app = createApp(configuration.DEPLOYMENT_MODE, {
    clock,
    createRequestId,
    productionReadinessProbe: () => verifiedReadiness(adapter),
    identityLifecycleService: adapter.identityLifecycleService,
    identityHttpSecurity: adapter.identityHttpSecurity,
    identityRateLimiter: adapter.identityRateLimiter,
    tenantSessionResolver: resolver,
    projectService: service,
  });
  const handleBetterAuth = (request: Request) =>
    identityRuntime.handler(request);
  app.all('/api/auth', (context) =>
    handleBetterAuth(context.req.raw),
  );
  app.all('/api/auth/*', (context) =>
    handleBetterAuth(context.req.raw),
  );

  let closePromise: Promise<void> | undefined;
  return {
    app,
    close: () => {
      closePromise ??= Promise.resolve().then(() => adapter.close());
      return closePromise;
    },
  };
}

async function safelyCreateIdentityRuntime(
  adapter: CustomerManagedRuntimeAdapter,
  factory: (
    config: CustomerManagedIdentityRuntimeConfig,
  ) => BetterAuthRuntime,
): Promise<BetterAuthRuntime> {
  try {
    return factory(adapter.identity);
  } catch {
    await Promise.resolve(adapter.close()).catch(() => undefined);
    throw new ProductionCompositionError('INVALID_CUSTOMER_RUNTIME_ADAPTER');
  }
}

async function createAdapter(
  adapterModule: CustomerManagedRuntimeAdapterModule,
): Promise<CustomerManagedRuntimeAdapter> {
  try {
    return parseAdapter(
      await adapterModule.createCustomerManagedRuntimeAdapter(),
    );
  } catch (error) {
    if (error instanceof ProductionCompositionError) throw error;
    throw new ProductionCompositionError('INVALID_CUSTOMER_RUNTIME_ADAPTER');
  }
}

async function verifiedReadiness(
  adapter: CustomerManagedRuntimeAdapter,
): Promise<ProductionDependencyStatus> {
  const result: unknown = await adapter.checkReadiness();
  if (
    !isRecord(result) ||
    result.identity !== 'ready' ||
    result.database !== 'ready' ||
    Object.keys(result).some(
      (key) => key !== 'identity' && key !== 'database',
    )
  ) {
    throw new ProductionCompositionError('INVALID_CUSTOMER_RUNTIME_ADAPTER');
  }
  return { identity: 'ready', database: 'ready' };
}

async function safelyImport(
  importer: (specifier: string) => Promise<unknown>,
  specifier: string,
): Promise<unknown> {
  try {
    return await importer(specifier);
  } catch {
    throw new ProductionCompositionError('INVALID_CUSTOMER_RUNTIME_ADAPTER');
  }
}

function parseAdapterModule(value: unknown): CustomerManagedRuntimeAdapterModule {
  if (!isRecord(value) || typeof value.createCustomerManagedRuntimeAdapter !== 'function') {
    throw new ProductionCompositionError('INVALID_CUSTOMER_RUNTIME_ADAPTER');
  }
  return value as CustomerManagedRuntimeAdapterModule;
}

function parseAdapter(value: unknown): CustomerManagedRuntimeAdapter {
  if (
    !isRecord(value) ||
    value.kind !== 'customer-managed-production' ||
    !isCustomerManagedIdentityRuntimeConfig(value.identity) ||
    !hasFunctions(value.identityLifecycleService, [
      'authenticate',
      'registerPassword',
      'completeEmailVerification',
      'loginPassword',
      'createPasskeyRegistrationOptions',
      'verifyPasskeyRegistration',
      'createPasskeyAuthenticationOptions',
      'verifyPasskeyAuthentication',
      'startOAuth',
      'completeOAuth',
      'getCurrentSession',
      'listSessions',
      'listDevices',
      'revokeSession',
      'revokeOtherSessions',
      'revokeAllSessions',
      'logout',
      'requestPasswordRecovery',
      'completePasswordRecovery',
      'createRecentAuthProofWithPassword',
      'requestAccountExport',
      'getAccountExport',
      'requestAccountDeletion',
      'getAccountDeletion',
      'cancelAccountDeletion',
      'confirmAccountDeletion',
    ]) ||
    !hasFunctions(value.identityHttpSecurity, ['enforce']) ||
    !hasFunctions(value.identityRateLimiter, ['consume']) ||
    typeof value.principalPoolForContext !== 'function' ||
    typeof value.checkReadiness !== 'function' ||
    typeof value.close !== 'function'
  ) {
    throw new ProductionCompositionError('INVALID_CUSTOMER_RUNTIME_ADAPTER');
  }
  return value as CustomerManagedRuntimeAdapter;
}

function hasFunctions(
  value: unknown,
  names: readonly string[],
): boolean {
  return (
    isRecord(value) &&
    names.every((name) => typeof value[name] === 'function')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
