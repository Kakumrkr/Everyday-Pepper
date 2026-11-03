// The owner time model (S47.3, playbook D-4, AC-W1-15, AC-W8-13): how long a person on a phone
// takes for each action of a journey. The journey spec charges each action as it performs it,
// so the total is the same on any machine and grows when a screen asks for more taps, typing or
// reading. The test also prints the wall clock, which measures the machine, not the person.
//
// Costs follow the keystroke-level model (Card, Moran and Newell, 1980; Kieras's KLM guide),
// slowed for one thumb on a phone and rounded up, so the model errs on the slow side:
//   - tap: KLM point (1.1 s) plus press (0.2 s), rounded up for thumb reach on a 6" screen.
//   - typeChar: 0.5 s a character, about 24 words a minute; studies of phone typing measure
//     about 36 (Palin et al., 2019, 37,000 people), so this is a slow typist.
//   - think: KLM mental preparation (1.35 s), charged before each decision or field.
//   - readWord: 200 words a minute, a slow reader on a small screen.
//   - load: a page or answer over a phone network.
// Steps that leave the app have their own fixed costs (below), each a careful guess written
// down so it can be challenged.

export const OWNER_TIME_SECONDS = {
  tap: 1.5,
  typeChar: 0.5,
  think: 1.35,
  readWord: 0.3,
  load: 2,
  /** Waiting for an email to arrive. */
  emailWait: 30,
  /** Leaving for another app (mail, authenticator, photos) and finding the right thing there. */
  switchApp: 10,
  /** Opening the photo picker, finding a photo in the camera roll and choosing it. */
  pickPhoto: 20,
  /** Adding an account to an authenticator app by scanning a QR code. */
  scanQrCode: 45,
  /** Saving backup codes (a screenshot or a password manager). */
  saveBackupCodes: 30,
} as const;

export type FixedCost = Exclude<
  keyof typeof OWNER_TIME_SECONDS,
  'tap' | 'typeChar' | 'think' | 'readWord'
>;

export interface OwnerTimeStep {
  name: string;
  seconds: number;
}

/** Words in `text` as a reader counts them (anything between spaces). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/** Charges a journey's actions step by step with the owner time model. */
export class OwnerClock {
  private readonly charged: OwnerTimeStep[] = [];

  constructor(private readonly costs: typeof OWNER_TIME_SECONDS = OWNER_TIME_SECONDS) {}

  /** Starts a named step; later charges go to it. */
  step(name: string): this {
    this.charged.push({ name, seconds: 0 });
    return this;
  }

  /** `count` taps, each after a moment's thought. */
  tap(count = 1): this {
    return this.add(count * (this.costs.think + this.costs.tap));
  }

  /** Thinks, taps into a field and types `text`. */
  type(text: string): this {
    return this.tap().add(text.length * this.costs.typeChar);
  }

  /** Reads `text` (a screen's or a card's words). */
  read(text: string): this {
    return this.add(wordCount(text) * this.costs.readWord);
  }

  /** A fixed cost: a load, an email's wait, a trip to another app. */
  wait(cost: FixedCost, count = 1): this {
    return this.add(count * this.costs[cost]);
  }

  /** Seconds charged in total. */
  total(): number {
    return this.charged.reduce((sum, step) => sum + step.seconds, 0);
  }

  steps(): readonly OwnerTimeStep[] {
    return this.charged;
  }

  /** One line per step and the total, in minutes and seconds, for the test's output. */
  report(title: string, wallClockMs?: number): string {
    const lines = this.charged.map(
      (step) => `  ${step.name.padEnd(28)} ${formatSeconds(step.seconds).padStart(7)}`,
    );
    lines.push(`  ${'Total (model)'.padEnd(28)} ${formatSeconds(this.total()).padStart(7)}`);
    if (wallClockMs !== undefined) {
      lines.push(
        `  ${'Wall clock (this machine)'.padEnd(28)} ${formatSeconds(wallClockMs / 1000).padStart(7)}`,
      );
    }
    return `${title}\n${lines.join('\n')}`;
  }

  private add(seconds: number): this {
    const current = this.charged.at(-1);
    if (current === undefined) throw new Error('OwnerClock: start a step before charging time');
    current.seconds += seconds;
    return this;
  }
}

/** `95.4` → `"1:35"`. */
export function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}
