# Design tokens — extracted from the theme reference artifact

Source: https://claude.ai/code/artifact/8d71f877-7d04-4692-840e-16d125625d2c
("Enterprise Lending Portal Design"). Values below were recovered from the
published bundle, not approximated.

## Character

Quiet institutional finance. Tight 2px radii, small type, IBM Plex Mono for all
data/labels, muted grey-blue neutrals, single navy accent. Information-dense,
no decoration.

## Type

- Sans: `'IBM Plex Sans', 'Helvetica Neue', Helvetica, sans-serif`
- Mono: `'IBM Plex Mono', monospace`  ← dominant (300 uses): labels, numerics, status, timestamps
- Scale: 10 / 11 / 12 / 13 / 14 / 16 px core; 18 / 20 / 22 / 28 px headings only
- Weights: 500 and 600 carry the design. 400 for body. Never 700.
- Micro-labels: mono, 10–11px, `letter-spacing: 0.08em`–`0.1em`, uppercase

## Radius

`2px` everywhere (150 uses). `3px` occasionally. `50%` dots/avatars. `999px` pills only.

## Neutrals

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#14181c` | primary text |
| `--ink-2` | `#333b43` | headings |
| `--ink-3` | `#3a424a` | strong secondary |
| `--text` | `#4c555e` | body text (most used) |
| `--text-muted` | `#6b747e` | muted |
| `--text-disabled` | `#9aa3ad` | disabled / placeholder |
| `--border-strong` | `#c3c9d1` | strong border |
| `--border` | `#e0e4e9` | default border |
| `--border-light` | `#e6e9ed` | hairline |
| `--bg-sunken` | `#eceff3` | sunken / header row |
| `--bg-subtle` | `#f0f2f5` | subtle fill |
| `--bg-page` | `#f2f4f7` | page background |
| `--bg-row` | `#f7f8fa` | zebra row |
| `--bg-raised` | `#fafbfc` | raised panel |
| `--surface` | `#ffffff` | card surface |

## Accent (navy)

| Token | Hex | Role |
|---|---|---|
| `--accent` | `#22496f` | primary action, links, focus ring |
| `--accent-hover` | `#16324f` | hover |
| `--accent-deep` | `#1a3a5a` | pressed / dark |
| `--accent-border` | `#c8d6e3` | accent border |
| `--accent-bg` | `#edf2f7` | accent tint |

## Status — semantic, never colour-only (always paired with a glyph/label)

Success / PASS / funded — glyph `✓`
| `--ok-text` `#1a6b4c` | `--ok-text-deep` `#12523a` | `--ok-bg` `#ecf4f0` | `--ok-border` `#c0dbcd` |

Warning / AMBER / under review — glyph `!`
| `--warn-text` `#8a5a12` | `--warn-text-deep` `#6d4709` | `--warn-bg` `#fbf3e6` | `--warn-border` `#e8d5b0` |

Danger / FAIL / declined — glyph `✕`
| `--bad-text` `#9c2a2a` | `--bad-text-deep` `#7d2020` | `--bad-bg` `#fbeeee` | `--bad-border` `#eccaca` | `--bad-border-strong` `#d9a8a8` |

## Base rules

```css
body { background:#f2f4f7; color:#14181c; -webkit-font-smoothing:antialiased; }
a { color:#22496f; text-decoration:none; }
a:hover { color:#16324f; text-decoration:underline; }
:focus-visible { outline:2px solid #22496f; outline-offset:2px; border-radius:2px; }
```

Status colour is never the only signal — every status carries a glyph and a word.
