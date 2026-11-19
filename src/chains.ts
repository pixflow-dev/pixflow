/**
 * Robinhood Chain definitions for viem (mainnet 4663 + testnet 46630).
 * Fase 2 is TESTNET-ONLY unless explicitly enabled; the mainnet
 * definition exists so the keeper and deploy scripts need no code
 * change when mainnet is explicitly enabled.
 */
import type { Chain } from 'viem';

export const robinhoodMainnet: Chain = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
};

export const robinhoodTestnet: Chain = {
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
};

export function chainForId(chainId: number): Chain {
  if (chainId === 4663) return robinhoodMainnet;
  if (chainId === 46630) return robinhoodTestnet;
  throw new Error(`unsupported chain id: ${chainId} (expected 4663 or 46630)`);
}
