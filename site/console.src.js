/* Pixflow console — viem-based, Robinhood Chain mainnet (4663). Bundled with esbuild (see build-console.mjs).
   ABIs come from ../src/contracts.ts (generated, single source of truth). */
import {
  createPublicClient, createWalletClient, custom, http, fallback,
  parseEther, parseUnits, formatEther, formatUnits, isAddress, parseEventLogs,
} from 'viem';
import { ROUTER_ABI, REGISTRY_ABI, PONS_CURVE_ABI, PONS_FACTORY_ABI } from '../src/contracts.ts';
import { robinhoodMainnet } from '../src/chains.ts';

'use strict';

/* ================= CONFIG — MAINNET (4663) =================
   Live mainnet deploy, 19 Nov 2026. Router + registry deployed by the
   Pixflow deployer wallet; factory is the real Pons V2 factory. While
   any of them is the zero address the console shows "Mainnet contracts
   not deployed yet" and disables pre-flight + buys instead of crashing. */
var ROUTER = '0x7969f053107039b7f7ddf8446cd6c8b841c2faf9';
var REGISTRY = '0x37c8c967a32df1bc60a3244f29c187e385556ad3';
var FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'; // Pons V2 factory (mainnet)
/* ================= END CONFIG ================= */

var CHAIN_ID = 4663;
var CHAIN_HEX = '0x1237';
var EXPLORER = 'https://robinhoodchain.blockscout.com';
var RPCS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com',
];
var ZERO = '0x0000000000000000000000000000000000000000';
var FEE_BPS = 30n; // 0.3% — matches the router constant
var STATUS = ['UNRESOLVED', 'CANONICAL', 'CONTESTED']; // CanonicalRegistry.Status enum

var ERC20_ABI = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

function isDeployed() {
  return ROUTER !== ZERO && REGISTRY !== ZERO && FACTORY !== ZERO;
}

var publicClient = createPublicClient({ transport: fallback(RPCS.map(function (u) { return http(u); })) });
var MAINNET_CHAIN = {
  id: robinhoodMainnet.id,
  name: robinhoodMainnet.name,
  nativeCurrency: robinhoodMainnet.nativeCurrency,
  rpcUrls: { default: { http: RPCS } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
};
var walletClient = null;
var account = null;
var chainId = null;
var mode = 'address'; // 'address' | 'symbol'
var busy = false;
var preflight = null; // last pre-flight result
var lastQuote = 0n;   // last quoteBuy result (tokens, raw units)
var lastDecimals = 18;

/* ---------------- dom helpers ---------------- */
function $(id) { return document.getElementById(id); }
function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }
function txLink(hash) { return '<a href="' + EXPLORER + '/tx/' + hash + '" target="_blank" rel="noopener">' + shortAddr(hash) + ' ↗</a>'; }
function fmtEth(wei) {
  var s = formatEther(wei);
  var parts = s.split('.');
  var frac6 = (parts[1] || '0').slice(0, 6).padEnd(6, '0');
  if (parts[0] === '0' && /^0+$/.test(frac6)) {
    return '0.' + (parts[1] || '0').slice(0, 9).padEnd(9, '0') + ' ETH';
  }
  return parts[0] + '.' + frac6 + ' ETH';
}
function fmtTok(amount, decimals) {
  var s = formatUnits(amount, decimals);
  var parts = s.split('.');
  var whole = Number(parts[0]).toLocaleString('en-US');
  var frac = (parts[1] || '').replace(/0+$/, '').slice(0, 4);
  return frac ? whole + '.' + frac : whole;
}
function errMsg(e) {
  var m = (e && e.shortMessage) || (e && e.message) || String(e);
  return m.length > 220 ? m.slice(0, 220) + '…' : m;
}
function banner(id, html) {
  var el = $(id);
  if (!html) { el.classList.remove('show'); el.innerHTML = ''; return; }
  el.innerHTML = html;
  el.classList.add('show');
}
function logTx(html, cls) {
  var log = $('txlog');
  if (log.querySelector('div') && log.textContent.indexOf('No transactions yet') !== -1) log.innerHTML = '';
  var d = document.createElement('div');
  if (cls) d.className = cls;
  d.innerHTML = new Date().toLocaleTimeString('en-GB') + ' · ' + html;
  log.prepend(d);
}
function setVerdict(state, text) {
  var v = $('pf-verdict');
  v.classList.remove('pass', 'fail');
  var dot = v.querySelector('.verdict-dot');
  dot.classList.remove('idle', 'pass', 'fail');
  if (state === 'pass') { v.classList.add('pass'); dot.classList.add('pass'); }
  else if (state === 'fail') { v.classList.add('fail'); dot.classList.add('fail'); }
  else dot.classList.add('idle');
  $('pf-verdict-text').textContent = text;
}

/* ---------------- deploy status ---------------- */
function renderDeployStatus() {
  var deployed = isDeployed();
  var b = $('deploy-banner');
  if (deployed) { b.classList.remove('show'); }
  else { b.classList.add('show'); }
  $('btn-preflight').disabled = !deployed;
  $('btn-buy').disabled = true; // only enabled by a passing pre-flight
  $('pf-router-addr').textContent = ROUTER === ZERO ? 'not deployed' : ROUTER;
  $('pf-registry-addr').textContent = REGISTRY === ZERO ? 'not deployed' : REGISTRY;
  $('pf-factory-addr').textContent = FACTORY === ZERO ? 'not deployed' : FACTORY;
  $('foot-router').textContent = ROUTER === ZERO ? 'not deployed yet' : ROUTER;
  if (!deployed) setVerdict('idle', 'Pre-flight unavailable — mainnet contracts not deployed yet.');
}

/* ---------------- wallet ---------------- */
function renderWallet() {
  var st = $('wallet-status');
  var sw = $('btn-switch');
  if (!account) {
    st.innerHTML = 'Wallet not connected.';
    sw.style.display = 'none';
    return;
  }
  if (chainId === CHAIN_ID) {
    st.innerHTML = '<span class="ok">● Connected</span> <b>' + shortAddr(account) + '</b> · Robinhood Chain (4663)';
    sw.style.display = 'none';
  } else if (chainId === 46630) {
    st.innerHTML = '<span class="bad">● Testnet (46630)</span> <b>' + shortAddr(account) + '</b> · Pixflow is live on mainnet — switch to Robinhood Chain (4663).';
    sw.style.display = '';
  } else {
    st.innerHTML = '<span class="bad">● Wrong network</span> <b>' + shortAddr(account) + '</b> · chain ' + chainId + ' — Pixflow needs mainnet 4663.';
    sw.style.display = '';
  }
}
async function connect() {
  if (!window.ethereum) {
    banner('banner-err', 'No wallet detected. Install <a href="https://metamask.io/" target="_blank" rel="noopener">MetaMask ↗</a> (or any EIP-1193 wallet) and try again.');
    return;
  }
  try {
    var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) { banner('banner-err', 'No account was shared by the wallet.'); return; }
    account = accounts[0];
    chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }));
    walletClient = createWalletClient({ account: account, chain: MAINNET_CHAIN, transport: custom(window.ethereum) });
    banner('banner-err', '');
    renderWallet();
    await refreshFees();
    logTx('Wallet connected: ' + shortAddr(account), 't-ok');
  } catch (e) {
    banner('banner-err', 'Could not connect wallet: ' + errMsg(e));
  }
}
async function switchChain() {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (e) {
    if (e && e.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CHAIN_HEX, chainName: 'Robinhood Chain',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [RPCS[0]], blockExplorerUrls: [EXPLORER],
          }],
        });
      } catch (e2) { banner('banner-err', 'Could not add Robinhood Chain: ' + errMsg(e2)); }
    } else {
      banner('banner-err', 'Could not switch chain: ' + errMsg(e));
    }
  }
}
if (window.ethereum) {
  window.ethereum.on('accountsChanged', function (accs) {
    account = accs && accs.length ? accs[0] : null;
    if (account) walletClient = createWalletClient({ account: account, chain: MAINNET_CHAIN, transport: custom(window.ethereum) });
    renderWallet(); refreshFees();
  });
  window.ethereum.on('chainChanged', function (hex) {
    chainId = Number(hex);
    renderWallet();
  });
}

/* ---------------- pre-flight ----------------
   Read-only mirror of VerifiedBuyRouter._buy, in the same check order.
   NEVER sends a transaction. First failing check = the revert reason. */
var pfGen = 0;
function clearPreflight() {
  ['pf-token', 'pf-registry', 'pf-wash', 'pf-dev', 'pf-curve', 'pf-quote', 'pf-tax', 'pf-out', 'pf-fee', 'pf-cap']
    .forEach(function (id) { $(id).textContent = '—'; });
  preflight = null;
  lastQuote = 0n;
  $('btn-buy').disabled = true;
}
async function runPreflight() {
  if (!isDeployed()) {
    banner('banner-warn', 'Mainnet contracts not deployed yet — pre-flight is disabled until the deploy lands.');
    return null;
  }
  var gen = ++pfGen;
  banner('banner-err', '');
  banner('banner-warn', '');
  banner('banner-info', '');
  $('buy-result').style.display = 'none';
  clearPreflight();
  setVerdict('idle', 'Running pre-flight…');

  var target = $('buy-target').value.trim();
  var ethIn;
  try {
    ethIn = parseEther($('buy-eth').value.trim() === '' ? '0' : $('buy-eth').value.trim());
  } catch (e) {
    setVerdict('fail', 'Invalid ETH amount.');
    banner('banner-err', 'Enter a valid ETH amount to spend.');
    return null;
  }
  if (ethIn === 0n) {
    setVerdict('fail', 'ETH amount must be greater than zero.');
    return null;
  }
  if (!target) {
    setVerdict('fail', mode === 'address' ? 'Enter a token address.' : 'Enter a symbol (e.g. DCTY).');
    return null;
  }
  if (mode === 'address' && !isAddress(target)) {
    setVerdict('fail', 'That is not a valid token address.');
    return null;
  }

  try {
    // Resolve the token + its on-chain symbol.
    var token = null;
    var symbol = null;
    var entry = null;
    var symbolHash = null;
    if (mode === 'symbol') {
      symbol = target;
      symbolHash = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'symbolHashOf', args: [symbol] });
      entry = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'getEntry', args: [symbolHash] });
      token = entry.token;
      if (token === ZERO) {
        if (gen !== pfGen) return null;
        $('pf-token').textContent = 'no registry entry for "' + symbol + '"';
        $('pf-registry').innerHTML = '<span class="red">UNRESOLVED — no canonical token registered</span>';
        setVerdict('fail', 'BLOCKED — the router would revert NotCanonical: no canonical token is registered for this symbol.');
        preflight = { ok: false, reason: 'NotCanonical' };
        return preflight;
      }
    } else {
      token = target;
    }

    // Token metadata (symbol is the registry key — the router reads it from the token itself).
    var meta = await Promise.all([
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(function () { return null; }),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(function () { return null; }),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(function () { return 18; }),
    ]);
    if (gen !== pfGen) return null;
    if (meta[0] === null) {
      $('pf-token').textContent = shortAddr(token) + ' (no ERC-20 metadata — not a token?)';
      setVerdict('fail', 'BLOCKED — the router would revert InvalidToken: no contract with ERC-20 metadata at this address.');
      preflight = { ok: false, reason: 'InvalidToken' };
      return preflight;
    }
    symbol = meta[0];
    lastDecimals = Number(meta[2]);
    $('pf-token').textContent = (meta[1] || symbol) + ' (' + symbol + ') · ' + shortAddr(token);

    // Registry entry for the token's OWN symbol (same key the router uses).
    symbolHash = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'symbolHashOf', args: [symbol] });
    entry = await publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'getEntry', args: [symbolHash] });
    if (gen !== pfGen) return null;
    var statusName = STATUS[Number(entry.status)] || ('status ' + entry.status);
    $('pf-registry').innerHTML = entry.status === 1
      ? '<span class="cyan">CANONICAL ✓ — ' + shortAddr(entry.token) + '</span>'
      : entry.status === 2
        ? '<span class="amber">CONTESTED — the keeper refuses to guess</span>'
        : '<span class="red">UNRESOLVED — no verdict yet</span>';
    $('pf-wash').innerHTML = entry.washSuspect ? '<span class="red">FLAGGED — wash-suspect</span>' : '<span class="green">clear</span>';
    $('pf-dev').innerHTML = entry.devDumped ? '<span class="red">FLAGGED — dev dumped</span>' : '<span class="green">clear</span>';

    // Factory check (M-01): the factory registry is the ONLY authority for the curve.
    var launch = await publicClient.readContract({ address: FACTORY, abi: PONS_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] });
    if (gen !== pfGen) return null;
    if (!launch.exists || launch.curve === ZERO) {
      $('pf-curve').innerHTML = '<span class="red">not launched — the factory has no curve for this token</span>';
      setVerdict('fail', 'BLOCKED — the router would revert NotLaunched: the Pons factory has no record of this token.');
      preflight = { ok: false, reason: 'NotLaunched', token: token, symbol: symbol };
      return preflight;
    }
    var curveAddr = launch.curve;

    // Curve state.
    var curve = await Promise.all([
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'pairToken' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'graduated' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'readyToGraduate' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'launchedAt' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'snipeTaxSeconds' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'realQuoteReserve' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'graduationThreshold' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'getReserves' }),
      publicClient.readContract({ address: curveAddr, abi: PONS_CURVE_ABI, functionName: 'sellableTokens' }),
    ]);
    if (gen !== pfGen) return null;
    var pairToken = curve[0], graduated = curve[1], ready = curve[2];
    var launchedAt = curve[3], snipeSecs = curve[4];
    var realQuote = curve[5], threshold = curve[6];
    var progressBps = threshold > 0n ? Number((realQuote * 10000n) / threshold) : 0;
    $('pf-curve').innerHTML = shortAddr(curveAddr) + ' · ' + progressBps.toLocaleString('en-US') + ' bps'
      + (graduated ? ' · <span class="red">graduated</span>' : ready ? ' · <span class="red">ready to graduate — buys closed</span>' : ' · <span class="green">open</span>');
    $('pf-quote').textContent = pairToken === ZERO ? 'native ETH ✓' : 'token-quoted (' + shortAddr(pairToken) + ') — v1 supports native ETH only';

    // Chain time for the tax-window check.
    var block = await publicClient.getBlock();
    if (gen !== pfGen) return null;
    var now = block.timestamp;
    var windowEnd = launchedAt + snipeSecs;
    var windowPassed = now >= windowEnd;
    $('pf-tax').innerHTML = windowPassed
      ? '<span class="green">passed</span> — window was ' + snipeSecs.toString() + 's from launch'
      : '<span class="red">ACTIVE</span> — ends in ' + (windowEnd - now).toString() + 's (launched ' + launchedAt.toString() + ' + ' + snipeSecs.toString() + 's)';

    // Quote + cap from the router's own view functions.
    var fee = (ethIn * FEE_BPS) / 10000n;
    var net = ethIn - fee;
    var quote = await publicClient.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'quoteBuy', args: [curveAddr, net] });
    var cap = await publicClient.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'maxSpendFor', args: [curveAddr] });
    if (gen !== pfGen) return null;
    lastQuote = quote;
    $('pf-out').textContent = quote === 0n ? '0 (unpriceable)' : '≈ ' + fmtTok(quote, lastDecimals) + ' ' + symbol;
    $('pf-fee').textContent = fmtEth(fee) + ' (0.3% of ' + fmtEth(ethIn) + ')';
    $('pf-cap').textContent = cap === 0n
      ? 'no sellable allocation left'
      : net > cap
        ? 'CAPPED — ' + fmtEth(net) + ' net exceeds the ' + fmtEth(cap) + ' cap; the excess is refunded but the fee stays 0.3% of the full amount sent'
        : fmtEth(cap) + ' max spend — your ' + fmtEth(net) + ' net is under the cap';

    // Evaluate in router order — first failure is the revert reason.
    var fail = null;
    if (pairToken !== ZERO) fail = { reason: 'NonNativeQuote', text: 'BLOCKED — the router would revert NonNativeQuote: this curve is quoted in a token, not native ETH (v1 supports native-ETH curves only).' };
    else if (entry.status === 2) fail = { reason: 'Contested', text: 'BLOCKED — the router would revert Contested: the keeper marked this symbol contested and refuses to guess.' };
    else if (entry.status !== 1 || entry.token.toLowerCase() !== token.toLowerCase()) fail = { reason: 'NotCanonical', text: 'BLOCKED — the router would revert NotCanonical: this token is not the registered canonical token for ' + symbol + ' (status: ' + statusName + ').' };
    else if (entry.washSuspect) fail = { reason: 'WashSuspect', text: 'BLOCKED — the router would revert WashSuspect: the registry flagged this symbol for wash trading.' };
    else if (entry.devDumped) fail = { reason: 'DevDumped', text: 'BLOCKED — the router would revert DevDumped: the registry flagged this symbol — the dev dumped.' };
    else if (graduated || ready) fail = { reason: 'CurveClosed', text: 'BLOCKED — the router would revert CurveClosed: this curve is ' + (graduated ? 'graduated' : 'ready to graduate') + ', buys are closed.' };
    else if (!windowPassed) fail = { reason: 'TaxWindow', text: 'BLOCKED — the router would revert TaxWindow: the snipe-tax window is still active for ' + (windowEnd - now).toString() + 's.' };
    else if (quote === 0n || cap === 0n) fail = { reason: 'QuoteUnavailable', text: 'BLOCKED — the router would revert QuoteUnavailable: the curve cannot price this buy right now (empty reserves or no sellable allocation).' };

    var minOut = 0n;
    try {
      var minStr = $('buy-min').value.trim();
      minOut = minStr === '' ? 0n : parseUnits(minStr, lastDecimals);
    } catch (e) {
      setVerdict('fail', 'Invalid minimum-tokens-out value.');
      banner('banner-err', 'Minimum tokens out must be a valid number.');
      return null;
    }
    if (!fail && minOut > quote) {
      fail = { reason: 'SlippageExceeded', text: 'BLOCKED — the router would revert SlippageExceeded: your minimum (' + fmtTok(minOut, lastDecimals) + ' ' + symbol + ') is above the current quote (' + fmtTok(quote, lastDecimals) + ' ' + symbol + '). Lower it or use "Quote −1%".' };
    }

    if (fail) {
      setVerdict('fail', fail.text);
      $('btn-buy').disabled = true;
      preflight = { ok: false, reason: fail.reason, token: token, symbol: symbol, curve: curveAddr, quote: quote.toString() };
      return preflight;
    }
    var capped = net > cap;
    setVerdict('pass', 'PASS — all checks green. The buy should execute' + (capped ? ' (capped at the remaining allocation — excess ETH refunded, fee still 0.3% of the full amount sent)' : '') + '.');
    $('btn-buy').disabled = false;
    preflight = { ok: true, token: token, symbol: symbol, curve: curveAddr, quote: quote.toString(), fee: fee.toString(), capped: capped };
    return preflight;
  } catch (e) {
    if (gen !== pfGen) return null;
    setVerdict('fail', 'Pre-flight failed to read chain state: ' + errMsg(e));
    preflight = { ok: false, reason: 'read-error' };
    return preflight;
  }
}

/* ---------------- transactions ---------------- */
function requireReady() {
  if (!account) { banner('banner-err', 'Connect your wallet first.'); return false; }
  if (chainId !== CHAIN_ID) { banner('banner-err', 'Switch to Robinhood Chain (4663) first — the button is at the top.'); return false; }
  if (!isDeployed()) { banner('banner-err', 'Mainnet contracts not deployed yet.'); return false; }
  return true;
}
async function sendTx(label, fn) {
  var hash = await fn();
  logTx(label + ' sent: ' + txLink(hash));
  var receipt = await publicClient.waitForTransactionReceipt({ hash: hash });
  if (receipt.status !== 'success') {
    logTx(label + ' REVERTED: ' + txLink(hash), 't-err');
    throw new Error(label + ' transaction reverted on-chain (' + hash.slice(0, 10) + '…)');
  }
  logTx(label + ' confirmed: ' + txLink(hash), 't-ok');
  return { hash: hash, receipt: receipt };
}
async function buyFlow() {
  if (busy) return;
  if (!requireReady()) return;
  // Fresh pre-flight right before signing — state may have moved since the last check.
  var pf = await runPreflight();
  if (!pf || !pf.ok) {
    banner('banner-err', 'Buy blocked: pre-flight did not pass. See the verdict above.');
    return;
  }
  var ethIn, minOut;
  try {
    ethIn = parseEther($('buy-eth').value.trim());
    var minStr = $('buy-min').value.trim();
    minOut = minStr === '' ? 0n : parseUnits(minStr, lastDecimals);
  } catch (e) {
    banner('banner-err', 'Check your numbers: ETH amount and minimum tokens out must be valid.');
    return;
  }
  if (ethIn === 0n) { banner('banner-err', 'ETH amount must be greater than zero.'); return; }
  busy = true;
  $('btn-buy').disabled = true;
  $('btn-buy').innerHTML = '<span class="spin"></span> Buying…';
  banner('banner-err', '');
  try {
    var target = $('buy-target').value.trim();
    var res = await sendTx('Buy verified ' + pf.symbol, function () {
      if (mode === 'symbol') {
        return walletClient.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'buyVerifiedBySymbol', args: [target, minOut], value: ethIn, account: account });
      }
      return walletClient.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'buyVerified', args: [pf.token, minOut], value: ethIn, account: account });
    });
    // Decode the BuyVerified event for the exact outcome.
    var detail = '';
    try {
      var events = parseEventLogs({ abi: ROUTER_ABI, logs: res.receipt.logs, eventName: 'BuyVerified' });
      if (events.length) {
        var ev = events[0].args;
        detail = '<br>Received <b>' + fmtTok(ev.tokensReceived, lastDecimals) + ' ' + pf.symbol + '</b> · spent ' + fmtEth(ev.ethSpent)
          + ' · fee ' + fmtEth(ev.fee) + (ev.refund > 0n ? ' · refunded ' + fmtEth(ev.refund) : '');
      }
    } catch (e) { /* event decode is a nicety — the receipt already proves the buy */ }
    var box = $('buy-result');
    box.className = 'result';
    box.innerHTML = '<b>✓ Verified buy confirmed.</b> ' + txLink(res.hash) + detail;
    box.style.display = '';
    banner('banner-info', 'Verified buy confirmed — tokens went straight to your wallet.');
    await runPreflight();
    await refreshFees();
  } catch (e) {
    var box = $('buy-result');
    box.className = 'result fail';
    box.innerHTML = '<b>Buy failed:</b> ' + errMsg(e);
    box.style.display = '';
    banner('banner-err', 'Buy failed: ' + errMsg(e));
  } finally {
    busy = false;
    $('btn-buy').disabled = !(preflight && preflight.ok);
    $('btn-buy').textContent = 'Buy verified';
  }
}

/* ---------------- fees (pull-based) ---------------- */
async function refreshFees() {
  var bar = $('fees-bar');
  if (!account || !isDeployed()) { bar.style.display = 'none'; return; }
  try {
    var owed = await publicClient.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'feesOwed', args: [account] });
    if (owed > 0n) {
      $('fees-owed').textContent = fmtEth(owed);
      bar.style.display = '';
    } else {
      bar.style.display = 'none';
    }
  } catch (e) {
    bar.style.display = 'none';
  }
}
async function claimFeesFlow() {
  if (busy) return;
  if (!account) { await connect(); if (!account) return; }
  if (!requireReady()) return;
  busy = true;
  try {
    await sendTx('Claim fees', function () {
      return walletClient.writeContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'claimFees', args: [], account: account });
    });
    banner('banner-info', 'Fees claimed — the accrued 0.3% is on its way to your wallet.');
    await refreshFees();
  } catch (e) {
    banner('banner-err', 'Claim failed: ' + errMsg(e));
  } finally { busy = false; }
}

/* ---------------- wiring ---------------- */
$('btn-connect').addEventListener('click', connect);
$('btn-switch').addEventListener('click', switchChain);
$('btn-preflight').addEventListener('click', runPreflight);
$('btn-buy').addEventListener('click', buyFlow);
$('btn-claim-fees').addEventListener('click', claimFeesFlow);
$('btn-min-quote').addEventListener('click', function () {
  if (lastQuote === 0n) {
    banner('banner-warn', 'Run pre-flight first to get a quote.');
    return;
  }
  var min = (lastQuote * 99n) / 100n;
  $('buy-min').value = formatUnits(min, lastDecimals);
  runPreflight();
});
document.querySelectorAll('#mode-seg button').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('#mode-seg button').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    mode = b.getAttribute('data-mode');
    if (mode === 'symbol') {
      $('target-label').textContent = 'Symbol';
      $('buy-target').placeholder = 'DCTY';
      $('target-hint').textContent = 'Exact on-chain symbol (case-sensitive). The registry resolves it to the canonical token — if the symbol is contested or unresolved, the buy reverts.';
    } else {
      $('target-label').textContent = 'Token address';
      $('buy-target').placeholder = '0x…';
      $('target-hint').textContent = 'The token you want to buy. The router verifies it is the registered canonical token for its own on-chain symbol.';
    }
    $('buy-target').value = '';
    clearPreflight();
    setVerdict('idle', 'Pre-flight not run yet.');
  });
});
var pfTimer = null;
['buy-target', 'buy-eth', 'buy-min'].forEach(function (id) {
  $(id).addEventListener('input', function () {
    clearTimeout(pfTimer);
    if (!isDeployed()) return;
    if ($('buy-target').value.trim() === '') return;
    pfTimer = setTimeout(runPreflight, 600);
  });
});

/* read-only test hook (no keys, no writes) — lets automated checks observe state */
window.__pixflow = {
  get account() { return account; },
  get chainId() { return chainId; },
  get deployed() { return isDeployed(); },
  get router() { return ROUTER; },
  get registry() { return REGISTRY; },
  get factory() { return FACTORY; },
  get preflight() { return preflight; },
};

/* ---------------- init ---------------- */
renderDeployStatus();
renderWallet();
window.__shotReady = true;
