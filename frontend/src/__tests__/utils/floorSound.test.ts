import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playScanErrorTone, __resetAudioContextForTests } from '../../utils/floorSound';

/** Minimal WebAudio stand-in — jsdom ships none. */
function makeFakeAudio(state: AudioContextState = 'running') {
  const oscillators: Array<{ started: number[]; stopped: number[]; type: string; freq: number }> = [];
  const ctx = {
    state,
    currentTime: 0,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    createOscillator: vi.fn(() => {
      const osc = {
        started: [] as number[],
        stopped: [] as number[],
        type: '',
        freq: 0,
        frequency: { set value(v: number) {}, get value() { return 0; } },
        connect: vi.fn(),
        start: vi.fn((t: number) => osc.started.push(t)),
        stop: vi.fn((t: number) => osc.stopped.push(t)),
      };
      oscillators.push(osc as never);
      return osc;
    }),
    createGain: vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    })),
  };
  return { ctx, oscillators };
}

/** `new` requires a real function — an arrow function is not a constructor,
 *  which silently yields a null context and an empty assertion. */
function ctorReturning(ctx: unknown) {
  return vi.fn(function () {
    return ctx;
  });
}

describe('playScanErrorTone', () => {
  beforeEach(() => {
    __resetAudioContextForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAudioContextForTests();
  });

  it('plays two beeps, so a rejection is distinct from the gun\'s own decode beep', () => {
    const { ctx, oscillators } = makeFakeAudio();
    vi.stubGlobal('AudioContext', ctorReturning(ctx));

    playScanErrorTone();

    // Two, not one: the gun already emits a single bright beep on decode, and
    // the operator at the storage shelf has to tell them apart by ear (§2.2).
    expect(oscillators).toHaveLength(2);
    expect(oscillators[1].started[0]).toBeGreaterThan(oscillators[0].started[0]);
  });

  it('resumes a context suspended by the autoplay policy', () => {
    // A kiosk that boots straight to /floor/scan may never have been clicked,
    // leaving the context suspended and every rejection silent.
    const { ctx } = makeFakeAudio('suspended');
    vi.stubGlobal('AudioContext', ctorReturning(ctx));

    playScanErrorTone();

    expect(ctx.resume).toHaveBeenCalled();
  });

  it('reuses one context across many scans', () => {
    // Browsers cap how many a document may create, and a kiosk runs for days.
    const { ctx } = makeFakeAudio();
    const Ctor = ctorReturning(ctx);
    vi.stubGlobal('AudioContext', Ctor);

    playScanErrorTone();
    playScanErrorTone();
    playScanErrorTone();

    expect(Ctor).toHaveBeenCalledTimes(1);
  });

  it('does nothing when WebAudio is unavailable', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);

    expect(() => playScanErrorTone()).not.toThrow();
  });

  it('does not throw when the context constructor fails', () => {
    // Failing to make a noise must never cost the operator a scan.
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        throw new Error('no audio device');
      }),
    );

    expect(() => playScanErrorTone()).not.toThrow();
  });

  it('does not throw when scheduling fails midway', () => {
    const { ctx } = makeFakeAudio();
    ctx.createOscillator = vi.fn(() => {
      throw new Error('context closed');
    });
    vi.stubGlobal('AudioContext', ctorReturning(ctx));

    expect(() => playScanErrorTone()).not.toThrow();
  });

  it('falls back to the webkit-prefixed constructor', () => {
    const { ctx, oscillators } = makeFakeAudio();
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', ctorReturning(ctx));

    playScanErrorTone();

    expect(oscillators).toHaveLength(2);
  });
});
