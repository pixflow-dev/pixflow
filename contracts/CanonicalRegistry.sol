// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * @title CanonicalRegistry
 * @notice Keeper-maintained on-chain registry of canonical Pons V2 tokens,
 * keyed by keccak256(symbol). The VerifiedBuyRouter consults this registry
 * before every buy; the registry is the ONLY place where "which token is
 * the real DCTY?" is answered on-chain.
 *
 * WHAT THE REGISTRY IS (and is not):
 * - It records the KEEPER's verdict, computed OFF-CHAIN from on-chain
 *   facts only: earliest deployed_at + progress dominance + socials match
 *   (website/X in the token metadata vs the narrative source) + graduation
 *   status. See DESIGN.md for the resolver rules. The contract does NOT
 *   verify those facts itself — it cannot (socials are not on-chain).
 * - A registry entry is therefore a signed claim by the keeper, made
 *   transparent and auditable: every change is an event, and every change
 *   in the FAIL-OPEN direction (naming a new canonical token, clearing a
 *   wash/dev flag) waits out a 1-hour timelock first, so anyone can see
 *   it coming and the keeper cannot silently re-point a symbol at a clone.
 *
 * ASYMMETRIC TIMELOCK (the key safety property):
 * - FAIL-CLOSED actions are IMMEDIATE: contesting a symbol, or flagging
 *   wash-trading / dev-dump, takes effect in the same transaction. These
 *   can only BLOCK buys, never force one — when a dev is dumping NOW, the
 *   registry must be able to stop buys NOW, not in an hour.
 * - FAIL-OPEN actions are TIMELOCKED (1 hour): naming a canonical token,
 *   or clearing flags. These UNBLOCK buys, so they wait — and any
 *   fail-closed action taken while a proposal is pending CANCELS that
 *   proposal, so a flag raised after a proposal can never be silently
 *   cleared by the proposal executing later.
 *
 * CENTRALIZATION, STATED PLAINLY: the keeper (owner) is a trust point.
 * A compromised or malicious keeper CAN re-point a symbol at a clone
 * (after the 1h timelock, in full public view) or DoS the router by
 * flagging everything. What the keeper CANNOT do: steal user funds
 * (funds never leave a buyer's wallet unless a buy executes, and a buy
 * always sends tokens to the buyer), or force a buy the router's other
 * checks reject. Production ownership SHOULD be a multisig; the deployer
 * is the owner only until that handover happens (two-step transfer).
 */
contract CanonicalRegistry {
    enum Status {
        UNRESOLVED, // 0 — default: no entry (or never resolved). Buys revert.
        CANONICAL, // This token IS the real one for the symbol. Buys allowed (subject to flags).
        CONTESTED // Genuinely ambiguous (MEOW, TAURO). Buys revert — revert, don't guess.

    }

    struct Entry {
        address token; // canonical token for the symbol (address(0) if none)
        Status status;
        uint64 launchedAt; // keeper-recorded deploy timestamp of the token (evidence; the ROUTER's snipe-tax check reads the curve's own launchedAt, not this)
        bool washSuspect; // abnormal trade/progress ratio (PARIMATCH pattern)
        bool devDumped; // dev sold the majority of their position
        bytes32 evidenceHash; // hash of the off-chain resolver evidence bundle (IPFS CID hash, or keccak of the evidence JSON)
        uint64 updatedAt; // last entry change (block timestamp)
    }

    struct PendingUpdate {
        address token; // new canonical token (address(0) = keep current token)
        uint64 launchedAt;
        bytes32 evidenceHash;
        bool clearFlags; // if true, executing clears washSuspect + devDumped
        uint64 executableAt; // earliest execution time (proposal time + TIMELOCK_DELAY)
        bool exists;
    }

    uint256 public constant TIMELOCK_DELAY = 1 hours;

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error InvalidToken();
    error InvalidTimestamp();
    error NoPendingUpdate();
    error TimelockNotExpired(uint256 executableAt, uint256 now_);

    event CanonicalProposed(
        bytes32 indexed symbolHash, address indexed token, uint64 launchedAt, bytes32 evidenceHash, uint256 executableAt
    );
    event FlagsClearProposed(bytes32 indexed symbolHash, bytes32 evidenceHash, uint256 executableAt);
    event UpdateExecuted(
        bytes32 indexed symbolHash, address indexed token, Status status, bytes32 evidenceHash, bool flagsCleared
    );
    event ProposalCancelled(bytes32 indexed symbolHash);
    event Contested(bytes32 indexed symbolHash, bytes32 evidenceHash);
    event WashFlagged(bytes32 indexed symbolHash, bytes32 evidenceHash);
    event DevDumpFlagged(bytes32 indexed symbolHash, bytes32 evidenceHash);
    event OwnershipTransferRequested(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferAccepted(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;

    mapping(bytes32 symbolHash => Entry) private _entries;
    mapping(bytes32 symbolHash => PendingUpdate) private _pending;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Registry key for a symbol: keccak256 of the EXACT on-chain
     * symbol string (case-sensitive — "DCTY" != "dcty"). The router hashes
     * the token's own symbol() return, so the keeper must register the
     * exact symbol the token reports.
     */
    function symbolHashOf(string calldata symbol) public pure returns (bytes32) {
        return keccak256(bytes(symbol));
    }

    function getEntry(bytes32 symbolHash) external view returns (Entry memory) {
        return _entries[symbolHash];
    }

    function getPending(bytes32 symbolHash) external view returns (PendingUpdate memory) {
        return _pending[symbolHash];
    }

    /**
     * @notice Propose a canonical token for a symbol. TIMELOCKED: executes
     * no earlier than 1 hour after this call. Replaces any pending proposal
     * for the symbol (new 1h clock) — the latest proposal is the only one
     * that can execute, so a stale proposal can never surprise anyone.
     * @dev The token must already be a contract (a canonical token that
     * does not exist yet cannot be bought). The proposal does NOT check
     * that the token is a Pons launch — that is the router's job at buy
     * time (factory registry check), not the registry's.
     */
    function proposeCanonical(bytes32 symbolHash, address token, uint64 launchedAt, bytes32 evidenceHash)
        external
        onlyOwner
    {
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (launchedAt == 0) revert InvalidTimestamp();
        _pending[symbolHash] = PendingUpdate({
            token: token,
            launchedAt: launchedAt,
            evidenceHash: evidenceHash,
            clearFlags: true, // a new canonical token gets a fresh assessment
            executableAt: uint64(block.timestamp + TIMELOCK_DELAY),
            exists: true
        });
        emit CanonicalProposed(symbolHash, token, launchedAt, evidenceHash, block.timestamp + TIMELOCK_DELAY);
    }

    /**
     * @notice Propose clearing the wash/dev flags on a symbol (e.g. the
     * keeper's investigation cleared the token). TIMELOCKED like any
     * fail-open action: clearing a flag unblocks buys.
     */
    function proposeClearFlags(bytes32 symbolHash, bytes32 evidenceHash) external onlyOwner {
        _pending[symbolHash] = PendingUpdate({
            token: address(0), // keep current token
            launchedAt: 0,
            evidenceHash: evidenceHash,
            clearFlags: true,
            executableAt: uint64(block.timestamp + TIMELOCK_DELAY),
            exists: true
        });
        emit FlagsClearProposed(symbolHash, evidenceHash, block.timestamp + TIMELOCK_DELAY);
    }

    /**
     * @notice Execute a pending update after its timelock expires.
     * PERMISSIONLESS — anyone may execute; the timelock, not the caller,
     * is the protection. If the proposal names a token, the entry becomes
     * CANONICAL for that token with fresh (cleared) flags; otherwise the
     * token/status are untouched and only the flags clear.
     */
    function executeUpdate(bytes32 symbolHash) external {
        PendingUpdate memory p = _pending[symbolHash];
        if (!p.exists) revert NoPendingUpdate();
        if (block.timestamp < p.executableAt) revert TimelockNotExpired(p.executableAt, block.timestamp);
        delete _pending[symbolHash];

        Entry storage e = _entries[symbolHash];
        bool flagsCleared = false;
        if (p.token != address(0)) {
            e.token = p.token;
            e.launchedAt = p.launchedAt;
            e.status = Status.CANONICAL;
        }
        if (p.clearFlags) {
            e.washSuspect = false;
            e.devDumped = false;
            flagsCleared = true;
        }
        e.evidenceHash = p.evidenceHash;
        e.updatedAt = uint64(block.timestamp);
        emit UpdateExecuted(symbolHash, e.token, e.status, p.evidenceHash, flagsCleared);
    }

    /**
     * @notice Cancel a pending proposal. Owner-only (a proposal is the
     * keeper's own work product; cancelling it is fail-closed).
     */
    function cancelProposal(bytes32 symbolHash) external onlyOwner {
        if (!_pending[symbolHash].exists) revert NoPendingUpdate();
        delete _pending[symbolHash];
        emit ProposalCancelled(symbolHash);
    }

    /**
     * @notice Mark a symbol CONTESTED — IMMEDIATE. Use when the canonical
     * token is genuinely ambiguous (two live claims, squatter vs real
     * project). Buys revert until a new canonical is proposed + timelocked.
     * Cancels any pending proposal: a contest raised after a proposal must
     * not be silently undone by that proposal executing later.
     */
    function contest(bytes32 symbolHash, bytes32 evidenceHash) external onlyOwner {
        _cancelPending(symbolHash);
        Entry storage e = _entries[symbolHash];
        e.status = Status.CONTESTED;
        e.evidenceHash = evidenceHash;
        e.updatedAt = uint64(block.timestamp);
        emit Contested(symbolHash, evidenceHash);
    }

    /**
     * @notice Flag a symbol as wash-trading suspect — IMMEDIATE. Cancels
     * any pending proposal (same reason as contest()).
     */
    function flagWash(bytes32 symbolHash, bytes32 evidenceHash) external onlyOwner {
        _cancelPending(symbolHash);
        Entry storage e = _entries[symbolHash];
        e.washSuspect = true;
        e.evidenceHash = evidenceHash;
        e.updatedAt = uint64(block.timestamp);
        emit WashFlagged(symbolHash, evidenceHash);
    }

    /**
     * @notice Flag a symbol as dev-dumped — IMMEDIATE. Cancels any pending
     * proposal (same reason as contest()).
     */
    function flagDevDump(bytes32 symbolHash, bytes32 evidenceHash) external onlyOwner {
        _cancelPending(symbolHash);
        Entry storage e = _entries[symbolHash];
        e.devDumped = true;
        e.evidenceHash = evidenceHash;
        e.updatedAt = uint64(block.timestamp);
        emit DevDumpFlagged(symbolHash, evidenceHash);
    }

    /**
     * @notice Two-step ownership transfer (the registry owner is a trust
     * point, so a fat-fingered address must not strand it).
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferRequested(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferAccepted(previousOwner, owner);
    }

    /**
     * @notice Fail-closed actions cancel pending proposals silently (no
     * event of their own — the flag/contest event IS the notice). Internal
     * helper: cancelProposal() above is the explicit, owner-only path with
     * its own event.
     */
    function _cancelPending(bytes32 symbolHash) private {
        if (_pending[symbolHash].exists) delete _pending[symbolHash];
    }
}

/**
 * @notice Minimal view of the registry for the router. The router only
 * ever READS the registry — it cannot write it, so a router bug can
 * never corrupt canonical data.
 */
interface ICanonicalRegistry {
    function getEntry(bytes32 symbolHash) external view returns (CanonicalRegistry.Entry memory);
}
