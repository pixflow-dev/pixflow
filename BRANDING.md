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
**Logo: none yet — still awaited from Ivan.**

Deliberate: the contract keeps its descriptive name
`VerifiedBuyRouter` (and the code keeps `VBR`) — renaming it would
invalidate the Fase 1 verification and the audit PoC copies
(byte-identical, sha256-checked in AUDIT-POC.md). Only the
project-facing identity (docs, package name) carries Pixflow.

When the logo arrives, the swap is mechanical — the name appears ONLY
in the places listed below (no name is baked into contract behaviour,
storage layout, or selectors; renaming is a text change + recompile).

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
- Any deployed address (nothing is deployed yet in Fase 1).

## Rules for the rebrand (from Ivan's standing rules)

- Brand name: English, ONE word, never Indonesian.
- The logo is Ivan's asset — use it as-is, never redraw or crop it.
- The website (Fase 2) must start from Ivan's taste: ALIVE (animation,
  motion, filled backgrounds), never minimal-static. Logo small in the
  nav only, never a giant hero centerpiece.
