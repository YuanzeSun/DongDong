(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ART = `<svg xmlns="${SVG_NS}" viewBox="0 0 256 256" shape-rendering="crispEdges" aria-hidden="true">
    <g transform="scale(4)">
    <g id="cat-stand">
      <g id="cat-tail"><path id="cat-tail-line" fill="#3b2b2b"/><path id="cat-tail-color" fill="#df873a"/><path id="cat-tail-stripe" fill="#b95c32"/></g>
      <g id="cat-rear-left"><path fill="#3b2b2b" d="M18 49h10v11H17v-3h1z"/><path fill="#e49342" d="M20 49h7v8h-7z"/><path fill="#f2aa59" d="M19 55h8v3h-8z"/></g>
      <g id="cat-rear-right"><path fill="#3b2b2b" d="M37 49h10v11H36v-3h1z"/><path fill="#e49342" d="M38 49h7v8h-7z"/><path fill="#f2aa59" d="M37 55h8v3h-8z"/></g>
      <g id="cat-body"><path fill="#3b2b2b" d="M17 37h33v18H14V42h3z"/><path fill="#e49342" d="M20 39h27v13H18V43h2z"/><path fill="#f7c77b" d="M27 40h12v12H27z"/><path fill="#b95c32" d="M43 42h4v7h-4z"/><path fill="#4f9e88" d="M22 38h24v4H22z"/><path fill="#9ad0a5" d="M29 39h10v2H29z"/></g>
      <g id="cat-head"><path fill="#3b2b2b" d="M13 22V7h4V3h4l8 9h8l8-9h4v4h4v15h3v18H10V22z"/><path fill="#e49342" d="M16 21V10h3l7 8h10l8-8h3v11h4v15H13V21z"/><path fill="#f2a261" d="M18 11v7h6zM47 11v7h-6z"/><path fill="#b95c32" d="M27 16h3v7h-3zM32 15h3v8h-3zM37 16h3v7h-3z"/><path fill="#f7c77b" d="M18 28h29v9H18z"/>
        <g id="cat-eye-open"><path fill="#2d2530" d="M19 25h6v5h-6zM39 25h6v5h-6z"/><path fill="#fff1ca" d="M20 26h2v2h-2zM40 26h2v2h-2z"/></g>
        <g id="cat-eye-closed" display="none"><path fill="#3b2b2b" d="M18 27h8v2h-8zM38 27h8v2h-8z"/></g>
        <g id="cat-eye-happy" display="none"><path fill="#3b2b2b" d="M19 28h2v-2h2v2h2v2h-6zM39 28h2v-2h2v2h2v2h-6z"/></g>
        <path fill="#a9524b" d="M30 30h4v3h-4z"/>
        <g id="cat-mouth-smile"><path fill="#3b2b2b" d="M31 33h2v3h-2zM27 35h4v2h-4zM33 35h4v2h-4z"/></g>
        <g id="cat-mouth-open" display="none"><path fill="#3b2b2b" d="M28 34h9v5h-2v2h-5v-2h-2z"/><path fill="#e2827c" d="M31 37h4v2h-4z"/></g>
        <g id="cat-mouth-tongue" display="none"><path fill="#3b2b2b" d="M28 35h9v3h-9z"/><path fill="#e2827c" d="M31 37h5v5h-5z"/></g>
        <path fill="#3b2b2b" d="M12 30h6v1h-6zM12 34h7v1h-7zM46 30h6v1h-6zM45 34h7v1h-7z"/>
      </g>
      <g id="cat-paw-left"><path fill="#3b2b2b" d="M15 40h10v18H14V45h1z"/><path fill="#e49342" d="M17 42h7v13h-7z"/><path fill="#f2aa59" d="M16 53h9v4h-9z"/></g>
      <g id="cat-paw-right"><path fill="#3b2b2b" d="M39 40h11v18H38V45h1z"/><path fill="#e49342" d="M40 42h8v13h-8z"/><path fill="#f2aa59" d="M39 53h10v4H39z"/></g>
    </g>
    <g id="cat-loaf" display="none">
      <g id="cat-loaf-tail"><path fill="#3b2b2b" d="M46 44h7v-5h6v3h4v14h-4v4H47v-4h-4z"/><path fill="#df873a" d="M49 45h6v-4h4v12h-3v4h-7z"/><path fill="#b95c32" d="M56 44h3v7h-3z"/></g>
      <g id="cat-loaf-body"><path fill="#3b2b2b" d="M15 36h32v3h5v5h4v12h-4v4H10v-4H7V46h4v-6h4z"/><path fill="#e49342" d="M17 39h29v3h5v5h2v8h-3v2H13v-2h-3v-8h4v-5h3z"/><path fill="#f7c77b" d="M19 47h28v9H19z"/><path fill="#b95c32" d="M44 41h4v8h-4z"/><path fill="#f2aa59" d="M14 55h12v3H14zM37 55h13v3H37z"/></g>
      <g id="cat-loaf-head"><path fill="#3b2b2b" d="M13 28V14h4V8h4l8 9h7l8-9h4v6h4v14h3v14H10V28z"/><path fill="#e49342" d="M16 27V16h3l7 8h10l8-8h3v11h4v12H13V27z"/><path fill="#f2a261" d="M18 17v7h6zM47 17v7h-6z"/><path fill="#b95c32" d="M27 22h3v7h-3zM32 21h3v8h-3zM37 22h3v7h-3z"/><path fill="#f7c77b" d="M18 34h29v6H18z"/>
        <g id="cat-loaf-eye-open"><path fill="#2d2530" d="M19 30h6v5h-6zM39 30h6v5h-6z"/><path fill="#fff1ca" d="M20 31h2v2h-2zM40 31h2v2h-2z"/></g>
        <g id="cat-loaf-eye-closed" display="none"><path fill="#3b2b2b" d="M18 33h8v2h-8zM38 33h8v2h-8z"/></g>
        <g id="cat-loaf-eye-happy" display="none"><path fill="#3b2b2b" d="M19 33h2v-2h2v2h2v2h-6zM39 33h2v-2h2v2h2v2h-6z"/></g>
        <path fill="#a9524b" d="M30 35h4v3h-4z"/><path fill="#3b2b2b" d="M30 38h4v2h-4zM12 35h6v1h-6zM46 35h6v1h-6z"/>
      </g>
    </g>
    <g id="cat-bed-back" display="none"><path fill="#3b2b2b" d="M8 42h5v-4h38v4h5v4h4v15H4V46h4z"/><path fill="#599b8e" d="M9 44h5v-4h36v4h5v4h2v10H7V48h2z"/><path fill="#b8d6a0" d="M15 46h34v9H15z"/></g>
    <g id="cat-sleep" display="none">
      <g id="cat-sleep-body"><path fill="#3b2b2b" d="M40 39h9v-5h8v3h4v12h-4v6H43v-4h-7zM20 30h28v5h6v17H48v5H21v-3h-8V39h4v-5h3z"/><path fill="#df873a" d="M43 41h6v-4h5v3h3v7h-3v4h-9v-4h-5v-4h3z"/><path fill="#e49342" d="M22 33h25v5h4v11h-5v4H23v-3h-6V40h4v-4h1z"/><path fill="#b95c32" d="M43 38h4v9h-4zM37 38h3v7h-3z"/><path fill="#f2aa59" d="M22 48h8v5h-8zM38 48h8v5h-8z"/></g>
      <g id="cat-sleep-head"><path fill="#3b2b2b" d="M10 39V23h4v-8h5l7 7h4l7-7h5v8h4v16z"/><path fill="#e49342" d="M13 36V25h4v-5h2l6 6h6l6-6h2v5h4v11z"/><path fill="#f2a261" d="M17 21v5h5zM37 21v5h-5z"/><path fill="#b95c32" d="M25 25h3v6h-3zM30 25h3v6h-3z"/><path fill="#2d2530" d="M17 31h7v2h-7zM33 31h7v2h-7z"/><path fill="#f7c77b" d="M19 34h20v5H19z"/><path fill="#a9524b" d="M27 35h4v3h-4z"/><path fill="#3b2b2b" d="M11 34h8v1h-8zM11 37h8v1h-8zM39 34h8v1h-8zM39 37h8v1h-8z"/></g>
    </g>
    <g id="cat-bed-front" display="none"><path fill="#3b2b2b" d="M4 45h7v10h42V45h7v15h-3v4H7v-4H4z"/><path fill="#73ad9b" d="M7 47h3v10h44V47h3v11h-3v3H10v-3H7z"/><path fill="#a4cab1" d="M13 58h38v2H13z"/></g>
    <g id="cat-props">
      <g id="cat-prop-fish" display="none"><path fill="#314e60" d="M0 3h9l5-3v5l-5 3H0l-3-3z"/><path fill="#77bed1" d="M0 3h9l4-2v3l-4 3H0l-2-2z"/><path fill="#283844" d="M2 4h2v2H2z"/></g>
      <g id="cat-prop-heart" display="none"><path fill="#9f4f56" d="M-7-1h3v-3h5v3h3v-3h5v3h3v5h-3v3H6v3H3v3h-4v-3h-3V7h-3V4h-3v-5h3z"/><path fill="#ed8192" d="M-6 0h3v-3h3v3h4v-3h4v3h2v4H7v3H4v3H0V7h-3V4h-3z"/></g>
      <g id="cat-prop-yarn" display="none"><path fill="#3b2b2b" d="M0 1h9v2h3v9h-3v3H0v-2h-3V4h3z"/><path fill="#a66caa" d="M0 3h9v2h2v6H8v2H1v-2h-2V5h1z"/><path fill="none" stroke="#e5b3df" stroke-width="1.5" d="M1 5l7 6M8 4L0 11"/></g>
      <g id="cat-prop-envelope" display="none"><path fill="#a65b49" d="M-8-5h16v11H-8z"/><path fill="#fff0d1" d="M-6-3H6v7H-6z"/><path fill="none" stroke="#cf8665" stroke-width="1" d="M-6-3 0 1 6-3"/></g>
      <g id="cat-prop-spark" display="none"><path fill="#e9bd57" d="M-1-7h3v6h6v3H2v6h-3V2h-6v-3h6z"/></g>
      <g id="cat-prop-z" display="none"><path fill="#738baa" d="M0 0h9v2H7v2H5v2H3v2h6v2H0V7h2V5h2V3h2V2H0z"/></g>
      <g id="cat-prop-hand" display="none"><path fill="#5b3c32" d="M-9-5h4v-4h4v5h3v-7h4v8h3v-5h4v12h-3v5H-5V6h-4z"/><path fill="#f1c7a7" d="M-7-3h4v-4h2v6h5v-8h2V0h5v-6h2V3H8v4H-3V4h-4z"/></g>
    </g>
    </g>
  </svg>`;

  const DEFAULT = { bx: 0, by: 0, hx: 0, hy: 0, lx: 0, ly: 0, rx: 0, ry: 0, rlx: 0, rly: 0, rrx: 0, rry: 0, tx: 0, ty: 0, sy: 0, px: 0, py: 0, ps: 1, tail: 0, eye: 'open', mouth: 'smile', prop: '' };
  const K = (t, values = {}) => ({ t, ...values });
  const ACTIONS = {
    idle: { frames: 24, ms: 2400, loop: true, keys: [K(0), K(.2, { by: 1, hy: 1, tail: 1 }), K(.45, { by: 0, hy: 0, tail: 2 }), K(.7, { by: 1, hy: 1, tail: 1, eye: 'closed' }), K(.78, { eye: 'open' }), K(1)] },
    'loaf-enter': { frames: 16, ms: 760, keys: [K(0), K(.35, { by: 3, hy: 3, ly: 2, ry: 2, tail: 3 }), K(.6, { by: 5, hy: 5, ly: 3, ry: 3, eye: 'closed' }), K(.8, { eye: 'open', sy: 1 }), K(1, { sy: 0 })] },
    loaf: { frames: 30, ms: 4200, loop: true, keys: [K(0, { eye: 'open', tail: 3 }), K(.25, { sy: 1, hy: .5, eye: 'closed' }), K(.45, { sy: 0, hy: 0, eye: 'open' }), K(.7, { sy: 1, hy: .5 }), K(1, { sy: 0, hy: 0 })] },
    'loaf-rise': { frames: 16, ms: 700, keys: [K(0, { eye: 'closed', tail: 3 }), K(.4, { hy: -2, sy: -1, eye: 'open' }), K(.6, { by: 5, hy: 5, ly: 3, ry: 3 }), K(.82, { by: 2, hy: 2 }), K(1)] },
    'nest-enter': { frames: 18, ms: 840, keys: [K(0), K(.35, { by: 3, hy: 3, ly: 2, ry: 2, eye: 'closed' }), K(.6, { by: 5, hy: 5, ly: 3, ry: 3 }), K(.82, { sy: 1 }), K(1, { sy: 0 })] },
    nest: { frames: 30, ms: 4800, loop: true, keys: [K(0), K(.25, { sy: 1 }), K(.5, { sy: 0 }), K(.75, { sy: 1 }), K(1)] },
    'nest-rise': { frames: 16, ms: 700, keys: [K(0, { eye: 'closed' }), K(.3, { sy: -2 }), K(.55, { sy: -3 }), K(.72, { by: 3, hy: 3, eye: 'open' }), K(1)] },
    sleep: { frames: 24, ms: 2400, loop: true, keys: [K(0, { sy: 0, prop: 'z', px: 49, py: 17 }), K(.25, { sy: 1, py: 13 }), K(.5, { sy: 0, py: 9 }), K(.75, { sy: 1, py: 13 }), K(1, { sy: 0, py: 17 })] },
    wake: { frames: 12, ms: 600, keys: [K(0, { sy: 0, prop: 'z', px: 49, py: 17 }), K(.25, { sy: -2, prop: '' }), K(.5, { sy: -4 }), K(.68, { sy: -3, eye: 'closed', hy: 5, by: 3 }), K(.82, { hy: 2, by: 1 }), K(1)] },
    blink: { frames: 8, ms: 520, keys: [K(0), K(.3, { eye: 'closed', hy: 1 }), K(.55, { eye: 'closed' }), K(.8), K(1)] },
    wave: { frames: 24, ms: 1800, keys: [K(0), K(.12, { lx: -2, ly: -5, hx: 1, tail: 1 }), K(.28, { lx: -3, ly: -15, hx: 2, tail: 2 }), K(.4, { lx: 0, ly: -12, hx: -1, eye: 'happy' }), K(.52, { lx: -4, ly: -17, hx: 2 }), K(.64, { lx: 0, ly: -12, hx: -1 }), K(.75, { lx: -4, ly: -16, hx: 2, eye: 'happy' }), K(.9, { lx: -1, ly: -4, hx: 0 }), K(1)] },
    happy: { frames: 24, ms: 1700, keys: [K(0), K(.14, { by: 3, hy: 3, eye: 'happy', mouth: 'open' }), K(.3, { by: -5, hy: -5, ly: -6, ry: -6, tail: 2, prop: 'spark', px: 52, py: 15 }), K(.48, { by: 2, hy: 2, prop: '' }), K(.63, { by: -4, hy: -4, ly: -4, ry: -4, tail: 1, prop: 'spark', px: 11, py: 18 }), K(.82, { by: 1, hy: 1, prop: '' }), K(1)] },
    jump: { frames: 24, ms: 1720, keys: [K(0), K(.12, { by: 4, hy: 5, ly: 3, ry: 3, tail: 3 }), K(.25, { by: -5, hy: -7, lx: -5, ly: -12, rx: 5, ry: -12, rly: -5, rry: -5, tail: 2, eye: 'open', mouth: 'open' }), K(.42, { by: -9, hy: -10, lx: -7, ly: -15, rx: 7, ry: -15, tail: 1, prop: 'spark', px: 52, py: 49 }), K(.58, { by: -8, hy: -9, lx: -4, ly: -12, rx: 4, ry: -12, prop: '' }), K(.75, { by: -3, hy: -4, lx: -2, ly: -6, rx: 2, ry: -6, tail: 2 }), K(.86, { by: 4, hy: 4, ly: 3, ry: 3, tail: 3, prop: 'spark', px: 12, py: 54 }), K(1)] },
    walk: { frames: 12, ms: 950, loop: true, keys: [K(0, { lx: -3, ly: -2, rx: 3, ry: 1, rlx: 2, rrx: -2, tail: 1 }), K(.25, { by: -2, hy: -2, lx: 0, rx: 0, rlx: 0, rrx: 0, tail: 2 }), K(.5, { lx: 3, ly: 1, rx: -3, ry: -2, rlx: -2, rrx: 2, tail: 3 }), K(.75, { by: -2, hy: -2, lx: 0, rx: 0, rlx: 0, rrx: 0, tail: 2 }), K(1, { lx: -3, ly: -2, rx: 3, ry: 1, rlx: 2, rrx: -2, tail: 1 })] },
    sit: { frames: 22, ms: 1750, keys: [K(0), K(.2, { by: 2, hy: 1, rly: 2, rry: 2, tail: 2 }), K(.42, { by: 5, hy: 2, rly: 4, rry: 4, ly: 2, ry: 2, tail: 3 }), K(.7, { by: 5, hy: 2, rly: 4, rry: 4, eye: 'closed' }), K(.86, { eye: 'open' }), K(1, { by: 4, hy: 2, rly: 3, rry: 3, ly: 1, ry: 1, tail: 3 })] },
    stretch: { frames: 26, ms: 1900, keys: [K(0), K(.18, { hy: 2, hx: -2, lx: -3, ly: 1, rx: 2, ry: 1, tail: 1 }), K(.36, { hx: -6, hy: 6, bx: 3, by: -3, lx: -10, ly: 5, rx: -5, ry: 5, tail: 2, eye: 'closed' }), K(.55, { hx: -8, hy: 7, bx: 5, by: -4, lx: -12, ly: 5, rx: -7, ry: 5, mouth: 'open', tail: 3 }), K(.75, { hx: -5, hy: 4, bx: 2, by: -2, lx: -8, ly: 3, rx: -4, ry: 3 }), K(.9, { hx: -2, hy: 1, bx: 1, by: 0, lx: -3, ly: 1, rx: -1, ry: 1 }), K(1)] },
    pet: { frames: 24, ms: 1850, keys: [K(0, { prop: 'hand', px: 32, py: -10 }), K(.18, { prop: 'hand', px: 32, py: 7, eye: 'closed' }), K(.35, { prop: 'hand', px: 29, py: 10, hx: -3, hy: 2, tail: 1, eye: 'happy' }), K(.52, { prop: 'hand', px: 36, py: 10, hx: 3, hy: 1, tail: 2 }), K(.68, { prop: 'hand', px: 30, py: 10, hx: -2, hy: 2, tail: 1 }), K(.82, { prop: 'heart', px: 50, py: 16, hx: 0, hy: 0, eye: 'happy' }), K(1, { prop: '', eye: 'open' })] },
    fish: { frames: 26, ms: 1950, keys: [K(0, { prop: 'fish', px: 56, py: 50 }), K(.16, { hx: 3, hy: 2, rx: 3, ry: -2, px: 52, py: 47, tail: 1 }), K(.34, { hx: 4, hy: 3, rx: 3, ry: -11, px: 43, py: 39, eye: 'open' }), K(.49, { hx: 1, hy: 1, rx: 0, ry: -9, px: 36, py: 33, mouth: 'open' }), K(.62, { prop: '', mouth: 'open', hy: 2, eye: 'closed' }), K(.72, { hy: 0, mouth: 'smile', eye: 'happy' }), K(.82, { hy: 2, mouth: 'open' }), K(1, { eye: 'happy' })] },
    groom: { frames: 26, ms: 1950, keys: [K(0), K(.17, { lx: 3, ly: -8, hx: -2, hy: 2, eye: 'closed', mouth: 'tongue' }), K(.31, { lx: 6, ly: -12, hx: -3, mouth: 'tongue' }), K(.44, { lx: 5, ly: -13, hx: 1, hy: -1, mouth: 'smile' }), K(.56, { lx: 1, ly: -8, hx: -2, hy: 2, mouth: 'tongue' }), K(.68, { lx: 6, ly: -12, hx: 2, hy: -1, mouth: 'smile' }), K(.82, { lx: 2, ly: -5, eye: 'happy' }), K(1)] },
    hug: { frames: 24, ms: 1850, keys: [K(0), K(.18, { lx: -8, ly: -5, rx: 8, ry: -5, eye: 'happy' }), K(.38, { lx: -6, ly: -10, rx: 6, ry: -10, hx: 0, hy: 2, prop: 'heart', px: 32, py: 49 }), K(.58, { lx: 4, ly: -7, rx: -4, ry: -7, by: 2, prop: 'heart', px: 32, py: 46 }), K(.76, { lx: 4, ly: -7, rx: -4, ry: -7, by: 1, prop: 'heart', px: 32, py: 42 }), K(.9, { lx: -2, ly: -4, rx: 2, ry: -4, prop: 'heart', px: 32, py: 31 }), K(1, { prop: '' })] },
    kiss: { frames: 22, ms: 1700, keys: [K(0), K(.2, { hx: 2, hy: 1, eye: 'closed', mouth: 'open', tail: 1 }), K(.38, { hx: 5, hy: -1, rx: 2, ry: -5, prop: 'heart', px: 45, py: 31 }), K(.55, { hx: 3, hy: 0, prop: 'heart', px: 53, py: 22 }), K(.76, { hx: 1, hy: 0, prop: 'heart', px: 60, py: 13, eye: 'happy' }), K(.9, { prop: '', mouth: 'smile' }), K(1)] },
    purr: { frames: 30, ms: 2300, loop: true, keys: [K(0, { eye: 'closed', tail: 3 }), K(.25, { sy: 1, hy: .5, tx: 1 }), K(.5, { sy: 0, hy: 0, tx: 0 }), K(.75, { sy: 1, hy: .5, tx: 1 }), K(1, { sy: 0, hy: 0, tx: 0 })] },
    delivery: { frames: 24, ms: 1850, keys: [K(0, { prop: 'envelope', px: 32, py: 47 }), K(.2, { lx: -3, ly: -3, rx: 3, ry: -3, bx: -3, hx: -3, px: 29, py: 45 }), K(.42, { bx: 3, hx: 3, px: 35, py: 44, tail: 2 }), K(.62, { bx: -2, hx: -2, px: 30, py: 43, tail: 1 }), K(.82, { bx: 5, hx: 5, px: 39, py: 43, tail: 2 }), K(1, { bx: 6, hx: 6, prop: '' })] },
    receive: { frames: 22, ms: 1700, keys: [K(0, { prop: 'envelope', px: 60, py: 43 }), K(.22, { hx: 3, rx: 5, ry: -5, px: 50, py: 43 }), K(.42, { hx: 5, rx: 4, ry: -9, px: 41, py: 43 }), K(.62, { hx: 1, rx: 0, ry: -5, px: 33, py: 44, eye: 'happy' }), K(.82, { px: 32, py: 46, eye: 'happy' }), K(1, { prop: '' })] }
  };

  const TAILS = [
    ['M45 47h7v-4h7v3h3v12h-4v4h-8v-4h-5z', 'M48 49h6v-3h3v3h2v7h-3v3h-5v-4h-3z', 'M54 47h3v5h-3zM57 54h3v3h-3z'],
    ['M46 49h6v-6h4v-8h6v-5h2v21h-5v4h-8v-3h-5z', 'M49 48h5v-5h4v-8h3v14h-4v4h-7z', 'M59 38h3v5h-3zM56 47h3v4h-3z'],
    ['M45 47h7v-3h5v-6h6v-4h2v18h-4v4h-8v-3h-8z', 'M48 49h7v-4h4v-6h3v12h-4v3H48z', 'M60 41h3v5h-3zM55 48h3v4h-3z'],
    ['M45 51h7v4h5v-3h4v-8h3v16h-5v4H48v-5h-3z', 'M48 53h5v4h5v-3h3v5h-4v3h-8v-5h-1z', 'M54 58h3v4h-3z']
  ];

  const NUMERIC = Object.keys(DEFAULT).filter(key => typeof DEFAULT[key] === 'number' && key !== 'tail');
  const DISCRETE = ['tail', 'eye', 'mouth', 'prop'];
  const RESOLVED_KEYS = Object.fromEntries(Object.entries(ACTIONS).map(([name, spec]) => {
    let current = DEFAULT;
    return [name, spec.keys.map(key => (current = { ...current, ...key }))];
  }));
  function sample(action, frame) {
    const spec = ACTIONS[action] || ACTIONS.idle;
    const count = spec.frames;
    const index = spec.loop ? ((frame % count) + count) % count : Math.max(0, Math.min(count - 1, frame));
    const time = index / (count - 1);
    const keys = RESOLVED_KEYS[action] || RESOLVED_KEYS.idle;
    let nextIndex = keys.findIndex(key => key.t >= time);
    if (nextIndex < 0) nextIndex = keys.length - 1;
    const previous = keys[Math.max(0, nextIndex - 1)];
    const next = keys[nextIndex];
    const factor = next.t === previous.t ? 0 : (time - previous.t) / (next.t - previous.t);
    const output = {};
    for (const key of NUMERIC) output[key] = Math.round((previous[key] + (next[key] - previous[key]) * factor) * 2) / 2;
    for (const key of DISCRETE) output[key] = factor < .5 ? previous[key] : next[key];
    if (['sleep', 'nest'].includes(action) || (action === 'wake' && time < .68) || (action === 'nest-enter' && time >= .6) || (action === 'nest-rise' && time < .68)) output.sleepArt = true;
    if (action === 'nest' || action === 'nest-enter' || (action === 'nest-rise' && time < .82)) output.bedArt = true;
    if (['loaf', 'purr'].includes(action) || (action === 'loaf-enter' && time >= .6) || (action === 'loaf-rise' && time < .45)) output.loafArt = true;
    return output;
  }

  const normalize = pose => ({ nap: 'sleep', 'walk-1': 'walk', 'walk-2': 'walk', wiggle: 'wave' }[pose] || pose);
  class PixelCatAnimator {
    constructor(host) {
      this.host = host;
      this.action = '';
      this.started = 0;
      this.frame = -1;
      const parsed = new DOMParser().parseFromString(ART, 'image/svg+xml');
      this.svg = document.importNode(parsed.documentElement, true);
      host.appendChild(this.svg);
      host.classList.add('rigged');
      this.parts = {};
      for (const id of ['stand', 'loaf', 'loaf-body', 'loaf-head', 'loaf-tail', 'loaf-eye-open', 'loaf-eye-closed', 'loaf-eye-happy', 'sleep', 'sleep-body', 'sleep-head', 'bed-back', 'bed-front', 'tail', 'tail-line', 'tail-color', 'tail-stripe', 'rear-left', 'rear-right', 'body', 'head', 'paw-left', 'paw-right', 'eye-open', 'eye-closed', 'eye-happy', 'mouth-smile', 'mouth-open', 'mouth-tongue', 'prop-fish', 'prop-heart', 'prop-yarn', 'prop-envelope', 'prop-spark', 'prop-z', 'prop-hand']) {
        this.parts[id] = this.svg.querySelector(`#cat-${id}`);
      }
      this.tick = this.tick.bind(this);
    }
    durationFor(pose) { return (ACTIONS[normalize(pose)] || ACTIONS.idle).ms; }
    play(pose) {
      const action = normalize(pose);
      if (action === this.action && ACTIONS[action]?.loop) return;
      this.action = ACTIONS[action] ? action : 'idle';
      this.started = performance.now();
      this.frame = -1;
      this.draw(0);
      if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    }
    tick(now) {
      this.raf = requestAnimationFrame(this.tick);
      if (document.body.classList.contains('quiet-mode') || document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const spec = ACTIONS[this.action] || ACTIONS.idle;
      const elapsed = now - this.started;
      const frame = Math.min(spec.frames - 1, Math.floor((elapsed % (spec.loop ? spec.ms : Infinity)) / spec.ms * spec.frames));
      if (frame !== this.frame) this.draw(frame);
    }
    draw(frame) {
      this.frame = frame;
      const s = sample(this.action, frame);
      const p = this.parts;
      p.stand.setAttribute('display', s.sleepArt || s.loafArt ? 'none' : 'inline');
      p.loaf.setAttribute('display', s.loafArt ? 'inline' : 'none');
      p.sleep.setAttribute('display', s.sleepArt ? 'inline' : 'none');
      p['bed-back'].setAttribute('display', s.bedArt ? 'inline' : 'none');
      p['bed-front'].setAttribute('display', s.bedArt ? 'inline' : 'none');
      if (s.sleepArt) {
        p['sleep-body'].setAttribute('transform', `translate(0 ${s.sy})`);
        p['sleep-head'].setAttribute('transform', `translate(0 ${s.sy + (this.action === 'wake' ? -frame / 4 : 0)})`);
      } else if (s.loafArt) {
        p['loaf-body'].setAttribute('transform', `translate(0 ${s.sy})`);
        p['loaf-head'].setAttribute('transform', `translate(${s.hx} ${s.hy + s.sy})`);
        p['loaf-tail'].setAttribute('transform', `translate(${s.tx} ${s.ty})`);
        for (const eye of ['open', 'closed', 'happy']) p[`loaf-eye-${eye}`].setAttribute('display', s.eye === eye ? 'inline' : 'none');
      } else {
        p.body.setAttribute('transform', `translate(${s.bx} ${s.by})`);
        p.head.setAttribute('transform', `translate(${s.hx} ${s.hy})`);
        p['rear-left'].setAttribute('transform', `translate(${s.rlx} ${s.rly + s.by})`);
        p['rear-right'].setAttribute('transform', `translate(${s.rrx} ${s.rry + s.by})`);
        p['paw-left'].setAttribute('transform', `translate(${s.lx} ${s.ly + s.by})`);
        p['paw-right'].setAttribute('transform', `translate(${s.rx} ${s.ry + s.by})`);
        p.tail.setAttribute('transform', `translate(${s.tx} ${s.ty + s.by})`);
        const paths = TAILS[s.tail];
        p['tail-line'].setAttribute('d', paths[0]);
        p['tail-color'].setAttribute('d', paths[1]);
        p['tail-stripe'].setAttribute('d', paths[2]);
        for (const eye of ['open', 'closed', 'happy']) p[`eye-${eye}`].setAttribute('display', s.eye === eye ? 'inline' : 'none');
        for (const mouth of ['smile', 'open', 'tongue']) p[`mouth-${mouth}`].setAttribute('display', s.mouth === mouth ? 'inline' : 'none');
      }
      for (const prop of ['fish', 'heart', 'yarn', 'envelope', 'spark', 'z', 'hand']) {
        const node = p[`prop-${prop}`];
        node.setAttribute('display', s.prop === prop ? 'inline' : 'none');
        if (s.prop === prop) node.setAttribute('transform', `translate(${s.px} ${s.py}) scale(${s.ps})`);
      }
    }
  }

  if (typeof window !== 'undefined') window.PixelCatAnimator = PixelCatAnimator;
  if (typeof module !== 'undefined') module.exports = { ACTIONS, sample, normalize };
})();
