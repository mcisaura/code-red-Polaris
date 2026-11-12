// AirMix QA2: text colors on set-picker chips/labels meet 4.5:1; phone picker sits below the top bar.
const fs = require('fs'), assert = require('assert');
const lum = (h) => { if (h.length === 4) h = '#' + [...h.slice(1)].map((d) => d + d).join(''); const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const css = fs.readFileSync(__dirname + '/../djStart.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../ai-dj.html', 'utf8');
const pair = (re, bgRe) => { const m = css.match(re); assert(m, String(re)); return [m[1], (css.match(bgRe) || m)[1]]; };
const cases = [
  [/\.djStart-mix \{[^}]*color: (#\w+); background: (#\w+)/],
  [/\.djStart-mix\.cut \{ background: (#\w+); color: (#\w+)/, 1],
  [/\[aria-selected="true"\] \.djStart-order \{ background: (#\w+)/, 2],
  [/span\.seen\[data-side="left"\] \{ color: (#\w+); background: (#\w+)/],
  [/span\.seen\[data-side="right"\] \{ color: (#\w+); background: (#\w+)/],
  [/\.djStart-hands span \{[^}]*color: (#\w+); background: (#\w+)/],
];
for (const [re, kind] of cases) {
  const m = css.match(re); assert(m, String(re));
  const [fg, bg] = kind === 1 ? [m[2], m[1]] : kind === 2 ? ['#ffffff', m[1]] : [m[1], m[2]];
  assert(ratio(fg, bg) >= 4.5, `${re}: ${fg} on ${bg} = ${ratio(fg, bg).toFixed(2)}`);
}
assert(!html.includes('color: #c35f08'), 'orange text uses #8a4510');
assert(/\.djStart \{ position: fixed; inset: var\(--djTop/.test(css), 'phone picker leaves the top bar reachable');
console.log('PASS: AirMix qa2 contrast and phone picker offset');
