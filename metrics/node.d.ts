/**
 * Minimal ambient declarations for the Node built-ins the metrics harness uses (the repo has no
 * @types/node; this keeps `npx tsc -p metrics` strict without adding a dependency).
 */
declare module 'node:worker_threads' {
  export const isMainThread: boolean;
  export const parentPort: { on(ev: 'message', cb: (msg: unknown) => void): void; postMessage(msg: unknown): void } | null;
  export const workerData: unknown;
  export class Worker {
    constructor(url: URL | string, opts?: { workerData?: unknown; execArgv?: string[] });
    on(ev: 'message', cb: (msg: unknown) => void): this;
    on(ev: 'error', cb: (err: Error) => void): this;
    on(ev: 'exit', cb: (code: number) => void): this;
    postMessage(msg: unknown): void;
    terminate(): Promise<number>;
  }
}
declare module 'node:fs' {
  export function mkdirSync(p: string, o?: { recursive?: boolean }): void;
  export function writeFileSync(p: string, data: string): void;
  export function readFileSync(p: string, enc: 'utf8'): string;
  export function existsSync(p: string): boolean;
}
declare module 'node:os' {
  export function availableParallelism(): number;
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...p: string[]): string;
  export function resolve(...p: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(p: string): string;
}
declare module 'node:url' {
  export function fileURLToPath(u: URL | string): string;
  export function pathToFileURL(p: string): URL;
}
declare const process: {
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  execArgv: string[];
  stdout: { write(s: string): boolean; isTTY?: boolean };
  env: Record<string, string | undefined>;
};
