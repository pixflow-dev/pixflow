# BRANDING — single source of truth for project identity

**Working name (Fase 1 only): Verified Buy Router.**
**Short name in code: VBR.**
**Logo: none yet.**

Ivan already has the real brand name + logo and will share them. When
they arrive, the swap is mechanical — the name appears ONLY in the
places listed below (no name is baked into contract behaviour, storage
layout, or selectors; renaming is a text change + recompile).

## Where the working name appears

| Place | What it says |
|---|---|
| `package.json` | `name: "verified-buy-router"`, description |
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
