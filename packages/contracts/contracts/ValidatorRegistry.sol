// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @dev Minimal interface to the AXIS token surface used by the registry.
 */
interface IAXISToken {
    function mint(address to, uint256 workload, uint256 quality) external returns (uint256);
    function setDifficulty(uint256 newDifficulty) external;
    function totalMinted() external view returns (uint256);
    function difficulty() external view returns (uint256);
}

/**
 * @title ValidatorRegistry
 * @author AXIS AI Protocol
 * @notice Holds the set of approved validator addresses for the AXIS protocol
 *         and is the ONLY contract permitted to mint AXIS or change difficulty.
 *
 *         Operational rules:
 *           - Any single approved validator may submit a verified work proof,
 *             which mints the PoAIW reward to the miner (normal operation).
 *           - Validators may only be ADDED or REMOVED, and difficulty may only
 *             be CHANGED, through a supermajority (> 66%) vote of the current
 *             validator set. No single wallet has unilateral control over the
 *             validator set or difficulty.
 *
 *         Every addition, removal, proposal and vote emits an event.
 *
 * @dev    Immutable: no owner, no admin, no upgrade path. The token address is
 *         bound exactly once, immediately after deployment, via {initializeToken}.
 */
contract ValidatorRegistry is ReentrancyGuard {
    // --------------------------------------------------------------------- //
    //                                 TYPES                                 //
    // --------------------------------------------------------------------- //

    /// @notice The kind of governance action a proposal performs.
    enum ProposalType {
        AddValidator,
        RemoveValidator,
        SetDifficulty
    }

    /// @notice A governance proposal requiring supermajority approval.
    struct Proposal {
        ProposalType proposalType;
        address targetAddress; // validator to add/remove (unused for difficulty)
        uint256 value; // new difficulty (unused for add/remove)
        uint256 yesVotes;
        bool executed;
        uint256 createdAt;
        address proposer;
    }

    // --------------------------------------------------------------------- //
    //                                STATE                                  //
    // --------------------------------------------------------------------- //

    /// @notice The AXIS token governed by this registry. Set once.
    IAXISToken public token;
    bool public tokenInitialized;

    /// @notice Validator membership flags.
    mapping(address => bool) public isValidator;

    /// @notice Enumerable list of all addresses ever added (membership via flag).
    address[] private _validatorList;

    /// @notice Count of currently active validators.
    uint256 public validatorCount;

    /// @notice All governance proposals, indexed by id.
    mapping(uint256 => Proposal) public proposals;

    /// @notice Per-proposal vote tracking to prevent double voting.
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    /// @notice Total number of proposals created.
    uint256 public proposalCount;

    // --------------------------------------------------------------------- //
    //                                EVENTS                                 //
    // --------------------------------------------------------------------- //

    event TokenInitialized(address indexed token);
    event ValidatorAdded(address indexed validator, uint256 newValidatorCount);
    event ValidatorRemoved(address indexed validator, uint256 newValidatorCount);
    event WorkSubmitted(
        address indexed validator,
        address indexed miner,
        uint256 workload,
        uint256 quality,
        uint256 mintedAmount
    );
    event ProposalCreated(
        uint256 indexed proposalId,
        ProposalType indexed proposalType,
        address indexed proposer,
        address targetAddress,
        uint256 value
    );
    event VoteCast(uint256 indexed proposalId, address indexed validator, uint256 yesVotes);
    event ProposalExecuted(uint256 indexed proposalId, ProposalType indexed proposalType);

    // --------------------------------------------------------------------- //
    //                              MODIFIERS                                //
    // --------------------------------------------------------------------- //

    /// @dev Restricts a function to currently approved validators.
    modifier onlyValidator() {
        require(isValidator[msg.sender], "Registry: caller not validator");
        _;
    }

    // --------------------------------------------------------------------- //
    //                             CONSTRUCTOR                               //
    // --------------------------------------------------------------------- //

    /**
     * @notice Bootstraps the registry with an initial validator set.
     * @param initialValidators The genesis validator addresses. Must be
     *        non-empty and contain no zero or duplicate addresses.
     * @dev   Supermajority math means a single bootstrap validator can act
     *        alone until additional validators are voted in; thereafter
     *        > 66% of the live set is required for every membership change.
     */
    constructor(address[] memory initialValidators) {
        require(initialValidators.length > 0, "Registry: no initial validators");
        for (uint256 i = 0; i < initialValidators.length; i++) {
            address v = initialValidators[i];
            require(v != address(0), "Registry: zero validator");
            require(!isValidator[v], "Registry: duplicate validator");
            isValidator[v] = true;
            _validatorList.push(v);
            validatorCount++;
            emit ValidatorAdded(v, validatorCount);
        }
    }

    /**
     * @notice Binds the AXIS token to this registry exactly once.
     * @param _token The deployed AXISToken address.
     * @dev   Callable by any validator, but only while uninitialised. After the
     *        first successful call the binding is permanent.
     */
    function initializeToken(address _token) external onlyValidator {
        require(!tokenInitialized, "Registry: token already set");
        require(_token != address(0), "Registry: token is zero");
        token = IAXISToken(_token);
        tokenInitialized = true;
        emit TokenInitialized(_token);
    }

    // --------------------------------------------------------------------- //
    //                          WORK SUBMISSION                             //
    // --------------------------------------------------------------------- //

    /**
     * @notice Submits a verified PoAIW proof, minting the reward to the miner.
     *         Callable by ANY single approved validator (normal operation).
     * @param miner    The wallet that performed the verified work.
     * @param workload `W` — verified workload units.
     * @param quality  `Q` — quality score 0..100.
     * @return minted The amount of AXIS minted to the miner.
     * @dev    Reentrancy-guarded; the external mint call is the only outward
     *         call and all preconditions are enforced by the token.
     */
    function submitWork(
        address miner,
        uint256 workload,
        uint256 quality
    ) external onlyValidator nonReentrant returns (uint256 minted) {
        require(tokenInitialized, "Registry: token not set");
        minted = token.mint(miner, workload, quality);
        emit WorkSubmitted(msg.sender, miner, workload, quality, minted);
        return minted;
    }

    // --------------------------------------------------------------------- //
    //                            GOVERNANCE                                //
    // --------------------------------------------------------------------- //

    /**
     * @notice Creates a governance proposal. The proposer's YES vote is cast
     *         automatically. If that single vote already meets the supermajority
     *         threshold (e.g. a one-validator bootstrap network), the proposal
     *         executes immediately.
     * @param proposalType  The action type.
     * @param targetAddress The validator to add/remove (ignored for difficulty).
     * @param value         The new difficulty (ignored for add/remove).
     * @return proposalId The id of the created proposal.
     */
    function createProposal(
        ProposalType proposalType,
        address targetAddress,
        uint256 value
    ) external onlyValidator nonReentrant returns (uint256 proposalId) {
        if (proposalType == ProposalType.AddValidator) {
            require(targetAddress != address(0), "Registry: zero target");
            require(!isValidator[targetAddress], "Registry: already validator");
        } else if (proposalType == ProposalType.RemoveValidator) {
            require(isValidator[targetAddress], "Registry: not a validator");
            require(validatorCount > 1, "Registry: cannot remove last validator");
        } else {
            // SetDifficulty
            require(value > 0, "Registry: difficulty must be > 0");
            require(tokenInitialized, "Registry: token not set");
        }

        proposalId = proposalCount++;
        Proposal storage p = proposals[proposalId];
        p.proposalType = proposalType;
        p.targetAddress = targetAddress;
        p.value = value;
        p.proposer = msg.sender;
        p.createdAt = block.timestamp;
        p.yesVotes = 1;
        hasVoted[proposalId][msg.sender] = true;

        emit ProposalCreated(proposalId, proposalType, msg.sender, targetAddress, value);
        emit VoteCast(proposalId, msg.sender, p.yesVotes);

        if (_supermajorityReached(p.yesVotes)) {
            _execute(proposalId);
        }

        return proposalId;
    }

    /**
     * @notice Casts a YES vote on an open proposal. Executes the proposal once
     *         the supermajority threshold is crossed.
     * @param proposalId The proposal to vote on.
     */
    function vote(uint256 proposalId) external onlyValidator nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.createdAt != 0, "Registry: no such proposal");
        require(!p.executed, "Registry: already executed");
        require(!hasVoted[proposalId][msg.sender], "Registry: already voted");

        hasVoted[proposalId][msg.sender] = true;
        p.yesVotes += 1;
        emit VoteCast(proposalId, msg.sender, p.yesVotes);

        if (_supermajorityReached(p.yesVotes)) {
            _execute(proposalId);
        }
    }

    /**
     * @notice Manually executes a proposal that has already reached the
     *         supermajority threshold (e.g. if the threshold was met after the
     *         validator count shrank). Idempotency is guarded by `executed`.
     * @param proposalId The proposal to execute.
     */
    function executeProposal(uint256 proposalId) external onlyValidator nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.createdAt != 0, "Registry: no such proposal");
        require(!p.executed, "Registry: already executed");
        require(_supermajorityReached(p.yesVotes), "Registry: no supermajority");
        _execute(proposalId);
    }

    // --------------------------------------------------------------------- //
    //                          INTERNAL LOGIC                              //
    // --------------------------------------------------------------------- //

    /// @dev Returns true when `yes` votes strictly exceed 66% of the live set.
    function _supermajorityReached(uint256 yes) internal view returns (bool) {
        return yes * 100 > validatorCount * 66;
    }

    /// @dev Performs the action of an approved proposal exactly once.
    function _execute(uint256 proposalId) internal {
        Proposal storage p = proposals[proposalId];
        require(!p.executed, "Registry: already executed");
        p.executed = true;

        if (p.proposalType == ProposalType.AddValidator) {
            _addValidator(p.targetAddress);
        } else if (p.proposalType == ProposalType.RemoveValidator) {
            _removeValidator(p.targetAddress);
        } else {
            token.setDifficulty(p.value);
        }

        emit ProposalExecuted(proposalId, p.proposalType);
    }

    /// @dev Adds a validator to the active set.
    function _addValidator(address v) internal {
        if (!isValidator[v]) {
            isValidator[v] = true;
            _validatorList.push(v);
            validatorCount++;
            emit ValidatorAdded(v, validatorCount);
        }
    }

    /// @dev Removes a validator from the active set (membership flag only).
    function _removeValidator(address v) internal {
        if (isValidator[v]) {
            isValidator[v] = false;
            validatorCount--;
            emit ValidatorRemoved(v, validatorCount);
        }
    }

    // --------------------------------------------------------------------- //
    //                             VIEW HELPERS                             //
    // --------------------------------------------------------------------- //

    /**
     * @notice Returns the full list of addresses ever added together with their
     *         current membership status.
     */
    function getValidators()
        external
        view
        returns (address[] memory addresses, bool[] memory active)
    {
        addresses = _validatorList;
        active = new bool[](_validatorList.length);
        for (uint256 i = 0; i < _validatorList.length; i++) {
            active[i] = isValidator[_validatorList[i]];
        }
    }

    /**
     * @notice Returns the number of YES votes currently required to pass a vote
     *         (strict supermajority of the live validator set).
     */
    function votesRequired() external view returns (uint256) {
        // Smallest integer strictly greater than 66% of validatorCount.
        return (validatorCount * 66) / 100 + 1;
    }

    /**
     * @notice Reads the full state of a proposal.
     */
    function getProposal(uint256 proposalId)
        external
        view
        returns (
            ProposalType proposalType,
            address targetAddress,
            uint256 value,
            uint256 yesVotes,
            bool executed,
            uint256 createdAt,
            address proposer
        )
    {
        Proposal storage p = proposals[proposalId];
        return (
            p.proposalType,
            p.targetAddress,
            p.value,
            p.yesVotes,
            p.executed,
            p.createdAt,
            p.proposer
        );
    }
}
