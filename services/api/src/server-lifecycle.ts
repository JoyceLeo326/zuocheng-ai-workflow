export type ClosableApiRuntime = Readonly<{
  close: () => Promise<void>;
}>;

export type ClosableServer = Readonly<{
  close: (callback: (error?: Error) => void) => void;
  closeIdleConnections?: () => void;
}>;

export type ProcessSignalSource = {
  exitCode: string | number | null | undefined;
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export function installGracefulShutdown(
  server: ClosableServer,
  runtime: ClosableApiRuntime,
  signalSource: ProcessSignalSource = process,
): Readonly<{ closed: Promise<void>; dispose: () => void }> {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= closeServer(server)
      .then(() => runtime.close())
      .catch(() => {
        signalSource.exitCode = 1;
      })
      .finally(() => {
        resolveClosed?.();
      });
  };
  const dispose = () => {
    signalSource.off('SIGINT', shutdown);
    signalSource.off('SIGTERM', shutdown);
  };

  signalSource.once('SIGINT', shutdown);
  signalSource.once('SIGTERM', shutdown);
  return { closed, dispose };
}

function closeServer(server: ClosableServer): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
