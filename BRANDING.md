# BRANDING — single source of truth for project identity

**Brand name (chosen 19 Nov 2026 ~10:37 WIB): Pixflow.**
Ivan sent three options (pixflow / sentrix / neithon) and asked qyu
to pick. Pixflow won: sentrix is already a live Layer-1 blockchain
(Sentrix Labs, token SRX, mainnet since Apr 2026) — a fatal collision
for a product whose pitch is "buy the real one, not the clone";
neithon is hard to spell and pronounce; pixflow is clean, easy to
say/spell, and "flow" nods to routing. Verified 19 Nov ~10:36 WIB:
no Pons token under any of the three names, no DexScreener pairs,
and pixflow.xyz available (NXDOMAIN).

**Working name (Fase 1 only): Verified Buy Router.**
**Short name in code: VBR.**
**Logo: received from Ivan 19 Nov 2026 ~11:52 WIB — white pixelated
right-arrow on deep navy bg (~#031045), 1254x1254, saved as-is at
`assets/pixflow-logo.png` (JPEG bytes despite the .png extension, same
as Specta's logo). Use as-is — never redraw, recolor, or upscale-crop.**

## Palette (decided 19 Nov 2026 ~11:52 WIB)

Ivan sent the logo and asked qyu to judge the color combination and
change it if not good. Verdict: the white-on-navy (#031045) combination
is GOOD — high contrast, clean, premium, right for a verification
product. The logo colors were NOT changed.

- **Base:** navy `#031045` + white (from the logo).
- **Accent:** electric cyan `#22D3EE`, used sparingly — CTAs,
  "verified/canonical" states, glows, flow lines. The cyan keeps the
  site from feeling flat and from looking like RYCORE (also navy +
  white).
- **Never use:** Specta's mint green or gold — those belong to Specta.
- **Motif:** pixel-grid / pixel-flow (pixels assembling, flowing,
  resolving into the arrow) — fits the pixel-arrow logo better than
  generic particles. Do NOT reuse particle-network + blobs
  (Specta/RYCORE already used that).

Deliberate: the contract keeps its descriptive name
`VerifiedBuyRouter` (and the code keeps `VBR`) — renaming it would
invalidate the Fase 1 verification and the audit PoC copies
(byte-identical, sha256-checked in AUDIT-POC.md). Only the
project-facing identity (docs, package name) carries Pixflow.

The logo has arrived (19 Nov ~11:52 WIB) and the swap was mechanical —
the name appears ONLY in the places listed below (no name is baked into
contract behaviour, storage layout, or selectors; renaming is a text
change + recompile).

## Where the working name appears

| Place | What it says |
|---|---|
| `package.json` | `name: "pixflow"`, description |
| `README.md` | Title + prose |
| `DESIGN.md` | Title + prose |
| `RESEARCH.md` | Prose references |
| `BRANDING.md` | This file |
| `contracts/VerifiedBuyRouter.sol` | Contract name `VerifiedBuyRouter`, NatSpec title |
| `contracts/CanonicalRegistry.sol` | NatSpec references to "VerifiedBuyRouter" |
| `tests/*.ts`, `tests/vm.ts` | Suite names + comments |
| `audit/test/PoC.t.sol` | Comments |
| `scripts/compile-contracts.mjs` | Header comment |

## What does NOT need to change on rebrand

- `CanonicalRegistry` contract name (generic, no brand in it).
- Function names, events, errors, storage layout, selectors.
- The fee model, the timelock, the resolver rules.
- Any deployed address (testnet deploy exists since Fase 2 — see README;
  nothing on mainnet).

## Rules for the rebrand (from Ivan's standing rules)

- Brand name: English, ONE word, never Indonesian.
- The logo is Ivan's asset — use it as-is, never redraw or crop it.
- The website (Fase 2) must start from Ivan's taste: ALIVE (animation,
  motion, filled backgrounds), never minimal-static. Logo small in the
  nav only, never a giant hero centerpiece.
