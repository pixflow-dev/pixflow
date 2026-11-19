/**
 * Deploy VerifiedBuyRouter + CanonicalRegistry (+ the real Pons curve +
 * token + factory stub) to RH TESTNET 46630. Testnet only — this script
 * refuses any other chain.
 *
 * Uses the RYCORE testnet deployer key by default
 * (~/workspace/rycore/data/testnet-deployer.json, mode 600) — override with
 * DEPLOYER_KEY_FILE. The key is never printed.
 *
 * RESUMABLE: progress is written to data/testnet-deployment.json after
 * every step. If the run stops early (e.g. deployer runs out of gas), just
 * re-run — already-deployed contracts are re-used after a code check, and
 * initialize/register steps are skipped when already done.
 *
 * Writes data/testnet-deployment.json (addresses + tx hashes, no secrets).
 * data/*.json is gitignored — deployment records never enter the repo.
 *
 * Run: npm run deploy:testnet
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, fallback, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  PONS_CURVE_ABI,
  PONS_CURVE_BYTECODE,
  PONS_FACTORY_STUB_ABI,
  PONS_FACTORY_STUB_BYTECODE,
  PONS_TOKEN_ABI,
  PONS_TOKEN_BYTECODE,
  REGISTRY_ABI,
  REGISTRY_BYTECODE,
  ROUTER_ABI,
  ROUTER_BYTECODE,
} from '../src/contracts.js';
import { robinhoodTestnet } from '../src/chains.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC_URL = process.env.TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
// Fallback transport: the primary testnet RPC intermittently times out.
const transport = fallback([http(RPC_URL), http('https://api.blockvectra.com/v1/robinhood_testnet/public')]);
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
const OUT_FILE = path.join(root, 'data', 'testnet-deployment.json');

// Mainnet snipe-tax policy (verified from HOOKLB forensics 2026-11-18):
// the testnet curve must behave like a mainnet curve for the router's
// tax-window check to be exercised honestly.
const SNIPE_TAX_START_BPS = 9900n;
const SNIPE_TAX_SECONDS = 3n;

// Minimum deployer balance to start (deploy ≈ 0.00012 ETH at 0.01 gwei;
// the E2E run needs ~0.00006 more, so starting below this strands the run).
const MIN_BALANCE = parseEther('0.00015');

type Deployment = Record<string, string | number | Record<string, string>>;

function loadPartial(): Deployment {
  if (!existsSync(OUT_FILE)) return {};
  try {
    return JSON.parse(readFileSync(OUT_FILE, 'utf8')) as Deployment;
  } catch {
    return {};
  }
}

function save(deployment: Deployment) {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(deployment, null, 2) + '\n');
}

async function main() {
  const keyFile =
    process.env.DEPLOYER_KEY_FILE ??
    path.join(process.env.HOME ?? '', 'workspace', 'rycore', 'data', 'testnet-deployer.json');
  const keyData = JSON.parse(readFileSync(keyFile, 'utf8'));
  const account = privateKeyToAccount(keyData.privateKey as Hex);

  const publicClient = createPublicClient({ chain: robinhoodTestnet, transport });
  const walletClient = createWalletClient({ account, chain: robinhoodTestnet, transport });

  const chainId = await publicClient.getChainId();
  if (chainId !== 46630) throw new Error(`REFUSING: connected chain is ${chainId}, expected testnet 46630`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer ${account.address} balance ${balance} wei (${Number(balance) / 1e18} ETH)`);
  if (balance < MIN_BALANCE) {
    throw new Error(
      `deployer balance too low (need >= ${MIN_BALANCE} wei). Top up at https://faucet.testnet.chain.robinhood.com/ from a browser (0.01 testnet ETH per claim, once per 24h) and re-run.`,
    );
  }

  const deployment: Deployment = loadPartial();
  deployment.chainId = 46630;
  deployment.network = 'robinhood-testnet';
  deployment.deployer = account.address;
  deployment.deployedAt = deployment.deployedAt ?? new Date().toISOString();

  async function hasCode(address: string): Promise<boolean> {
    const code = await publicClient.getCode({ address: address as Hex });
    return !!code && code !== '0x';
  }

  async function deploy(
    key: string,
    name: string,
    abi: unknown,
    bytecode: Hex,
    args: unknown[],
  ): Promise<Hex> {
    const existing = deployment[key];
    if (typeof existing === 'string' && (await hasCode(existing))) {
      console.log(`reusing ${name}: ${existing}`);
      return existing as Hex;
    }
    console.log(`deploying ${name}...`);
    const txHash = await walletClient.deployContract({ abi: abi as never, bytecode, args: args as never });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new Error(`${name} deploy failed (tx ${txHash})`);
    }
    console.log(`  ${name}: ${receipt.contractAddress} (tx ${txHash})`);
    deployment[key] = receipt.contractAddress;
    deployment[`${key}Tx`] = txHash;
    save(deployment);
    return receipt.contractAddress;
  }

  async function sendTx(
    key: string,
    label: string,
    address: Hex,
    abi: unknown,
    functionName: string,
    args: unknown[],
  ): Promise<Hex> {
    console.log(`${label}...`);
    const txHash = await walletClient.writeContract({
      address,
      abi: abi as never,
      functionName,
      args: args as never,
      account,
      chain: robinhoodTestnet,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`${label} failed (tx ${txHash})`);
    console.log(`  done (tx ${txHash})`);
    deployment[key] = txHash;
    save(deployment);
    return txHash;
  }

  const stub = await deploy('stub', 'PonsFactoryStub', PONS_FACTORY_STUB_ABI, PONS_FACTORY_STUB_BYTECODE, []);

  // Snipe-tax policy must be set BEFORE initializeCurve (the curve
  // snapshots it at initialize). Skip if already set (resume path).
  const currentWindow = await publicClient.readContract({
    address: stub,
    abi: PONS_FACTORY_STUB_ABI,
    functionName: 'snipeTaxSeconds',
  });
  if (currentWindow !== SNIPE_TAX_SECONDS) {
    await sendTx('setSnipeTaxTx', 'setting snipe tax (9900 bps / 3s, mainnet policy)', stub, PONS_FACTORY_STUB_ABI, 'setSnipeTax', [SNIPE_TAX_START_BPS, SNIPE_TAX_SECONDS]);
  } else {
    console.log('snipe tax already set (9900 bps / 3s)');
  }

  const curve = await deploy('curve', 'PonsV2BondingCurve', PONS_CURVE_ABI, PONS_CURVE_BYTECODE, [
    '0x0000000000000000000000000000000000000000', // pairToken: native ETH
    account.address, // deployer
    stub, // factory (stub)
    stub, // feePolicy (stub)
    {
      protocolFeeRecipient: account.address,
      protocolFeeShareBps: 3000,
      buybackBurnBps: 5000,
      hookFeeBps: 0,
      maxInternalPriceImpactBps: 300,
    },
    stub, // feeEscrow
    stub, // buybackVault
    parseEther('1.68'), // phantomQuote (same as $RYCORE mainnet)
    100n, // feeBps 1%
    200n, // creatorTaxBps 2%
    false, // buybackEnabled
    parseEther('4.2'), // graduationThreshold (same as mainnet)
  ]);

  const token = await deploy('token', 'PonsV2LauncherToken', PONS_TOKEN_ABI, PONS_TOKEN_BYTECODE, [
    'Test Pixflow',
    'TPIX',
    '',
    '',
    { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    account.address,
    curve,
    stub,
    1_000_000_000n * 10n ** 18n,
  ]);

  // Initialize the curve via the stub (skip if already initialized).
  const curveToken = await publicClient.readContract({
    address: curve,
    abi: PONS_CURVE_ABI,
    functionName: 'token',
  });
  if (curveToken.toLowerCase() !== token.toLowerCase()) {
    await sendTx('initializeTx', 'initializing curve via stub', stub, PONS_FACTORY_STUB_ABI, 'initializeCurve', [curve, token]);
  } else {
    console.log('curve already initialized');
  }

  // Register the launch in the stub's factory registry (M-01): the router
  // only accepts curves the factory registry knows.
  const registered = (await publicClient.readContract({
    address: stub,
    abi: PONS_FACTORY_STUB_ABI,
    functionName: 'getLaunchedToken',
    args: [token],
  })) as { curve: string };
  if (registered.curve.toLowerCase() !== curve.toLowerCase()) {
    await sendTx('registerTx', 'registering launch in the stub factory registry', stub, PONS_FACTORY_STUB_ABI, 'registerLaunch', [token, curve]);
  } else {
    console.log('launch already registered in the factory registry');
  }

  // Sanity: the curve must report the token + the mainnet parameters.
  const threshold = await publicClient.readContract({
    address: curve,
    abi: PONS_CURVE_ABI,
    functionName: 'graduationThreshold',
  });
  console.log(`  curve.token() OK; graduationThreshold = ${threshold} wei`);
  console.log('  factory registry OK: getLaunchedToken(token).curve == curve');

  const registry = await deploy('registry', 'CanonicalRegistry', REGISTRY_ABI, REGISTRY_BYTECODE, []);
  const router = await deploy('router', 'VerifiedBuyRouter', ROUTER_ABI, ROUTER_BYTECODE, [
    registry,
    account.address, // feeRecipient (testnet: deployer)
    stub, // ponsFactory (stub on testnet)
  ]);

  deployment.explorer = {
    stub: `${EXPLORER}/address/${stub}`,
    curve: `${EXPLORER}/address/${curve}`,
    token: `${EXPLORER}/address/${token}`,
    registry: `${EXPLORER}/address/${registry}`,
    router: `${EXPLORER}/address/${router}`,
  };
  save(deployment);
  console.log(`\nwrote ${OUT_FILE}`);
  console.log(`router: ${EXPLORER}/address/${router}`);
  console.log(`registry: ${EXPLORER}/address/${registry}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
