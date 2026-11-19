/**
 * Compile the verified-buy-router contracts with solc-js (no solc binary
 * on the VM) and emit:
 * - contracts/artifacts/<Name>.json (ABI + creation bytecode)
 * - src/contracts.ts (generated — ABI + bytecode embedded as TS constants)
 *
 * Contracts compiled:
 * - VerifiedBuyRouter.sol + CanonicalRegistry.sol (ours)
 * - test/PonsFactoryStub.sol + test/LyingBuyCurve.sol (ours, test-only)
 * - vendor PonsV2BondingCurve.sol + PonsV2LauncherToken.sol (REAL Pons V2
 *   contracts, vendored unmodified from Sourcify — see
 *   contracts/vendor/README.md). Compiled with solc 0.8.35; Pons used
 *   0.8.35, so the bytecode differs from mainnet only in the metadata
 *   hash (same source, pragma ^0.8.26).
 *
 * Run: npm run compile:contracts
 * Re-run after ANY change to contracts/*.sol.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = path.join(root, 'contracts', 'artifacts');

// Source key (as solc sees it) -> file on disk, relative to repo root.
// Pons + OZ files keep their foundry-style keys so relative imports
// resolve; the remapping below handles "@openzeppelin/contracts/...".
const SOURCES = {
  // Ours.
  'VerifiedBuyRouter.sol': 'contracts/VerifiedBuyRouter.sol',
  'CanonicalRegistry.sol': 'contracts/CanonicalRegistry.sol',
  'IPonsV2LaunchFactory.sol': 'contracts/IPonsV2LaunchFactory.sol',
  'PonsFactoryStub.sol': 'contracts/test/PonsFactoryStub.sol',
  'LyingBuyCurve.sol': 'contracts/test/LyingBuyCurve.sol',
  'ReentrantBuyer.sol': 'contracts/test/ReentrantBuyer.sol',
  // Pons V2 (vendored, unmodified).
  'contracts/src/v2/PonsV2BondingCurve.sol':
    'contracts/vendor/pons/contracts/src/v2/PonsV2BondingCurve.sol',
  'contracts/src/v2/libraries/PonsV2BondingCurveMath.sol':
    'contracts/vendor/pons/contracts/src/v2/libraries/PonsV2BondingCurveMath.sol',
  'contracts/src/v2/PonsV2LauncherToken.sol':
    'contracts/vendor/pons/contracts/src/v2/PonsV2LauncherToken.sol',
  'contracts/src/v2/PonsV2BuybackVault.sol':
    'contracts/vendor/pons/contracts/src/v2/PonsV2BuybackVault.sol',
  'contracts/src/v2/interfaces/ILaunchpadV2.sol':
    'contracts/vendor/pons/contracts/src/v2/interfaces/ILaunchpadV2.sol',
  'contracts/src/v2/interfaces/ILaunchpadV2Graduation.sol':
    'contracts/vendor/pons/contracts/src/v2/interfaces/ILaunchpadV2Graduation.sol',
};

// OpenZeppelin files (vendored from the same Sourcify response) — the
// transitive closure of what the Pons tree imports. Paths are relative to
// contracts/lib/openzeppelin-contracts/contracts/.
const OZ_FILES = [
  'access/Ownable.sol',
  'access/Ownable2Step.sol',
  'interfaces/draft-IERC6093.sol',
  'interfaces/IERC1363.sol',
  'interfaces/IERC165.sol',
  'interfaces/IERC20.sol',
  'interfaces/IERC20Metadata.sol',
  'token/ERC20/ERC20.sol',
  'token/ERC20/IERC20.sol',
  'token/ERC20/extensions/ERC20Burnable.sol',
  'token/ERC20/extensions/IERC20Metadata.sol',
  'token/ERC20/utils/SafeERC20.sol',
  'utils/Context.sol',
  'utils/Panic.sol',
  'utils/introspection/IERC165.sol',
  'utils/ReentrancyGuard.sol',
  'utils/StorageSlot.sol',
  'utils/math/Math.sol',
  'utils/math/SafeCast.sol',
];

for (const f of OZ_FILES) {
  SOURCES[`contracts/lib/openzeppelin-contracts/contracts/${f}`] =
    `contracts/vendor/pons/contracts/lib/openzeppelin-contracts/contracts/${f}`;
}

const sources = {};
for (const [key, rel] of Object.entries(SOURCES)) {
  const full = path.join(root, rel);
  if (!existsSync(full)) throw new Error(`missing source file: ${rel}`);
  sources[key] = { content: readFileSync(full, 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    // Pons compiled with viaIR + optimizer runs 200 + cancun (see the
    // factory's Sourcify metadata); the curve contract hits "stack too
    // deep" without viaIR, so we mirror those settings exactly.
    viaIR: true,
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 200 },
    remappings: ['@openzeppelin/contracts/=contracts/lib/openzeppelin-contracts/contracts/'],
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
for (const warning of (output.errors ?? []).filter((e) => e.severity === 'warning')) {
  console.warn(`solc warning: ${warning.message}`);
}
if (errors.length > 0) {
  for (const e of errors) console.error(`solc error: ${e.message}`);
  process.exit(1);
}

mkdirSync(artifactsDir, { recursive: true });

const WANTED = [
  'VerifiedBuyRouter',
  'CanonicalRegistry',
  'PonsFactoryStub',
  'LyingBuyCurve',
  'ReentrantBuyer',
  'PonsV2BondingCurve',
  'PonsV2LauncherToken',
];
const compiled = {};
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, contract] of Object.entries(contracts)) {
    if (!WANTED.includes(name)) continue;
    const artifact = {
      contractName: name,
      sourceName: file,
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    };
    writeFileSync(
      path.join(artifactsDir, `${name}.json`),
      JSON.stringify(artifact, null, 2) + '\n',
    );
    compiled[name] = artifact;
    console.log(
      `${name}: ${(contract.evm.bytecode.object.length / 2).toFixed(0)} bytes creation, ` +
        `${(contract.evm.deployedBytecode.object.length / 2).toFixed(0)} bytes deployed`,
    );
  }
}

for (const name of WANTED) {
  if (!compiled[name]) throw new Error(`missing compiled output for ${name}`);
}

const generated = `/**
 * GENERATED by scripts/compile-contracts.mjs — do not edit by hand.
 * Re-run \`npm run compile:contracts\` after any change to contracts/*.sol.
 */

export const ROUTER_ABI = ${JSON.stringify(compiled.VerifiedBuyRouter.abi)} as const;
export const ROUTER_BYTECODE = '${compiled.VerifiedBuyRouter.bytecode}' as const;
export const ROUTER_DEPLOYED_BYTECODE = '${compiled.VerifiedBuyRouter.deployedBytecode}' as const;

export const REGISTRY_ABI = ${JSON.stringify(compiled.CanonicalRegistry.abi)} as const;
export const REGISTRY_BYTECODE = '${compiled.CanonicalRegistry.bytecode}' as const;

export const PONS_FACTORY_STUB_ABI = ${JSON.stringify(compiled.PonsFactoryStub.abi)} as const;
export const PONS_FACTORY_STUB_BYTECODE = '${compiled.PonsFactoryStub.bytecode}' as const;

export const LYING_BUY_CURVE_ABI = ${JSON.stringify(compiled.LyingBuyCurve.abi)} as const;
export const LYING_BUY_CURVE_BYTECODE = '${compiled.LyingBuyCurve.bytecode}' as const;

export const REENTRANT_BUYER_ABI = ${JSON.stringify(compiled.ReentrantBuyer.abi)} as const;
export const REENTRANT_BUYER_BYTECODE = '${compiled.ReentrantBuyer.bytecode}' as const;

export const PONS_CURVE_ABI = ${JSON.stringify(compiled.PonsV2BondingCurve.abi)} as const;
export const PONS_CURVE_BYTECODE = '${compiled.PonsV2BondingCurve.bytecode}' as const;
export const PONS_CURVE_DEPLOYED_BYTECODE = '${compiled.PonsV2BondingCurve.deployedBytecode}' as const;

export const PONS_TOKEN_ABI = ${JSON.stringify(compiled.PonsV2LauncherToken.abi)} as const;
export const PONS_TOKEN_BYTECODE = '${compiled.PonsV2LauncherToken.bytecode}' as const;
`;
mkdirSync(path.join(root, 'src'), { recursive: true });
writeFileSync(path.join(root, 'src', 'contracts.ts'), generated);
console.log('wrote src/contracts.ts');
