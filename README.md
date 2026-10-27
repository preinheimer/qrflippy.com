# QR Flippy

A QR code generator that animates the change from one code to the next. As you type, the squares (modules) don't just swap to the new code. Blocks slide to their new positions, split off neighbors or merge into them. A block only fades when nothing nearby can move.

It's plain HTML and vanilla JavaScript with no dependencies and no build step.

## Running it

Open `index.html` in a browser, or serve the folder with any static server:

```sh
python3 -m http.server
```

## Files

| File | What it does |
|---|---|
| `index.html` | The page: text box, canvas, a config sidebar (left) and a stats sidebar (right). Styles are inline. |
| `qr.js` | A small QR encoder. Exposes `QR.encode(text, ecl)` and returns `{ size, version, mask, modules }`, where `modules` is a 2D array of booleans. |
| `app.js` | Renders and animates the code on a `<canvas>`, wires up the config controls and tracks the stats. |

## The encoder (`qr.js`)

It implements ISO/IEC 18004 in byte mode, for versions 1–40 and all four error-correction levels (L, M, Q, H). Text is encoded as UTF-8. Its structure follows [Project Nayuki's reference QR encoder](https://www.nayuki.io/page/qr-code-generator-library):

1. Pick the smallest version that fits the data.
2. Build the bit stream: mode, character count, data, terminator, then `0xEC`/`0x11` padding.
3. Split it into blocks, add Reed–Solomon error correction over GF(2⁸), and interleave.
4. Draw the function patterns (finders, timing, alignment, format and version info), then place the data in the standard zigzag.
5. Try all 8 masks and keep the one with the lowest penalty score.

Its output was checked bit for bit against the Python `qrcode` library at hundreds of lengths across every version and EC level, and decoded with OpenCV.

## The animation (`app.js`)

### Pieces

Every dark square on screen is a **piece** with:

- a floating position (`x`, `y`, in module units), so it can sit between squares while it moves
- a destination square (`r`, `c`)
- a presence value `q`, from 0 (gone) to 1 (fully drawn), used for fades and grows

Rendering is a `requestAnimationFrame` loop that draws each piece as a filled rectangle. The loop only runs while something is moving. Rectangle edges are snapped to whole device pixels, so adjacent dark squares never show seams.

### What happens when the text changes

`update()` re-encodes the text and reconciles the pieces against the new code:

1. **Keep:** pieces already on, or heading to, a square that is dark in the new code carry on.
2. **Move:** every other piece is *free*. Free pieces are paired with the empty squares that need filling, nearest pairs first, within the max distance. Each paired piece travels to its square along an L-shaped path (or a straight line).
3. **Merge:** a free piece left without a pair slides into the nearest square that stays dark and disappears into it.
4. **Split:** an empty square left without a piece gets a copy that slides out of the nearest block that stays dark.
5. **Fallback:** only when nothing is in range does a piece fade or grow, in or out.

A piece that is still moving when the text changes again is simply re-paired from wherever it is. Edits typed mid-animation therefore redirect blocks smoothly instead of jumping.

### Timing

- **Cascade:** start times are staggered by distance from an origin (any corner, or the center). The change sweeps across the code instead of happening all at once. A small random jitter keeps the sweep from looking mechanical.
- **Travel time:** a slide takes the base cell duration, plus a fixed amount for each extra square it covers.
- **Version changes:** when the code changes size (say 25×25 → 29×29), the whole grid rescales smoothly while the pieces move.
- **Reduced motion:** when the system's `prefers-reduced-motion` setting is on, updates are instant.

## Controls

**Movement:** turn moves on or off, set the max distance and the time per extra square, and choose the path shape. Splitting and merging have their own toggles. With *strict split source* on, copies only split off blocks that are fully dark now and stay dark.

**Timing:** cell duration, easing curve, and the fallback effect (fade, grow or mixed) for when nothing can slide.

**Cascade:** origin, sweep length and jitter.

**QR code:** error-correction level, quiet-zone width, and the dark and light colors.

## Stats

The right sidebar shows, for the last change and for the session:

- how many blocks changed state (to dark and to light)
- **sliding moves:** blocks moved, split off and merged, plus total squares covered and the longest slide
- **other moves:** fades and grows
- how many in-flight blocks were redirected by a new edit
- how many blocks are in motion right now

## Known limitations

- Large version jumps, such as typing a long paragraph at once, still fade most blocks in. The new area is mostly farther than the max distance from any existing block. Raising the max distance helps.
- Pairing is greedy (nearest pairs first) rather than an optimal assignment. It's fast and looks good, but paths sometimes cross.
- The code isn't scannable during an animation, only once it settles.

## License

Public domain. See [LICENSE](LICENSE).
