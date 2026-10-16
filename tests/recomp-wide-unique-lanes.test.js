// Lane reads of a wide SLEIGH temporary must see the value written to it.
// pypcode 4.x lowers `movups xmm0,[m]` as `unique[X:16] = [m]; XMM0_Da = unique[X:4];
// XMM0_Db = unique[X+4:4] ...` (3.3.3 used SUBPIECE). The lifter names uniques by
// exact (offset, size), so each lane read used to be a never-written C variable that
// clang folds to 0: the shipped boot.wasm lost 8,931 SSE loads this way, among them
// glfwCreateWindow's copy of the context hints (window NULL, assert window != NULL).
// Parent command: node --test tests/recomp-wide-unique-lanes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lift = join(root, 'scripts', 'recomp', 'lift');
const python = [process.env.PYTHON, 'python3', 'python'].find((path) => path && spawnSync(path,
  ['-B', '-c', 'import capstone, pypcode'], { encoding: 'utf8', timeout: 10000 }).status === 0);

let receipt;
function run(t) {
  if (!python) {
    t.skip('no Python with capstone+pypcode available');
    return null;
  }
  if (!receipt) {
    const temporary = mkdtempSync(join(tmpdir(), 'isaac-wide-lanes-'));
    try {
      const script = join(temporary, 'fixture.py');
      writeFileSync(script, fixture);
      const result = spawnSync(python, ['-B', script, lift, temporary], {
        cwd: root, encoding: 'utf8', timeout: 240000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' },
      });
      assert.equal(result.status, 0,
        result.error?.message || `Python exited ${result.status}\n${result.stdout}\n${result.stderr}`);
      receipt = JSON.parse(result.stdout);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return receipt;
}

const fixture = String.raw`
import ctypes, json, os, shutil, struct, subprocess, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
temporary = Path(sys.argv[2])
import pypcode
from emit import gen_state_header
from lift import Decoder, FuncEmitter, LANG, RegMap, unique_aliases

out = {'pypcode': getattr(pypcode, '__version__', '?')}

# --- the alias rule on synthetic ops: independent of the installed pypcode ---
def vn(space, off, size):
    return SimpleNamespace(space=SimpleNamespace(name=space), offset=off, size=size)
def op(output, *inputs):
    return SimpleNamespace(opcode=None, output=output, inputs=list(inputs))
U = lambda off, size: vn('unique', off, size)
R = lambda off, size: vn('register', off, size)
mem = vn('ram', 0x3000, 16)
lanes = [op(U(0x100, 16), mem)] + [op(R(0x1200 + 4 * i, 4), U(0x100 + 4 * i, 4)) for i in range(4)]
subpiece = [op(U(0x100, 16), mem)] + [op(R(0x1200 + 4 * i, 4), U(0x100, 16), vn('const', 4 * i, 4))
                                      for i in range(4)]
unwritten = [op(R(0x1200, 4), U(0x204, 4))]
partial = [op(U(0x100, 16), mem), op(U(0x104, 4), R(0, 4)), op(R(0x1200, 16), U(0x100, 16))]
def shape(ops):
    alias, faults = unique_aliases(ops)
    return {'alias': sorted([list(k) + list(v) for k, v in alias.items()]),
            'faults': sorted(faults)}
out['rules'] = {'lanes': shape(lanes), 'subpiece': shape(subpiece),
                'unwritten': shape(unwritten), 'partial': shape(partial)}

# --- end to end: lift real SSE instructions, run them natively, compare memory ---
class FixturePE:
    def __init__(self):
        self.image = bytearray(0x4000)
    def read(self, va, n):
        if va < 0 or va + n > len(self.image):
            raise ValueError('outside fixture image')
        return bytes(self.image[va:va + n])

pe = FixturePE()
code = [
    '0f100500300000',    # movups xmm0,[0x3000]
    '0f110500380000',    # movups [0x3800],xmm0
    '0f1001',            # movups xmm0,[ecx]          (ecx = 0x3010)
    '0f110510380000',    # movups [0x3810],xmm0
    '0f280520300000',    # movaps xmm0,[0x3020]       {-1.5, 2.25, -3, 4}
    '0f540530300000',    # andps  xmm0,[0x3030]       fabs mask
    '0f110520380000',    # movups [0x3820],xmm0
    '0f570540300000',    # xorps  xmm0,[0x3040]       sign mask
    '0f110530380000',    # movups [0x3830],xmm0
    'f30f7e0550300000',  # movq xmm0,[0x3050]         {-7, 123456}
    'f30fe6c0',          # cvtdq2pd xmm0,xmm0          both lanes: an 8-byte temporary
    '660f110540380000',  # movupd [0x3840],xmm0
    'c3',                # ret
]
at = 0x1000
for hexcode in code:
    b = bytes.fromhex(hexcode)
    pe.image[at:at + len(b)] = b
    at += len(b)
pe.image[0x3000:0x3010] = bytes(range(0x10, 0x20))
pe.image[0x3010:0x3020] = bytes(range(0xa0, 0xb0))
pe.image[0x3020:0x3030] = struct.pack('<4f', -1.5, 2.25, -3.0, 4.0)
pe.image[0x3030:0x3040] = struct.pack('<4I', *[0x7fffffff] * 4)
pe.image[0x3040:0x3050] = struct.pack('<4I', *[0x80000000] * 4)
pe.image[0x3050:0x3058] = struct.pack('<2i', -7, 123456)

ctx = pypcode.Context(LANG)
decoder = Decoder(pe, ctx)
body, va = {}, 0x1000
while va < at:
    length, ops = decoder.at(va)
    body[va] = (length, ops)
    va += length
regmap = RegMap(ctx)
emitter = FuncEmitter(regmap, 'sub_00001000', 0x1000, body, dict(local_flags=True))
source = emitter.run()
out['softTraps'] = [list(t) for t in emitter.soft_traps]
out['laneReads'] = source.count('recomp_rd32(b')

expected = (bytes(range(0x10, 0x20)) + bytes(range(0xa0, 0xb0))
            + struct.pack('<4f', 1.5, 2.25, 3.0, 4.0) + struct.pack('<4f', -1.5, -2.25, -3.0, -4.0)
            + struct.pack('<2d', -7.0, 123456.0))
out['expected'] = expected.hex()

compiler = next((shutil.which(n) for n in (os.environ.get('CC'), 'cc', 'gcc', 'clang')
                 if n and shutil.which(n)), None)
if compiler is None:
    out['skipExecution'] = 'no native C compiler available'
    print(json.dumps(out))
    sys.exit(0)
header, _ = gen_state_header(regmap)
(temporary / 'recomp_state.h').write_text(header)
driver = r'''
#include "recomp_state.h"
#include "recomp_rt.h"
#include <stdlib.h>
static uint8_t memory[0x4000];
uint8_t *recomp_mem_base = memory;
uint32_t recomp_jmp_pending, recomp_jmp_target, g_reentry_eip;
void recomp_unreachable(CpuState *s, uint32_t va) { (void)s; (void)va; abort(); }
void recomp_jump_indirect(CpuState *s, uint32_t target) { (void)s; (void)target; abort(); }
''' + source + r'''
void lanes_run(const uint8_t *image, unsigned size, uint8_t *result) {
  CpuState s = {0};
  memcpy(memory, image, size);
  s.ECX = 0x3010u; s.ESP = 0x2f00u;
  MEMW32(s.ESP, 0xfaceb00cu);
  sub_00001000(&s);
  memcpy(result, memory + 0x3800, 0x50);
}
'''
(temporary / 'lanes.c').write_text(driver)
library = temporary / 'lanes.so'
built = subprocess.run([compiler, '-O2', '-shared', '-fPIC', '-w', '-DRECOMP_MEM_IDENTITY=0',
                        '-I', str(temporary), '-I', sys.argv[1], str(temporary / 'lanes.c'),
                        '-o', str(library)], capture_output=True, text=True)
if built.returncode:
    raise RuntimeError(built.stdout + built.stderr)
lib = ctypes.CDLL(str(library))
image = (ctypes.c_uint8 * len(pe.image)).from_buffer_copy(pe.image)
result = (ctypes.c_uint8 * 0x50)()
lib.lanes_run(image, len(pe.image), result)
out['actual'] = bytes(result).hex()
print(json.dumps(out))
`;

test('lane reads of a wider unique alias the writer; unexpressible shapes become faults', (t) => {
  const r = run(t);
  if (!r) return;
  assert.deepEqual(r.rules.lanes, {
    alias: [[0x100, 4, 0x100, 16], [0x104, 4, 0x100, 16], [0x108, 4, 0x100, 16],
      [0x10c, 4, 0x100, 16]],
    faults: [],
  });
  assert.deepEqual(r.rules.subpiece, { alias: [], faults: [] });
  assert.deepEqual(r.rules.unwritten, { alias: [], faults: [0] });
  assert.deepEqual(r.rules.partial, { alias: [], faults: [1] });
});

test('lifted movups/andps/xorps/cvtdq2pd move the real bytes', (t) => {
  const r = run(t);
  if (!r) return;
  assert.deepEqual(r.softTraps, [], 'no instruction of the fixture may trap');
  if (r.skipExecution) {
    t.skip(r.skipExecution);
    return;
  }
  assert.equal(r.actual.slice(0, 32), r.expected.slice(0, 32), `movups [abs] (pypcode ${r.pypcode})`);
  assert.equal(r.actual.slice(32, 64), r.expected.slice(32, 64), 'movups [ecx]');
  assert.equal(r.actual.slice(64, 96), r.expected.slice(64, 96), 'andps fabs mask');
  assert.equal(r.actual.slice(96, 128), r.expected.slice(96, 128), 'xorps sign mask');
  assert.equal(r.actual.slice(128, 144), r.expected.slice(128, 144), 'cvtdq2pd low lane');
  assert.equal(r.actual.slice(144), r.expected.slice(144), 'cvtdq2pd high lane (narrow temporary, offset 4)');
});
