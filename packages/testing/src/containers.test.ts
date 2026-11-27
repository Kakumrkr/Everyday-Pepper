import { describe, expect, it, vi } from 'vitest';
import { STOP_WAIT, stopContainer } from './containers.js';

// Stopping a test container (S78's CI): Docker's brief "still running" after a kill waits and
// stops again; anything else is thrown at once.

const stillRunning = () =>
  new Error(
    '(HTTP code 409) unexpected - cannot remove container "4cb2": container is running: stop the container before removing or force remove',
  );
const noPause = () => Promise.resolve();

describe('stopContainer', () => {
  it('stops once when Docker removes it at once', async () => {
    const stop = vi.fn(() => Promise.resolve(undefined as never));
    await stopContainer({ stop }, noPause);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('waits out "container is running" and stops again', async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(stillRunning())
      .mockRejectedValueOnce(stillRunning())
      .mockResolvedValueOnce(undefined);
    const pause = vi.fn(noPause);
    await stopContainer({ stop }, pause);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledWith(STOP_WAIT.pauseMs);
  });

  it('throws any other error at once, and a refusal that lasts', async () => {
    const other = vi.fn().mockRejectedValue(new Error('no such container'));
    await expect(stopContainer({ stop: other }, noPause)).rejects.toThrow('no such container');
    expect(other).toHaveBeenCalledTimes(1);
    const lasting = vi.fn().mockRejectedValue(stillRunning());
    await expect(stopContainer({ stop: lasting }, noPause)).rejects.toThrow('container is running');
    expect(lasting).toHaveBeenCalledTimes(STOP_WAIT.tries);
  });
});
