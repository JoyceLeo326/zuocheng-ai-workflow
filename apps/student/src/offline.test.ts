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

  it('does not block the application when service workers are unavailable or fail', async () => {
    await expect(registerOfflineSupport(null)).resolves.toBeNull();
    await expect(
      registerOfflineSupport({
        register: vi.fn().mockRejectedValue(new Error('blocked')),
      }),
    ).resolves.toBeNull();
  });
});
