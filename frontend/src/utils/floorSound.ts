/**
 * Audible rejection feedback for scans made out of sight of the screen
 * (docs/floor-plan.md §2.2).
 *
 * The storage shelf is away from the PC, so an operator scanning there hears
 * the gun's decode beep but cannot see whether the app accepted the payload.
 * A gun beeps on a successful *decode*, which says nothing about whether the
 * app understood it — an unregistered SKU beeps exactly like a good one, which
 * is a false confirmation. So rejections get their own sound.
 *
 * Deliberately narrow:
 *
 * - **Errors only.** Accepted scans stay silent. The gun already beeps, and a
 *   second confirming sound would just train the operator to ignore both.
 * - **Synthesised, not a file.** No asset to ship, cache or fail to load.
 * - **A bridge, not a platform.** §2.2 expects a second screen at storage to
 *   retire this problem; this is not the start of an audio-feedback layer.
 */

/** Low and buzzy, to cut through a workshop and be unmistakably *not* the
 *  gun's own bright confirmation beep. */
const TONE_HZ = 155;
const BEEP_MS = 140;
const GAP_MS = 90;
const GAIN = 0.18;

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  // One context reused for the page's life: browsers cap how many a document
  // may create, and a kiosk runs for days.
  if (!context) {
    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }
  return context;
}

function scheduleBeep(ctx: AudioContext, startAt: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = TONE_HZ;
  // Ramp the edges: an abrupt square-wave start clicks, which on cheap PC
  // speakers can be louder than the tone itself.
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(GAIN, startAt + 0.01);
  gain.gain.setValueAtTime(GAIN, startAt + BEEP_MS / 1000 - 0.01);
  gain.gain.linearRampToValueAtTime(0, startAt + BEEP_MS / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + BEEP_MS / 1000);
}

/**
 * Two short low buzzes: "the app rejected that".
 *
 * Silently does nothing when audio is unavailable or still blocked by the
 * browser's autoplay policy. That policy is why this matters in practice: a
 * kiosk that boots straight to `/floor/scan` and is never clicked may have a
 * suspended context, so we try to resume it — the first scan usually counts as
 * the required user gesture, and every later rejection is then audible.
 *
 * Never throws. A failure to make a noise must not cost the operator a scan.
 */
export function playScanErrorTone(): void {
  const ctx = getContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      // Fire-and-forget: if the gesture requirement is still unmet this
      // rejects, and the beep is simply skipped.
      void ctx.resume().catch(() => undefined);
    }
    const now = ctx.currentTime;
    scheduleBeep(ctx, now);
    scheduleBeep(ctx, now + (BEEP_MS + GAP_MS) / 1000);
  } catch {
    // Audio is a courtesy; scanning continues regardless.
  }
}

/** Test seam — drops the cached context so a suite can assert on a fresh one. */
export function __resetAudioContextForTests(): void {
  context = null;
}
