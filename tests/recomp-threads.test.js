// Guest threads as per-frame slices (recomp round 24). The game spawns three
// thread jobs through _beginthreadex and each is a loop that never returns:
// the audio device watcher, a 100 ms poller, and the async job queue that
// pops work off a ring and runs it -- which is where sound loads go, and why
// the WAV loader was never dispatched while no thread ran. Run inline they
// hang the boot; not run, everything queued behind them starves. The slice
// runner enters each adopted job from the top once per presented frame under
// a setjmp and yields (longjmp back, abandoning the slice's frames) where a
// real thread would block: Sleep, WaitForSingleObject, and an
// EnterCriticalSection that re-acquires the same lock with no other
// host-boundary call in between (the idle lap of a queue loop). These pins
// hold the parts of that contract together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'scripts', 'recomp', 'host', 'src');
const lift = join(root, 'scripts', 'recomp', 'lift');

test('isaac_guest_call is nesting-safe: the jmp_buf is saved around every call', () => {
  const mk = readFileSync(join(lift, 'mkdispatch.py'), 'utf8');
  assert.ok(mk.includes('static void isaac_guest_call_inner(uint32_t va, CpuState *restrict cpu) {'),
    'the setjmp body is the inner function');
  assert.ok(/void isaac_guest_call\(uint32_t va, CpuState \*restrict cpu\) \{\s*jmp_buf saved;\s*uint32_t esp_saved = g_guest_call_esp;\s*memcpy\(saved, g_guest_jmp, sizeof\(jmp_buf\)\);\s*g_guest_call_esp = cpu->ESP;\s*isaac_guest_call_inner\(va, cpu\);\s*memcpy\(g_guest_jmp, saved, sizeof\(jmp_buf\)\);\s*g_guest_call_esp = esp_saved;/.test(mk),
    'the public entry saves and restores the outer frame\'s jmp_buf, and (round 95) the guest ESP it was entered at');
  const modsrc = readFileSync(join(host, 'host_shims_module.c'), 'utf8');
  assert.ok(/const uint32_t guest_esp_saved = g_guest_call_esp;[^]*?isaac_guest_jmp_restore\(guest_saved\);\s*g_guest_call_esp = guest_esp_saved;/.test(modsrc),
    'round 95: a slice that yields restores the guest-call ESP with the jmp_buf');
  assert.ok(mk.includes('void isaac_guest_jmp_save(void *dst)') && mk.includes('void isaac_guest_jmp_restore(const void *src)'),
    'a slice that yields restores it through the accessors');
});

test('the slice runner enters a job under a setjmp and cleans the runtime after it', () => {
  const src = readFileSync(join(host, 'host_shims_module.c'), 'utf8');
  assert.ok(src.includes('void isaac_threads_slice(CpuState *restrict cpu) {'), 'the runner exists');
  assert.ok(/if \(setjmp\(g_slice_jmp\) == 0\) \{\s*isaac_guest_call\(g_thr\[i\]\.entry, &sub\);\s*g_thr\[i\]\.retired = 1;/.test(src),
    'a job that returns normally is retired; a yield lands past the call');
  // round 24b: a slice enters the loop function itself, not the engine's job
  // trampoline -- that wrapper frees its {obj, fn, arg} block before calling
  // fn, so a second entry through it finds fn == 0
  assert.ok(src.includes('g_thr[g_thr_n].entry = fn2 ? fn2 : fn;'), 'the entry is the loop function when the trampoline was decoded');
  assert.ok(src.includes('sub.ECX = g_thr[i].entry_arg;'), 'a thiscall loop function gets its object in ECX as well as on the stack');
  for (const line of ['g_slicing = 0;', 'recomp_jmp_pending = 0u;', 'g_reentry_eip = 0u;', 'isaac_guest_jmp_restore(guest_saved);']) {
    assert.ok(src.includes(line), `after a slice: ${line}`);
  }
  assert.ok(src.includes('if (!slice_mode() || g_slicing || !cpu) return;'), 'never re-entered, off with ISAAC_THREADS=0');
  assert.ok(/void isaac_threads_yield\(void\) \{\s*if \(g_slicing\) \{[\s\S]{0,120}longjmp\(g_slice_jmp, 1\);/.test(src),
    'yield is a longjmp back to the runner and a no-op outside a slice');
});

test('the critical-section shims are real bodies now, and the frame present slices', () => {
  const gen = readFileSync(join(root, 'scripts', 'recomp', 'host', 'gen_shims.py'), 'utf8');
  for (const n of ['InitializeCriticalSection', 'EnterCriticalSection', 'LeaveCriticalSection', 'DeleteCriticalSection', 'TryEnterCriticalSection']) {
    assert.ok(gen.includes(`"${n}@kernel32.dll": "REAL",`), `${n} is REAL`);
    assert.ok(!gen.includes(`"${n}@kernel32.dll": "STUB",`), `${n} is no longer a stub`);
  }
  const mod = readFileSync(join(host, 'host_shims_module.c'), 'utf8');
  assert.ok(mod.includes('void imp_kernel32__TryEnterCriticalSection(CpuState *restrict cpu) { cpu->EAX = 1; }'),
    'TryEnter succeeds: nothing can contend a single-threaded section');
  const win = readFileSync(join(host, 'host_shims_win.c'), 'utf8');
  assert.ok(win.includes('isaac_threads_slice(cpu); }'), 'SwapBuffers gives every live job one slice per frame');
  assert.ok(!mod.includes('cpu->EAX = h;\n        return;\n    }\n    if (g_thr_n < THR_MAX) {'),
    'the audio watcher is adopted like any other job (its object is still registered for the device event)');
  assert.ok(mod.includes('isaac_audio_pump_register(arg2);'), 'the device-event target is still registered at spawn');
});

test('a wait on a thread handle joins the job: its slices run until the loop returns', () => {
  // round 24f: the game stops a thread by setting its stop bit and waiting on
  // the handle; its Thread destructor then calls std::terminate if the thread
  // is still joinable. The handle is signalled at creation, so without the
  // join the wait returned at once and every shutdown aborted.
  const mod = readFileSync(join(host, 'host_shims_module.c'), 'utf8');
  assert.ok(mod.includes('int isaac_threads_join(uint32_t h, CpuState *restrict cpu) {'), 'the join exists');
  assert.ok(/for \(n = 0; n < cap && !g_thr\[i\]\.retired; \+\+n\) slice_job\(i, cpu\);/.test(mod),
    'it slices that one job until it retires, bounded by ISAAC_JOIN_SLICES');
  assert.ok(mod.includes('done flag forced'), 'a loop that ignores its stop bit is reported and the done flag forced');
  const wait = mod.slice(mod.indexOf('void imp_kernel32__WaitForSingleObject(CpuState *restrict cpu) {'));
  const joinAt = wait.indexOf('isaac_threads_join(h, cpu);');
  assert.ok(joinAt > 0 && joinAt < wait.indexOf('if (o->signaled) {'), 'WaitForSingleObject joins a thread handle before testing the signal');
  assert.ok(mod.includes('static void slice_job(unsigned i, CpuState *restrict cpu) {'), 'the per-frame runner and the join share one slice body');
});

test('round 94: a sliced job\'s Sleep is a wake time in interactive mode; the frame skips it until then', () => {
  const mod = readFileSync(join(host, 'host_shims_module.c'), 'utf8');
  const fwd = readFileSync(join(host, 'host_shims_forward.c'), 'utf8');
  const sleep = fwd.slice(fwd.indexOf('void imp_kernel32__Sleep(CpuState *restrict cpu) {'));
  const at = sleep.indexOf('isaac_threads_sleep(ms); }');
  assert.ok(at > 0 && at < sleep.indexOf('isaac_threads_yield(); }'), 'Sleep reports its duration before the slice yields');
  const fn = mod.slice(mod.indexOf('void isaac_threads_sleep(uint32_t ms) {'));
  assert.ok(/#ifdef ISAAC_WEB\s*extern int isaac_web_yield_enabled\(void\);\s*if \(g_slicing && isaac_web_yield_enabled\(\)\)\s*g_thr\[g_slice_cur\]\.wake_ms = emscripten_get_now\(\) \+ \(double\)ms;\s*#else\s*\(void\)ms;\s*#endif/.test(fn),
    'only an interactive (wall-clock) slice records a wake time; deterministic runs keep one slice per frame');
  assert.ok(mod.includes('int isaac_threads_napping(double wake_ms, double now_ms) { return wake_ms > now_ms; }'), 'the decision');
  const slice = mod.slice(mod.indexOf('void isaac_threads_slice(CpuState *restrict cpu) {'));
  const body = slice.slice(0, slice.indexOf('\n}'));
  assert.ok(/if \(isaac_threads_napping\(g_thr\[i\]\.wake_ms, now\)\) \{[^]*?continue;\s*\}\s*slice_job\(i, cpu\);/.test(body), 'a napping job sits the frame out');
  const job = mod.slice(mod.indexOf('static void slice_job(unsigned i, CpuState *restrict cpu) {'));
  const reset = job.indexOf('g_thr[i].wake_ms = 0.0;');
  assert.ok(reset > 0 && reset < job.indexOf('if (setjmp(g_slice_jmp) == 0) {'), 'each slice clears the wake: a yield that is not a Sleep runs next frame');
  const joinFn = mod.slice(mod.indexOf('int isaac_threads_join(uint32_t h, CpuState *restrict cpu) {'));
  assert.ok(!joinFn.slice(0, joinFn.indexOf('\n}')).includes('napping'), 'a join still slices the job back to back, asleep or not');
});
