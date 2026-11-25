import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten';

/*
 * Runs the checks an ADMIN writes (regular expressions, JavaScript functions) in an engine of its own: QuickJS, compiled to
 * WebAssembly. Nothing of this server is reachable from inside — no files, no network, no environment, no database — and
 * each run has its own memory (4 MB) and a time limit, after which it is stopped; also a runaway regular expression.
 */
const MEMORY = 4 * 1024 * 1024;
const STACK = 256 * 1024;
export const TIME_LIMIT_MS = 50;

let engine: Promise<QuickJSWASMModule> | null = null;
const load = () => (engine ??= getQuickJS());

type Outcome = { ok: true; value: unknown } | { ok: false; slow: boolean; message: string };

async function run(work: (vm: QuickJSContext) => QuickJSHandle): Promise<Outcome> {
  const runtime = (await load()).newRuntime();
  runtime.setMemoryLimit(MEMORY);
  runtime.setMaxStackSize(STACK);
  const until = performance.now() + TIME_LIMIT_MS;
  let slow = false;
  runtime.setInterruptHandler(() => (slow = performance.now() > until));
  const vm = runtime.newContext();
  try {
    return { ok: true, value: work(vm).consume((h) => vm.dump(h) as unknown) };
  } catch (err) {
    return { ok: false, slow, message: slow ? 'it takes too long' : err instanceof Error ? err.message : 'it failed' };
  } finally {
    /* Everything of the run goes with its runtime. */
    vm.dispose();
    runtime.dispose();
  }
}

/* A value inside the engine: a text, or an object of texts. */
function put(vm: QuickJSContext, v: string | Record<string, string>): QuickJSHandle {
  if (typeof v === 'string') return vm.newString(v);
  const o = vm.newObject();
  for (const [key, text] of Object.entries(v)) vm.newString(text).consume((h) => vm.setProp(o, key, h));
  return o;
}

function call(vm: QuickJSContext, source: string, args: (string | Record<string, string>)[]): QuickJSHandle {
  const fn = vm.unwrapResult(vm.evalCode(source, 'check.js'));
  const handles = args.map((a) => put(vm, a));
  try {
    return vm.unwrapResult(vm.callFunction(fn, vm.undefined, ...handles));
  } finally {
    for (const h of [fn, ...handles]) h.dispose();
  }
}

const REGEX = `(function (source, flags, value) { return new RegExp('^(?:' + source + ')$', flags).test(value); })`;

/* Whether the whole value matches. */
export const matches = (source: string, flags: string, value: string) =>
  run((vm) => call(vm, REGEX, [source, flags, value])) as Promise<
    { ok: true; value: boolean } | { ok: false; slow: boolean; message: string }
  >;

/* What a function (value, form) answers. */
export const answer = (source: string, value: string, form: Record<string, string>) =>
  run((vm) => call(vm, `(${source}\n)`, [value, form]));

/* What is wrong with a function as written; null = it is one. */
export async function functionProblem(source: string): Promise<string | null> {
  const r = await run((vm) => vm.unwrapResult(vm.evalCode(`typeof (${source}\n)`, 'check.js')));
  if (!r.ok) return r.message;
  return r.value === 'function' ? null : 'it is not a function: write function (value, form) { … }';
}

/* What is wrong with an expression as written; null = it compiles and answers in time, also for long answers. */
export async function expressionProblem(source: string, flags: string): Promise<string | null> {
  for (const sample of ['', `${'a'.repeat(250)}!`, `${'1'.repeat(250)}!`, `${'a1 '.repeat(83)}!`, `${'आ'.repeat(250)}!`]) {
    const r = await matches(source, flags, sample);
    if (!r.ok) return r.message;
  }
  return null;
}
