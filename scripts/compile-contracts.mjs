/**
 * Compile the verified-buy-router contracts with solc-js (no solc binary
 * on the VM) and emit:
 * - contracts/artifacts/<Name>.json (ABI + creation bytecode)
 * - src/contracts.ts (generated — ABI + bytecode embedded as TS constants)
 *
 * Contracts compiled:
 * - VerifiedBuyRouter.sol + CanonicalRegistry.sol (ours)
 * - test/PonsFactoryStub.sol + test/LyingBuyCurve.sol + test/ReentrantBuyer.sol
 *   + test/PonsTestStubs.sol (ours, test-only)
 * - The REAL Pons v2 factory suite (vendored unmodified from Sourcify — see
 *   contracts/vendor/README.md): factory, launch deployer, meme hook,
 *   buyback vault, launch locker, graduation executor, bonding curve,
 *   launcher token, graduation guard + math.
 *
 * Import resolution is RECURSIVE: entry points are listed below and every
 * `import` is followed (remappings + relative paths + literal source keys),
 * so the full import closure — including @uniswap/v4-core and
 * @uniswap/v4-periphery from node_modules — is compiled. Source keys follow
 * the existing convention: our contracts use bare names, Pons files keep
 * foundry-style `contracts/src/...` / `contracts/lib/...` keys (disk:
 * contracts/vendor/pons/contracts/...).
 *
 * NOTE: @uniswap/v4-hooks-public and permit2 are NOT on npm (hooks-public is
 * git-only, permit2 was unpublished 2026-08-11). Minimal compile-time shims
 * live in contracts/vendor/uniswap-hooks-public/ (BaseHook) and
 * contracts/vendor/permit2/ (IAllowanceTransfer); see the headers in those
 * files for what they do and do not cover.
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

// [import prefix, solc-key prefix]
const REMAPPINGS = [
  ['@openzeppelin/contracts/', 'contracts/lib/openzeppelin-contracts/contracts/'],
  ['@uniswap/v4-core/', 'node_modules/@uniswap/v4-core/'],
  ['@uniswap/v4-periphery/', 'node_modules/@uniswap/v4-periphery/'],
  ['@uniswap/v4-hooks-public/', 'contracts/vendor/uniswap-hooks-public/'],
  ['permit2/', 'contracts/vendor/permit2/'],
];

// Solc source keys of the entry points. Our contracts use bare names (the
// historical convention); Pons files use foundry-style keys.
const ENTRIES = [
  // Ours.
  'VerifiedBuyRouter.sol',
  'CanonicalRegistry.sol',
  'IPonsV2LaunchFactory.sol',
  'PonsFactoryStub.sol',
  'LyingBuyCurve.sol',
  'ReentrantBuyer.sol',
  'PonsTestStubs.sol',
  // Pons V2 (vendored, unmodified).
  'contracts/src/v2/PonsV2LaunchFactory.sol',
  'contracts/src/v2/PonsV2LaunchDeployer.sol',
  'contracts/src/v2/hooks/PonsV2MemeHook.sol',
  'contracts/src/v2/PonsV2BuybackVault.sol',
  'contracts/src/v2/PonsV2LaunchLocker.sol',
  'contracts/src/v2/PonsV2GraduationExecutor.sol',
  'contracts/src/v2/PonsV2BondingCurve.sol',
  'contracts/src/v2/PonsV2LauncherToken.sol',
];

function diskPath(key) {
  const candidates = [
    key,
    `contracts/${key}`,
    `contracts/test/${key}`,
    `contracts/vendor/pons/${key}`,
  ];
  for (const rel of candidates) {
    const full = path.join(root, rel);
    if (existsSync(full)) return full;
  }
  throw new Error(`source not found on disk for key: ${key}`);
}

function resolveImport(fromKey, spec) {
  for (const [prefix, target] of REMAPPINGS) {
    if (spec.startsWith(prefix)) return target + spec.slice(prefix.length);
  }
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const parts = path
      .dirname(fromKey)
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      else if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }
  // Literal source key (project-rooted import, e.g. "contracts/src/...").
  return spec;
}

const IMPORT_RE = /import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
const sources = {};
function addSource(key) {
  if (sources[key]) return;
  const content = readFileSync(diskPath(key), 'utf8');
  sources[key] = { content };
  for (const m of content.matchAll(IMPORT_RE)) addSource(resolveImport(key, m[1]));
}
for (const entry of ENTRIES) addSource(entry);
console.log(`compiling ${Object.keys(sources).length} sources (solc ${solc.version()})...`);

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
    remappings: REMAPPINGS.map(([a, b]) => `${a}=${b}`),
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
  for (const e of errors) console.error(e.formattedMessage ?? `solc error: ${e.message}`);
  process.exit(1);
}

mkdirSync(artifactsDir, { recursive: true });

const WANTED = [
  'VerifiedBuyRouter',
  'CanonicalRegistry',
  'PonsFactoryStub',
  'LyingBuyCurve',
  'ReentrantBuyer',
  'StubPoolManager',
  'StubPositionManager',
  'StubPermit2',
  'StubFeeEscrow',
  'PonsV2BondingCurve',
  'PonsV2LauncherToken',
  'PonsV2LaunchFactory',
  'PonsV2LaunchDeployer',
  'PonsV2MemeHook',
  'PonsV2BuybackVault',
  'PonsV2LaunchLocker',
  'PonsV2GraduationExecutor',
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

export const STUB_POOL_MANAGER_ABI = ${JSON.stringify(compiled.StubPoolManager.abi)} as const;
export const STUB_POOL_MANAGER_BYTECODE = '${compiled.StubPoolManager.bytecode}' as const;

export const STUB_POSITION_MANAGER_ABI = ${JSON.stringify(compiled.StubPositionManager.abi)} as const;
export const STUB_POSITION_MANAGER_BYTECODE = '${compiled.StubPositionManager.bytecode}' as const;

export const STUB_PERMIT2_ABI = ${JSON.stringify(compiled.StubPermit2.abi)} as const;
export const STUB_PERMIT2_BYTECODE = '${compiled.StubPermit2.bytecode}' as const;

export const STUB_FEE_ESCROW_ABI = ${JSON.stringify(compiled.StubFeeEscrow.abi)} as const;
export const STUB_FEE_ESCROW_BYTECODE = '${compiled.StubFeeEscrow.bytecode}' as const;

export const PONS_CURVE_ABI = ${JSON.stringify(compiled.PonsV2BondingCurve.abi)} as const;
export const PONS_CURVE_BYTECODE = '${compiled.PonsV2BondingCurve.bytecode}' as const;
export const PONS_CURVE_DEPLOYED_BYTECODE = '${compiled.PonsV2BondingCurve.deployedBytecode}' as const;

export const PONS_TOKEN_ABI = ${JSON.stringify(compiled.PonsV2LauncherToken.abi)} as const;
export const PONS_TOKEN_BYTECODE = '${compiled.PonsV2LauncherToken.bytecode}' as const;

export const PONS_FACTORY_ABI = ${JSON.stringify(compiled.PonsV2LaunchFactory.abi)} as const;
export const PONS_FACTORY_BYTECODE = '${compiled.PonsV2LaunchFactory.bytecode}' as const;
export const PONS_FACTORY_DEPLOYED_BYTECODE = '${compiled.PonsV2LaunchFactory.deployedBytecode}' as const;

export const PONS_LAUNCH_DEPLOYER_ABI = ${JSON.stringify(compiled.PonsV2LaunchDeployer.abi)} as const;
export const PONS_LAUNCH_DEPLOYER_BYTECODE = '${compiled.PonsV2LaunchDeployer.bytecode}' as const;

export const PONS_HOOK_ABI = ${JSON.stringify(compiled.PonsV2MemeHook.abi)} as const;
export const PONS_HOOK_BYTECODE = '${compiled.PonsV2MemeHook.bytecode}' as const;

export const PONS_VAULT_ABI = ${JSON.stringify(compiled.PonsV2BuybackVault.abi)} as const;
export const PONS_VAULT_BYTECODE = '${compiled.PonsV2BuybackVault.bytecode}' as const;

export const PONS_LOCKER_ABI = ${JSON.stringify(compiled.PonsV2LaunchLocker.abi)} as const;
export const PONS_LOCKER_BYTECODE = '${compiled.PonsV2LaunchLocker.bytecode}' as const;

export const PONS_EXECUTOR_ABI = ${JSON.stringify(compiled.PonsV2GraduationExecutor.abi)} as const;
export const PONS_EXECUTOR_BYTECODE = '${compiled.PonsV2GraduationExecutor.bytecode}' as const;
`;
mkdirSync(path.join(root, 'src'), { recursive: true });
writeFileSync(path.join(root, 'src', 'contracts.ts'), generated);
console.log('wrote src/contracts.ts');
