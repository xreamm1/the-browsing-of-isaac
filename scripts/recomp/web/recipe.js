// A window "recipe": how to rebuild 1 MiB of a version-0 KAGE archive from a smaller
// download (scripts/recomp/assets/recipe.py writes them). One self-contained function,
// because the page defines it globally and hands its source text to the reader Worker
// (String(isaacRecipeDecode)); node tests evaluate this same file.
//
// Version 0 is the archive format whose entries are only XORed with a xorshift keystream
// and byte-permuted per dword (archive.py raw_encode; the engine reads it through its
// "raw XOR" codec). So a recipe can ship an entry's PLAIN bytes, coded however suits
// them, and the bytes the engine reads are made here:
//
//   recipe   = "RW" 1 | u32 outLen | u16 segments | segment*         (little endian)
//            | "RW" 2 | u32 outLen | u16 segments | u8 heads | head* | segment*
//   head     = u8 channels u32 rate u32 len bytes          (version 2, round 96d) a Vorbis
//              stream's three headers as WebCodecs' description (Xiph-laced); the parts
//              of one (channels, rate) share it
//   segment  = 0 u32 len bytes                                        raw bytes, as they are
//            | 1 u32 outLen u32 key0 u8 skip u16 parts part*          a version-0 entry piece:
//              parts give the plain bytes of whole dwords from the dword holding the piece's
//              first byte; each dword is permuted by key & 15 (2: reverse, 9: swap pairs,
//              13: swap halves) and XORed with key; key then steps (xorshift 8/9/23); the
//              piece is those bytes from `skip`, `outLen` long.
//   part     = 0 u32 len bytes                                        plain bytes
//            | 1 u8 channels u32 frames u32 skip u32 take u32 coded bytes
//              16-bit PCM, `frames` frames coded below; the plain bytes are bytes
//              [skip, skip + take) of the decoded interleaved little-endian samples.
//            | 2 u8 channels u32 frames u32 skip u32 take u32 coded u16 first u16 block bytes
//              the same in blocks of `block` frames, the first `first` long (0: a whole
//              one): the blocks stay on the sound's own grid where a window cuts it.
//            | 3 u8 channels u32 frames u32 skip u32 take u32 lead u8 head u32 packets u32 coded bytes
//              Vorbis (version 2): `packets` packets, each a LEB128 length and its bytes, decoded
//              with head table entry `head`; the first `lead` decoded frames are the sound
//              before this share (context, dropped), then `frames` frames are this share,
//              rounded to 16 bits; the plain bytes are bytes [skip, skip + take) of them.
//              Lossy: the decode is the browser's (WebCodecs AudioDecoder), so the call
//              returns a Promise for a version 2 recipe with Vorbis in it; `vorbis(head,
//              packets)`, when given, decodes instead and returns (a Promise of) float planes.
//
// PCM code (MSB-first bits): blocks of up to 4096 frames (part 2: its block). Stereo blocks start with
// 2 bits: 0 left/right, 1 left/side, 2 right/side (side = right - left, 17-bit). Per coded
// channel: 3 bits predictor -- 0..4 FLAC's fixed order, 7 verbatim -- then verbatim
// samples, or `order` warm-up samples and the residual in 4 partitions (the first
// count % 4 one longer), each a 5-bit Rice parameter k and per residual a unary quotient
// (ones ended by a zero) and k low bits; zigzag decoded. Predictor 5: 4 bits s, then the
// channel coded at width - s, every sample shifted left by s (FLAC's wasted bits: a
// block whose low s bits are all zero, as near-lossless sound effects make them).
function isaacRecipeDecode(src, vorbis) {
  var B = src;
  var p = 0;
  function u8() { return B[p++]; }
  function u16() { var v = B[p] | (B[p + 1] << 8); p += 2; return v; }
  function u32() { var v = (B[p] | (B[p + 1] << 8) | (B[p + 2] << 16) | (B[p + 3] << 24)) >>> 0; p += 4; return v; }

  function pcmDecode(code, ch, frames, first, block) {
    var n = code.length;
    var C = new Uint8Array(n + 8);
    C.set(code);
    var bp = 0;
    function word() {
      var i = bp >>> 3;
      return ((C[i] << 24) | (C[i + 1] << 16) | (C[i + 2] << 8) | C[i + 3]) >>> 0;
    }
    function bits(k) {
      if (k === 0) return 0;
      var v;
      if (k <= 24) {
        v = (word() << (bp & 7)) >>> (32 - k);
        bp += k;
        return v;
      }
      v = bits(k - 16) * 65536;
      return v + bits(16);
    }
    function signed(k) {
      var v = bits(k);
      return v >= Math.pow(2, k - 1) ? v - Math.pow(2, k) : v;
    }
    function unary() {
      var q = 0;
      for (;;) {
        var s = bp & 7;
        var x = (word() << s) | 0;
        var c = Math.clz32(~x);
        if (c < 32 - s) { q += c; bp += c + 1; return q; }
        q += 32 - s; bp += 32 - s;
      }
    }
    var out = new Int16Array(frames * ch);
    var a = new Int32Array(block), b = new Int32Array(block);
    function channel(dst, len, width) {
      var t = bits(3);
      var i;
      if (t === 5) {
        var sh = bits(4), m = Math.pow(2, sh);
        channel(dst, len, width - sh);
        for (i = 0; i < len; i++) dst[i] *= m;
        return;
      }
      if (t === 7) { for (i = 0; i < len; i++) dst[i] = signed(width); return; }
      for (i = 0; i < t; i++) dst[i] = signed(width);
      var r = len - t, q = Math.floor(r / 4), extra = r % 4, at = t;
      for (var part = 0; part < 4; part++) {
        var cnt = q + (part < extra ? 1 : 0);
        var k = bits(5), pk = Math.pow(2, k), small = k < 16;
        for (var j = 0; j < cnt; j++, at++) {
          var qq = unary();
          var u = small && qq < 32768 ? ((qq << k) | bits(k)) : qq * pk + bits(k);
          var e = (u & 1) ? -((u + 1) / 2) : u / 2;
          var x;
          if (t === 0) x = e;
          else if (t === 1) x = e + dst[at - 1];
          else if (t === 2) x = e + 2 * dst[at - 1] - dst[at - 2];
          else if (t === 3) x = e + 3 * dst[at - 1] - 3 * dst[at - 2] + dst[at - 3];
          else x = e + 4 * dst[at - 1] - 6 * dst[at - 2] + 4 * dst[at - 3] - dst[at - 4];
          dst[at] = x;
        }
      }
    }
    for (var f0 = 0, blk = first > 0 && first < block ? first : block; f0 < frames; f0 += blk, blk = block) {
      var len = Math.min(blk, frames - f0), i2;
      if (ch === 1) {
        channel(a, len, 16);
        for (i2 = 0; i2 < len; i2++) out[f0 + i2] = a[i2];
        continue;
      }
      var mode = bits(2);
      channel(a, len, 16);
      channel(b, len, mode === 0 ? 16 : 17);
      for (i2 = 0; i2 < len; i2++) {
        var L, R;
        if (mode === 0) { L = a[i2]; R = b[i2]; }
        else if (mode === 1) { L = a[i2]; R = a[i2] + b[i2]; }
        else { R = a[i2]; L = a[i2] - b[i2]; }
        out[(f0 + i2) * 2] = L;
        out[(f0 + i2) * 2 + 1] = R;
      }
    }
    var bytes = new Uint8Array(out.length * 2);
    for (var s2 = 0; s2 < out.length; s2++) { var v2 = out[s2]; bytes[s2 * 2] = v2 & 255; bytes[s2 * 2 + 1] = (v2 >> 8) & 255; }
    return bytes;
  }

  // the stream decoded into one plane per channel, `need` frames long at most: each
  // output is copied straight to its place, and what lies past the share is not copied
  function webcodecs(head, packets, need) {
    return new Promise(function (resolve, reject) {
      var planes = [], frames = 0;
      for (var c0 = 0; c0 < head.ch; c0++) planes.push(new Float32Array(need));
      var dec = new AudioDecoder({
        output: function (d) {
          var take = Math.min(d.numberOfFrames, need - frames);
          for (var c = 0; take > 0 && c < head.ch; c++) {
            d.copyTo(planes[c].subarray(frames, frames + take), { planeIndex: c, frameCount: take, format: 'f32-planar' });
          }
          frames += Math.max(0, take);
          d.close();
        },
        error: function (e) { reject(e); }
      });
      dec.configure({ codec: 'vorbis', sampleRate: head.rate, numberOfChannels: head.ch, description: head.desc });
      for (var i = 0; i < packets.length; i++) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: i * 1000, data: packets[i] }));
      dec.flush().then(function () {
        dec.close();
        resolve(planes.map(function (pl) { return pl.subarray(0, frames); }));
      }, reject);
    });
  }
  var LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  if (u8() !== 82 || u8() !== 87) throw new Error('not a window recipe');
  var version = u8();
  if (version !== 1 && version !== 2) throw new Error('recipe version ' + version);
  var outLen = u32(), nseg = u16();
  var heads = [];
  if (version === 2) {
    for (var hn = u8(), hi = 0; hi < hn; hi++) {
      var hch = u8(), hrate = u32(), hlen = u32();
      heads.push({ ch: hch, rate: hrate, desc: B.slice(p, p + hlen) });
      p += hlen;
    }
  }
  var out = new Uint8Array(outLen), o = 0;
  var jobs = [], finish = [];
  for (var si = 0; si < nseg; si++) {
    var kind = u8();
    if (kind === 0) {
      var len0 = u32();
      out.set(B.subarray(p, p + len0), o); p += len0; o += len0;
      continue;
    }
    if (kind !== 1) throw new Error('recipe segment kind ' + kind);
    var segLen = u32(), key = u32(), skip = u8(), nparts = u16();
    var dw = Math.ceil((skip + segLen) / 4) * 4;
    var plain = new Uint8Array(dw), w = 0;
    for (var pi = 0; pi < nparts; pi++) {
      var pk = u8();
      if (pk === 0) {
        var ln = u32();
        plain.set(B.subarray(p, p + ln), w); p += ln; w += ln;
      } else if (pk === 1 || pk === 2) {
        var chn = u8(), fr = u32(), sk = u32(), tk = u32(), cl = u32();
        var first = pk === 2 ? u16() : 0, block = pk === 2 ? u16() : 4096;
        if (!block || block > 4096) throw new Error('recipe PCM block ' + block);
        var pcm = pcmDecode(B.subarray(p, p + cl), chn, fr, first, block);
        p += cl;
        plain.set(pcm.subarray(sk, sk + tk), w); w += tk;
      } else if (pk === 3 && version === 2) {
        var vch = u8(), vfr = u32(), vsk = u32(), vtk = u32(), lead = u32(), hidx = u8(), npk = u32(), vcl = u32();
        var head = heads[hidx], end = p + vcl, packets = [];
        if (!head || head.ch !== vch) throw new Error('recipe Vorbis head ' + hidx);
        for (var q = 0; q < npk; q++) {
          var plen = 0, sh = 0, by;
          do { by = B[p++]; plen += (by & 127) * Math.pow(2, sh); sh += 7; } while (by & 128);
          packets.push(B.slice(p, p + plen)); p += plen;
        }
        if (p !== end) throw new Error('recipe Vorbis part ends at ' + p + ', not ' + end);
        jobs.push({ head: head, packets: packets, plain: plain, at: w, frames: vfr, lead: lead, skip: vsk, take: vtk });
        w += vtk;
      } else throw new Error('recipe part kind ' + pk);
    }
    if (w !== dw) throw new Error('recipe piece is ' + w + ' plain bytes, not ' + dw);
    finish.push({ plain: plain, dw: dw, key: key, skip: skip, segLen: segLen, at: o });
    o += segLen;
  }
  if (o !== outLen) throw new Error('recipe made ' + o + ' bytes, not ' + outLen);
  // each entry piece permuted and XORed, once its plain bytes are all there
  function seal() {
    for (var fi = 0; fi < finish.length; fi++) {
      var f = finish[fi], pl = f.plain, ky = f.key;
      for (var d = 0; d < f.dw; d += 4) {
        var sel = ky & 15, b0 = pl[d], b1 = pl[d + 1], b2 = pl[d + 2], b3 = pl[d + 3], t0;
        if (sel === 2) { t0 = b0; b0 = b3; b3 = t0; t0 = b1; b1 = b2; b2 = t0; }
        else if (sel === 9) { t0 = b0; b0 = b1; b1 = t0; t0 = b2; b2 = b3; b3 = t0; }
        else if (sel === 13) { t0 = b0; b0 = b2; b2 = t0; t0 = b1; b1 = b3; b3 = t0; }
        pl[d] = b0 ^ (ky & 255);
        pl[d + 1] = b1 ^ ((ky >>> 8) & 255);
        pl[d + 2] = b2 ^ ((ky >>> 16) & 255);
        pl[d + 3] = b3 ^ ((ky >>> 24) & 255);
        ky = (ky ^ (ky << 8)) >>> 0;
        ky = (ky ^ (ky >>> 9)) >>> 0;
        ky = (ky ^ (ky << 23)) >>> 0;
      }
      out.set(pl.subarray(f.skip, f.skip + f.segLen), f.at);
    }
    return out;
  }
  if (!jobs.length) return seal();
  var decode = vorbis || webcodecs;
  return Promise.all(jobs.map(function (j) {
    var need = j.lead + j.frames;
    return Promise.resolve(decode(j.head, j.packets, need)).then(function (planes) {
      // the share's frames, after the context, as 16-bit little-endian samples
      var ch = j.head.ch, n = j.frames, lead = j.lead, have = planes[0] ? planes[0].length : 0;
      if (have < need) throw new Error('Vorbis gave ' + have + ' frames, the share needs ' + need);
      var s16 = new Int16Array(n * ch);
      for (var c = 0; c < ch; c++) {
        var src = planes[c];
        for (var f = 0, k = c; f < n; f++, k += ch) {
          var v = Math.round(src[lead + f] * 32768);
          s16[k] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        }
      }
      var pcm16 = new Uint8Array(s16.buffer);
      if (!LITTLE) {
        pcm16 = new Uint8Array(n * ch * 2);
        for (var q2 = 0; q2 < s16.length; q2++) { pcm16[q2 * 2] = s16[q2] & 255; pcm16[q2 * 2 + 1] = (s16[q2] >> 8) & 255; }
      }
      j.plain.set(pcm16.subarray(j.skip, j.skip + j.take), j.at);
    });
  })).then(seal);
}
