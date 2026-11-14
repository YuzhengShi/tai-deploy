/**
 * Doubles of the engine's two replaceable parts, for the tests of the agent and the engine: ears that say what the test tells them to, and a mouth that makes a tone of the length the test
 * asks for (or fails the way the test asks). They implement the contracts of src/voice/lab/types.ts and nothing else; the fakes of LabGPU's and Deepgram's real sockets are in the other
 * files of this folder.
 */
import { MouthError, OUT_BYTES_PER_MS, type Ears, type EarsHandlers, type Mouth, type SynthOptions, type TurnFields } from '../types.js';

export class FakeEars implements Ears {
  connected = false;
  closed = false;
  audio = 0;
  readonly turnFields: TurnFields[] = [];
  forced = 0;
  connectError: Error | null = null;

  constructor(
    readonly name: string,
    readonly decidesTurn: boolean,
    readonly handlers: EarsHandlers,
    readonly clock: () => number,
  ) {}

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  sendAudio(pcm: Buffer): void {
    if (this.connected) this.audio += pcm.length;
  }

  setTurnFields(fields: TurnFields): void {
    this.turnFields.push(fields);
  }

  forceEndTurn(): void {
    this.forced++;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
  }

  // what a recognizer says
  partial(text: string): void {
    this.handlers.partial(text, this.clock());
  }
  final(text: string, info: { trigger?: string; confidence?: number } = {}): void {
    this.handlers.final(text, this.clock(), info);
  }
  startOfTurn(text = 'hi'): void {
    this.handlers.startOfTurn?.(this.clock(), text);
  }
  drop(reason = 'closed'): void {
    this.connected = false;
    this.handlers.down(reason);
  }
}

export interface FakeMouthOptions {
  name?: string;
  takesSpeed?: boolean;
  /** How long the audio of a sentence is (ms): a number, or a function of the text. */
  ms?: number | ((text: string) => number);
  /** Called for every request (to fail it, delay it, or record it). May throw a MouthError. */
  onRequest?: (text: string, opts: SynthOptions) => Promise<void> | void;
}

export class FakeMouth implements Mouth {
  readonly name: string;
  readonly takesSpeed: boolean;
  readonly requests: Array<{ text: string; voice: string; speed?: number }> = [];

  constructor(private readonly opts: FakeMouthOptions = {}) {
    this.name = opts.name ?? 'fake';
    this.takesSpeed = opts.takesSpeed ?? false;
  }

  async *synthesize(text: string, o: SynthOptions): AsyncGenerator<Buffer> {
    this.requests.push({ text, voice: o.voice, speed: o.speed });
    await this.opts.onRequest?.(text, o);
    const ms = typeof this.opts.ms === 'function' ? this.opts.ms(text) : (this.opts.ms ?? 600);
    const pcm = Buffer.alloc(Math.round(ms * OUT_BYTES_PER_MS) & ~1);
    for (let i = 0; i + 1 < pcm.length; i += 2) pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 330 * (i / 2)) / 24_000)), i);
    // in a few pieces, as a real service answers
    const step = Math.max(2, Math.floor(pcm.length / 4) & ~1);
    for (let off = 0; off < pcm.length; off += step) {
      if (o.signal?.aborted) return;
      yield pcm.subarray(off, Math.min(pcm.length, off + step));
    }
  }
}

export const failingMouth = (kind: 'down' | 'fallback' | 'bad-audio' = 'down', name = 'labgpu'): FakeMouth =>
  new FakeMouth({
    name,
    onRequest: () => {
      throw new MouthError(kind, 'refused');
    },
  });
