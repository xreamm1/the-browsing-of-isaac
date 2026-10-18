# Mobile performance

What was measured on the published page (no rebuild of the module), what was
changed, and what was rejected. Devices in scope: Huawei nova Y61, Huawei nova
14i, Realme C55 (90 Hz) and iPhone 17 Pro Max (120 Hz).

## How it was measured

No physical phones were available, so every number below comes from emulation.
Treat them as relative (A against B), not as what a phone will show.

- Headless Chromium with SwiftShader, so the GPU is software and the frame is
  bound by rendering. The viewport is a phone's, 860×412 CSS px at DPR 2, with
  touch on. The CPU is throttled through CDP (`Emulation.setCPUThrottlingRate`).
- The page is the local `index.html`, served under a fake origin. Chunks come
  from the live CDN.
- A run starts a game, waits 8 s, then plays for 40 s, alternating movement
  and shooting directions. The probe stamps every animation frame in which
  `window.isaacFrame` moved, and also counts game ticks (`Game+0x264f8`).
- Reported: FPS (presents per second), 1% low (FPS over the slowest 1% of
  intervals), p95 (frame interval, ms) and ticks per second.
- Identical runs differ by up to ±15%. Only differences that hold in every
  interleaved pair count. Runs never overlap: a parallel browser on the same
  4 cores halved the numbers once, and that set was thrown away.

On real phones, use `?stats=1` (the FPS line) and `chrome://inspect` on
Android, Safari Web Inspector on iPhone, or `about:debugging` in Firefox.

## Where the frame goes

CPU profile at CPU ×4, 25 s of play:

| Main thread | Share |
| --- | --- |
| idle | 67% |
| `(program)` (V8/compositor glue) | 16% |
| wasm (lifted game + host) | 8.7% |
| `getError` (the every-64th-present drain; a GPU round trip) | 3.9% |
| page JS (touch, overlays, loader) | 1.7% |
| audio (`isaac_audio_js_buffer`) | 0.1% |

The main thread waits most of the time, so in this setup the frame is bound
by the GPU, not by game code. A real Mali-G51 (nova Y61) is also weak at fill,
so the same holds there. The Kirin 710's CPU is not fast either, though, so a
physical profile may show wasm higher.

One gameplay frame on the GL side:

- about 25 draw calls, 72 attribute enable/disable pairs, 11 framebuffer binds
  and 11 clears;
- four full-screen passes at 960×540 into 1024×1024 targets and two at
  480×270, then one quad to the canvas;
- the context is created with the defaults: `preserveDrawingBuffer` is already
  false, stencil is already off, antialias is off (an earlier commit).

Nothing renders above the canvas resolution.

## Applied

| Change | Before → after (CPU ×1, DPR 2) | Commit |
| --- | --- | --- |
| The touch HUD canvas covers only the pause/twin marks (95×50 CSS px instead of the whole 732×412 picture) and is hidden when empty. It was a transparent full-screen layer the compositor blended over the game every frame. | FPS 14.6 / 18.3 / 16.7 → 16.3 / 18.3 / 17.8 (mean +5.7%); p95 139.5 / 110.1 / 116.3 → 116.6 / 106.1 / 112.1 ms; 1% low 3.7 / 3.7 / 4.3 → 4.6 / 4.3 / 6.1. With the layer removed outright: 15.8 / 14.3 → 18.1 / 17.1. | `7ebaac7` |
| The unsupported-browser message names the fix for each device: on Huawei, Firefox 153+ from AppGallery first, then Chrome or Edge 137+; on Android, Chrome; on iPhone, an iOS update. | — (compatibility) | `d7b8249`, `31a69ee` |

Applied earlier in this series, already measured: no multisampling on the game
canvas (19.2 → 21.5 FPS headless), `powerPreference: high-performance`, and an
adaptive controller that turns the ambient-light layer and background chunk
storing off below 25 FPS.

## Rejected

| Idea | Result |
| --- | --- |
| `alpha: false` on the game canvas (an opaque layer for the compositor) | 16.4 / 14.1 against 14.5 / 16.6 / 18.7 FPS: inside the noise. It stays as an opt-in switch, `?gla=0`, for testing on a real Mali. |
| `depth: false` on the game canvas | 14.2 FPS: no gain. It stays as `?gld=0`. |
| DPR 1 instead of 2 (less compositing) | 17.8 / 14.9 against 15.8 / 14.3: not stable, and the picture gets blurrier. |
| One shared tick for the page's timers (touch, FPS badge, gamepad, menus) | All page JS is 1.7% of a frame on a main thread that is 67% idle. Nothing to measure. |
| Moving background work off the frame | Chunk storing already pauses below 25 FPS. Reads and unscrambling are under 0.3%. |
| AudioWorklet | Sound is played as WebAudio buffers. There is no ScriptProcessor and the audio cost is 0.1%. |
| Capping 90/120 Hz screens to 60 | Already done. Above 66 Hz the game turns its own 1/60 s limiter on (round 97). |

## Status by browser

| Device / browser | Status |
| --- | --- |
| iPhone 17 Pro Max, Safari | Runs (reported 20–30 FPS). Low Power Mode caps the page at 30 FPS (WebKit bug 215745), and 30 is the game's full tick rate. Fullscreen only works from the Home Screen icon, which the page explains. |
| Huawei nova Y61 / nova 14i, Huawei Browser | Usually no JSPI (an older Chromium). The page now recommends Firefox 153+ from AppGallery. The owner mostly tests in Firefox and finds it the best. The exact SoC/GPU should be read from `WEBGL_debug_renderer_info` on the phone (the `?stats=1` line shows it). |
| Realme C55, Chrome | Chrome 137+ has JSPI. The 90 Hz screen is handled by the game's own 60 Hz limiter. |

## Next (needs a rebuild of the module)

These need the game executable, Ghidra and Emscripten, which this pass did not
have:

- compiler profile: `-O2` against `-O3`, SIMD, ThinLTO, `wasm-opt` on link, PGO;
- hand fast paths for the top of a `--profiling-funcs` profile (the render
  `0x009555c0` at 56%, the batch flush `0x00a19180` at 29%), each checked
  differentially against the lifted code;
- `invalidateFramebuffer` on render targets whose contents are dead, and a
  check whether the depth clear after every pass is needed (tile GPUs pay for
  both);
- `isaac_yield_js`'s 15 ms threshold derived from the measured rAF period;
- a steady 30 FPS target with hysteresis on devices that cannot hold 60,
  through the render gate.
