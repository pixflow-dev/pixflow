/**
 * Pixflow keeper CLI — Node wrapper around src/keeper.ts.
 *
 * Usage:
 *   # Single pass (exit after one scan):
 *   npx tsx scripts/run-keeper.ts --once
 *
 *   # Watch mode (repeat every POLL_INTERVAL_MS, default 60000):
 *   npx tsx scripts/run-keeper.ts --watch
 *
 *   # Resolve + write evidence bundles without sending transactions:
 *   npx tsx scripts/run-keeper.ts --once --dry-run
 *
 * Env:
 *   KEEPER_RPC_URL        (default: https://rpc.testnet.chain.robinhood.com)
 *   KEEPER_CHAIN_ID       (default: 46630; mainnet 4663 needs KEEPER_ALLOW_MAINNET=1)
 *   KEEPER_REGISTRY       registry address (default: read from data/testnet-deployment.json)
 *   KEEPER_SYMBOLS        comma-separated symbols (default: "DCTY,MEOW")
 *   KEEPER_KEY_FILE       JSON file with a `privateKey` field
 *                         (default: ~/workspace/rycore/data/testnet-deployer.json)
 *   KEEPER_PRIVATE_KEY    alternative to KEEPER_KEY_FILE (env var wins if both set)
 *   POLL_INTERVAL_MS      watch-mode interval (default: 60000)
 *   KEEPER_EVIDENCE_DIR   evidence bundle dir (default: <repo>/data/evidence)
 *
 * Safety: this script REFUSES mainnet (chain 4663) unless
 * KEEPER_ALLOW_MAINNET=1 is set explicitly. Fase 2 is testnet-only.
 * The keeper key is NEVER printed.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import { runKeeperOnce, type KeeperConfig } from '../src/keeper.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Mainnet guard — exported so tests can cover it without running the CLI. */
export function assertChainAllowed(chainId: number, allowMainnet: boolean): void {
  if (chainId === 4663 && !allowMainnet) {
    throw new Error(
      'REFUSING mainnet: set KEEPER_ALLOW_MAINNET=1 to run the keeper on chain 4663.',
    );
  }
}

export interface KeeperCliArgs {
  once: boolean;
  watch: boolean;
  dryRun: boolean;
}

/** Argument parsing — exported so tests can cover it without running the CLI. */
export function parseKeeperArgs(args: string[]): KeeperCliArgs {
  const once = args.includes('--once');
  const watch = args.includes('--watch');
  const dryRun = args.includes('--dry-run');
  if (!once && !watch) {
    throw new Error('usage: run-keeper.ts --once | --watch [--dry-run]');
  }
  if (once && watch) {
    throw new Error('usage: pass exactly one of --once or --watch');
  }
  return { once, watch, dryRun };
}

function readPrivateKey(): Hex | undefined {
  if (process.env.KEEPER_PRIVATE_KEY) return process.env.KEEPER_PRIVATE_KEY as Hex;
  const keyFile =
    process.env.KEEPER_KEY_FILE ??
    path.join(process.env.HOME ?? '', 'workspace', 'rycore', 'data', 'testnet-deployer.json');
  if (!existsSync(keyFile)) return undefined;
  const data = JSON.parse(readFileSync(keyFile, 'utf8'));
  if (typeof data.privateKey !== 'string') return undefined;
  return data.privateKey as Hex;
}

function readRegistryAddress(): Address {
  if (process.env.KEEPER_REGISTRY) return process.env.KEEPER_REGISTRY as Address;
  const deploymentFile = path.join(root, 'data', 'testnet-deployment.json');
  if (!existsSync(deploymentFile)) {
    throw new Error(
      'no registry address configured: set KEEPER_REGISTRY or deploy first (npm run deploy:testnet)',
    );
  }
  const data = JSON.parse(readFileSync(deploymentFile, 'utf8'));
  const address = data.registry ?? data.registryAddress ?? data.CanonicalRegistry;
  if (typeof address !== 'string' || !address.startsWith('0x')) {
    throw new Error(
      `no registry address configured: ${deploymentFile} has no registry field — set KEEPER_REGISTRY`,
    );
  }
  return address as Address;
}

function readSymbols(): string[] {
  const raw = process.env.KEEPER_SYMBOLS ?? 'DCTY,MEOW';
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  if (symbols.length === 0) throw new Error('no symbols configured: set KEEPER_SYMBOLS');
  return symbols;
}

async function main() {
  let args: KeeperCliArgs;
  try {
    args = parseKeeperArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  const { dryRun, watch } = args;

  const chainId = Number(process.env.KEEPER_CHAIN_ID ?? 46630);
  try {
    assertChainAllowed(chainId, process.env.KEEPER_ALLOW_MAINNET === '1');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  let config: KeeperConfig;
  try {
    config = {
      rpcUrl: process.env.KEEPER_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com',
      chainId,
      registryAddress: readRegistryAddress(),
      keeperPrivateKey: dryRun ? undefined : readPrivateKey(),
      symbols: readSymbols(),
      evidenceDir: process.env.KEEPER_EVIDENCE_DIR ?? path.join(root, 'data', 'evidence'),
      dryRun,
    };
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  if (!dryRun && !config.keeperPrivateKey) {
    console.error('no keeper key: set KEEPER_PRIVATE_KEY or KEEPER_KEY_FILE (or use --dry-run).');
    process.exit(2);
  }

  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60_000);

  async function pass() {
    const started = Date.now();
    try {
      const report = await runKeeperOnce(config);
      const stamp = new Date().toISOString();
      console.log(
        `[${stamp}] chain ${report.chainId} symbols=${report.counts.symbols} ` +
          `resolved=${report.counts.resolved} contested=${report.counts.contested} ` +
          `unresolved=${report.counts.unresolved} actions=${report.counts.actionsPlanned} ` +
          `executed=${report.counts.actionsExecuted} failed=${report.counts.failed} ` +
          `(${Date.now() - started}ms)${dryRun ? ' DRY RUN' : ''}`,
      );
      for (const s of report.symbols) {
        const token = s.canonicalToken ? ` token ${s.canonicalToken}` : '';
        console.log(
          `  ${s.symbol}: ${s.verdict} cohort=${s.cohortSize}${token}` +
            (s.evidenceFile ? ` evidence=${s.evidenceFile}` : '') +
            (s.error ? ` ERROR: ${s.error}` : ''),
        );
        for (const a of s.executed) {
          console.log(
            `    ${a.dryRun ? '[planned]' : '[sent]'} ${a.kind}` +
              (a.txHash ? ` tx ${a.txHash}` : '') +
              (a.error ? ` FAILED: ${a.error}` : ''),
          );
        }
      }
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] keeper pass failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await pass();
  if (watch) {
    console.log(`watching every ${intervalMs}ms — Ctrl+C to stop`);
    setInterval(pass, intervalMs);
  }
}

// Only run when invoked directly — importing this module (e.g. from
// tests that cover assertChainAllowed / parseKeeperArgs) must not
// start a keeper pass.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
