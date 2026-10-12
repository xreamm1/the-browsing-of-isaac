/* host_gl_lazy.c -- a texture reaches the GPU when it is first used (round 97).
 *
 * The engine decodes and uploads nearly every sprite sheet and font page it has
 * at boot, and draws with few of them: at the title 566 of 575 live textures,
 * 235 of 258 MB, had never been bound for a draw; after a minute of play, 614
 * of 633 (239 of 308 MB). Four of the five largest are the CJK font pages
 * (a 4096x4096, 64 MB, never drawn in an English game). On a phone, texture
 * memory is the system's RAM.
 *
 * So a large RGBA upload is not forwarded. Its pixels are kept here, coded
 * small, and the texture gets its storage the first time it is used: bound
 * (glBindTexture), written (glTexSubImage2D), attached to a framebuffer, or
 * found bound at a draw (host_gl_webgl.c decides when; this file keeps the
 * bytes and gives them back exactly).
 *
 * The code: tokens of a u32 header, bit 31 set for a repeat of one value
 * (count in the low 31 bits, the value after it), clear for a literal run
 * (count values after it). A value is a whole pixel, or one byte where every
 * pixel of the texture is premultiplied gray (r == g == b == a: a white glyph
 * page). Measured on the boot's never-drawn textures: 235 MB of RGBA in 45 MB.
 * A texture whose code would be more than half its RGBA is uploaded as before.
 *
 * Plain C (no GL here), so the selftest runs the codec and the table natively.
 * ISAAC_GL_LAZY_TEX=0 turns it off; ISAAC_GL_LAZY_MIN=<bytes> is the smallest
 * texture deferred (64 KB). */
#include "isaac_host.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define LAZY_TEXTURE_2D 0x0DE1u
#define LAZY_RGBA       0x1908u
#define LAZY_UBYTE      0x1401u

typedef struct {
    uint32_t target, level, ifmt, w, h, border, format, type;   /* the deferred glTexImage2D */
    uint32_t len;                                               /* bytes of code */
    uint8_t gray;
    uint8_t *code;
} lazy_tex;

static lazy_tex **g_lazy;
static uint32_t g_lazy_cap;
static int g_lazy_mode = -1;
static uint32_t g_lazy_min;
static uint32_t g_lazy_pending, g_lazy_deferred, g_lazy_materialized, g_lazy_refused;
static uint64_t g_lazy_held, g_lazy_raw_pending, g_lazy_raw_materialized;

int isaac_lazy_tex_enabled(void) {
    if (g_lazy_mode < 0) {
        const char *e = getenv("ISAAC_GL_LAZY_TEX");
        const char *m = getenv("ISAAC_GL_LAZY_MIN");
        g_lazy_mode = (e && *e == '0') ? 0 : 1;
        g_lazy_min = (m && *m) ? (uint32_t)strtoul(m, NULL, 10) : 65536u;
    }
    return g_lazy_mode;
}

/* ---- the code ------------------------------------------------------------ */

static void put32(uint8_t *out, size_t at, uint32_t v) {
    out[at] = (uint8_t)v; out[at + 1] = (uint8_t)(v >> 8); out[at + 2] = (uint8_t)(v >> 16); out[at + 3] = (uint8_t)(v >> 24);
}
static uint32_t get32(const uint8_t *in, size_t at) {
    return (uint32_t)in[at] | ((uint32_t)in[at + 1] << 8) | ((uint32_t)in[at + 2] << 16) | ((uint32_t)in[at + 3] << 24);
}
static uint32_t pixel(const uint8_t *px, uint32_t i) { return get32(px, (size_t)i * 4u); }

/* 1 if every pixel is r == g == b == a */
int isaac_lazy_gray(const uint8_t *px, uint32_t npix) {
    for (uint32_t i = 0; i < npix; ++i) {
        const uint8_t *p = px + (size_t)i * 4u;
        if (p[0] != p[3] || p[1] != p[3] || p[2] != p[3]) return 0;
    }
    return 1;
}

/* The code of npix RGBA pixels into out (NULL: only its length). */
size_t isaac_lazy_encode(const uint8_t *px, uint32_t npix, int gray, uint8_t *out) {
    const uint32_t minrun = gray ? 8u : 3u, size = gray ? 1u : 4u;
    size_t o = 0;
    uint32_t i = 0, lit = 0, litlen = 0;
#define FLUSH() do { if (litlen) { \
        if (out) { put32(out, o, litlen); \
                   for (uint32_t k = 0; k < litlen; ++k) { \
                       if (gray) out[o + 4 + k] = px[(size_t)(lit + k) * 4u + 3u]; \
                       else memcpy(out + o + 4 + (size_t)k * 4u, px + (size_t)(lit + k) * 4u, 4); } } \
        o += 4 + (size_t)litlen * size; litlen = 0; } } while (0)
    while (i < npix) {
        uint32_t v = pixel(px, i), r = 1;
        while (i + r < npix && r < 0x7fffffffu && pixel(px, i + r) == v) ++r;
        if (r >= minrun) {
            FLUSH();
            if (out) {
                put32(out, o, 0x80000000u | r);
                if (gray) out[o + 4] = (uint8_t)(v >> 24); else put32(out, o + 4, v);
            }
            o += 4 + size;
            i += r;
            lit = i;
        } else {
            if (!litlen) lit = i;
            litlen += r;
            i += r;
            if (litlen >= 0x7fff0000u) FLUSH();
        }
    }
    FLUSH();
#undef FLUSH
    return o;
}

/* The pixels back. 0 if the code does not describe exactly npix pixels. */
int isaac_lazy_decode(const uint8_t *code, size_t len, int gray, uint8_t *px, uint32_t npix) {
    const uint32_t size = gray ? 1u : 4u;
    size_t p = 0;
    uint32_t i = 0;
    while (p < len) {
        if (len - p < 4) return 0;
        uint32_t h = get32(code, p), n = h & 0x7fffffffu;
        p += 4;
        if (!n || n > npix - i) return 0;
        if (h & 0x80000000u) {
            if (len - p < size) return 0;
            uint32_t v = gray ? 0x01010101u * code[p] : get32(code, p);
            p += size;
            for (uint32_t k = 0; k < n; ++k) put32(px, (size_t)(i + k) * 4u, v);
        } else {
            if ((len - p) / size < n) return 0;
            if (gray) for (uint32_t k = 0; k < n; ++k) memset(px + (size_t)(i + k) * 4u, code[p + k], 4);
            else memcpy(px + (size_t)i * 4u, code + p, (size_t)n * 4u);
            p += (size_t)n * size;
        }
        i += n;
    }
    return i == npix;
}

/* ---- the table ----------------------------------------------------------- */

static lazy_tex *lazy_get(uint32_t name) { return name < g_lazy_cap ? g_lazy[name] : NULL; }

int isaac_lazy_tex_pending(uint32_t name) { return lazy_get(name) != NULL; }

void isaac_lazy_tex_drop(uint32_t name) {
    lazy_tex *t = lazy_get(name);
    if (!t) return;
    g_lazy[name] = NULL;
    --g_lazy_pending;
    g_lazy_held -= t->len;
    g_lazy_raw_pending -= (uint64_t)t->w * t->h * 4u;
    free(t->code);
    free(t);
}

/* Keep the upload instead of making it: 1 if kept (the caller forwards nothing). */
int isaac_lazy_tex_defer(uint32_t name, uint32_t target, uint32_t level, uint32_t ifmt, uint32_t w, uint32_t h,
                         uint32_t border, uint32_t format, uint32_t type, const uint8_t *px) {
    if (!isaac_lazy_tex_enabled() || !name || !px || target != LAZY_TEXTURE_2D || level || border ||
        format != LAZY_RGBA || type != LAZY_UBYTE || !w || !h || (uint64_t)w * h > 0x10000000u)
        return 0;
    uint32_t npix = w * h;
    uint64_t raw = (uint64_t)npix * 4u;
    if (raw < g_lazy_min) return 0;
    int gray = isaac_lazy_gray(px, npix);
    size_t len = isaac_lazy_encode(px, npix, gray, NULL);
    if ((uint64_t)len * 2u > raw) { ++g_lazy_refused; return 0; }
    if (name >= g_lazy_cap) {
        uint32_t cap = g_lazy_cap ? g_lazy_cap : 1024u;
        while (cap <= name) cap *= 2u;
        lazy_tex **grown = (lazy_tex **)realloc(g_lazy, (size_t)cap * sizeof *grown);
        if (!grown) return 0;
        memset(grown + g_lazy_cap, 0, (size_t)(cap - g_lazy_cap) * sizeof *grown);
        g_lazy = grown; g_lazy_cap = cap;
    }
    lazy_tex *t = (lazy_tex *)calloc(1, sizeof *t);
    uint8_t *code = (uint8_t *)malloc(len ? len : 1);
    if (!t || !code) { free(t); free(code); return 0; }
    isaac_lazy_encode(px, npix, gray, code);
    isaac_lazy_tex_drop(name);
    t->target = target; t->level = level; t->ifmt = ifmt; t->w = w; t->h = h;
    t->border = border; t->format = format; t->type = type;
    t->len = (uint32_t)len; t->gray = (uint8_t)gray; t->code = code;
    g_lazy[name] = t;
    ++g_lazy_pending; ++g_lazy_deferred;
    g_lazy_held += len; g_lazy_raw_pending += raw;
    if (g_lazy_deferred == 1)
        isaac_log("[isaac][gl] textures reach the GPU when first used (%u bytes and up; ISAAC_GL_LAZY_TEX=0 uploads at once)", g_lazy_min);
    return 1;
}

/* Give a kept texture its pixels: the upload is made through `up` (the texture
 * must be bound where `up` uploads), then the copy is freed. 1 if it was kept. */
int isaac_lazy_tex_materialize(uint32_t name, isaac_lazy_upload_fn up) {
    lazy_tex *t = lazy_get(name);
    if (!t) return 0;
    uint32_t npix = t->w * t->h;
    uint8_t *px = (uint8_t *)malloc((size_t)npix * 4u);
    if (!px) {
        isaac_log("[isaac][gl] texture %u (%ux%u): no memory to give it its pixels; it stays empty", name, t->w, t->h);
        isaac_lazy_tex_drop(name);
        return 1;
    }
    if (!isaac_lazy_decode(t->code, t->len, t->gray, px, npix))
        isaac_log("[isaac][gl] texture %u (%ux%u): its kept pixels do not decode", name, t->w, t->h);
    up(t->target, t->level, t->ifmt, t->w, t->h, t->border, t->format, t->type, px);
    free(px);
    ++g_lazy_materialized;
    g_lazy_raw_materialized += (uint64_t)npix * 4u;
    isaac_lazy_tex_drop(name);
    return 1;
}

void isaac_lazy_tex_stats(uint32_t *pending, uint32_t *deferred, uint32_t *materialized, uint32_t *refused,
                          uint64_t *held, uint64_t *raw_pending) {
    if (pending) *pending = g_lazy_pending;
    if (deferred) *deferred = g_lazy_deferred;
    if (materialized) *materialized = g_lazy_materialized;
    if (refused) *refused = g_lazy_refused;
    if (held) *held = g_lazy_held;
    if (raw_pending) *raw_pending = g_lazy_raw_pending;
}

void isaac_lazy_tex_report(void) {
    if (!g_lazy_deferred) return;
    isaac_log("[isaac][gl] lazy textures: %u kept, %u given their pixels on first use (%.1f MB), %u still kept: "
              "%.1f MB of RGBA held in %.1f MB; %u uploaded at once (code over half)",
              g_lazy_deferred, g_lazy_materialized, g_lazy_raw_materialized / 1048576.0, g_lazy_pending,
              g_lazy_raw_pending / 1048576.0, g_lazy_held / 1048576.0, g_lazy_refused);
}
