import { describe, expect, it, vi } from 'vitest';
import { registerOfflineSupport } from './offline.js';

describe('offline application shell registration', () => {
  it('registers the same-origin worker without using a cached worker script', async () => {
    const registration = { scope: 'http://localhost/' };
    const register = vi.fn().mockResolvedValue(registration);

    await expect(
      registerOfflineSupport({ register }),
    ).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  it('keeps the worker inside a subpath deployment', async () => {
    const registration = { scope: 'https://example.test/app/' };
    const register = vi.fn().mockResolvedValue(registration);

    await expect(
      registerOfflineSupport({ register }, '/app/'),
    ).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith('/app/sw.js', {
      scope: '/app/',
      updateViaCache: 'none',
    });
  });

  it('keeps portable mirror workers inside the nested app directory', async () => {
    const registration = { scope: 'https://example.test/mirrors/zuocheng/app/' };
    const register = vi.fn().mockResolvedValue(registration);

    await expect(
      registerOfflineSupport({ register }, './'),
    ).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith('./sw.js', {
      scope: './',
      updateViaCache: 'none',
    });
  });

  it('does not block the application when service workers are unavailable or fail', async () => {
    await expect(registerOfflineSupport(null)).resolves.toBeNull();
    await expect(
      registerOfflineSupport({
        register: vi.fn().mockRejectedValue(new Error('blocked')),
      }),
    ).resolves.toBeNull();
  });
});
