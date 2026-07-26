import { describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown } from './server-lifecycle.js';

describe('API server lifecycle', () => {
  it('stops accepting traffic and closes customer resources exactly once on signals', async () => {
    const listeners = new Map<string, () => void>();
    const processSignals = {
      exitCode: undefined as number | undefined,
      once: vi.fn((signal: string, listener: () => void) => {
        listeners.set(signal, listener);
        return processSignals;
      }),
      off: vi.fn((signal: string) => {
        listeners.delete(signal);
        return processSignals;
      }),
    };
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback()),
      closeIdleConnections: vi.fn(),
    };
    const closeRuntime = vi.fn(async () => undefined);
    const lifecycle = installGracefulShutdown(
      server,
      { close: closeRuntime },
      processSignals,
    );

    listeners.get('SIGTERM')?.();
    listeners.get('SIGINT')?.();
    await lifecycle.closed;

    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(processSignals.exitCode).toBeUndefined();
  });

  it('sets a failure exit code if resource shutdown fails', async () => {
    const listeners = new Map<string, () => void>();
    const processSignals = {
      exitCode: undefined as number | undefined,
      once(signal: string, listener: () => void) {
        listeners.set(signal, listener);
        return this;
      },
      off() {
        return this;
      },
    };
    const lifecycle = installGracefulShutdown(
      { close: (callback) => callback(), closeIdleConnections: () => undefined },
      { close: async () => Promise.reject(new Error('secret close error')) },
      processSignals,
    );

    listeners.get('SIGTERM')?.();
    await lifecycle.closed;
    expect(processSignals.exitCode).toBe(1);
  });
});
