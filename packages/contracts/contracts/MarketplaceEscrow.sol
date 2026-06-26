// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IValidatorRegistryView {
    function isValidator(address account) external view returns (bool);
}

/**
 * @title MarketplaceEscrow
 * @author AXIS AI Protocol
 * @notice Holds AXIS in escrow for compute jobs and TX-capacity trades in the
 *         AXIS marketplace (whitepaper sections 7 & 9). Funds are locked by the
 *         requester on job creation and either released to the provider on a
 *         verified delivery or refunded to the requester on timeout / fraud.
 *
 *         Settlement decisions (release / refund / fraud flag) are authorised by
 *         approved validators from the ValidatorRegistry — the same decentralised
 *         set that governs minting — so no privileged operator key exists.
 *
 * @dev    The requester must `approve` this contract for the escrow amount of
 *         AXIS before calling {lock}. All escrow lifecycle events are emitted
 *         on-chain for the marketplace's PostgreSQL mirror.
 */
contract MarketplaceEscrow is ReentrancyGuard {
    // --------------------------------------------------------------------- //
    //                                 TYPES                                 //
    // --------------------------------------------------------------------- //

    enum EscrowStatus {
        None,
        Locked,
        Released,
        Refunded
    }

    struct Escrow {
        bytes32 jobId;
        address requester;
        address provider;
        uint256 amount;
        uint256 createdAt;
        uint256 timeoutAt;
        EscrowStatus status;
    }

    // --------------------------------------------------------------------- //
    //                                STATE                                  //
    // --------------------------------------------------------------------- //

    /// @notice The AXIS token used for settlement.
    IERC20 public immutable axis;

    /// @notice The validator registry that authorises settlement.
    IValidatorRegistryView public immutable registry;

    /// @notice Escrows keyed by off-chain job id.
    mapping(bytes32 => Escrow) public escrows;

    /// @notice Providers flagged for fraud by validators.
    mapping(address => uint256) public fraudFlags;

    // --------------------------------------------------------------------- //
    //                                EVENTS                                 //
    // --------------------------------------------------------------------- //

    event EscrowLocked(
        bytes32 indexed jobId,
        address indexed requester,
        address indexed provider,
        uint256 amount,
        uint256 timeoutAt
    );
    event EscrowReleased(bytes32 indexed jobId, address indexed provider, uint256 amount);
    event EscrowRefunded(bytes32 indexed jobId, address indexed requester, uint256 amount);
    event ProviderFlagged(bytes32 indexed jobId, address indexed provider);

    // --------------------------------------------------------------------- //
    //                              MODIFIERS                                //
    // --------------------------------------------------------------------- //

    modifier onlyValidator() {
        require(registry.isValidator(msg.sender), "Escrow: not validator");
        _;
    }

    // --------------------------------------------------------------------- //
    //                             CONSTRUCTOR                               //
    // --------------------------------------------------------------------- //

    /**
     * @param _axis     The AXIS token address.
     * @param _registry The ValidatorRegistry address used for authorisation.
     */
    constructor(address _axis, address _registry) {
        require(_axis != address(0) && _registry != address(0), "Escrow: zero addr");
        axis = IERC20(_axis);
        registry = IValidatorRegistryView(_registry);
    }

    // --------------------------------------------------------------------- //
    //                           ESCROW LIFECYCLE                           //
    // --------------------------------------------------------------------- //

    /**
     * @notice Locks `amount` AXIS from the requester for a job. The requester
     *         must have approved this contract for at least `amount` first.
     * @param jobId      Unique off-chain job identifier.
     * @param provider   The provider that will fulfil the job.
     * @param amount     The AXIS amount to escrow (must be > 0).
     * @param timeoutSec Seconds until the escrow may be refunded on timeout.
     */
    function lock(
        bytes32 jobId,
        address provider,
        uint256 amount,
        uint256 timeoutSec
    ) external nonReentrant {
        require(amount > 0, "Escrow: zero amount");
        require(provider != address(0), "Escrow: zero provider");
        require(escrows[jobId].status == EscrowStatus.None, "Escrow: job exists");

        escrows[jobId] = Escrow({
            jobId: jobId,
            requester: msg.sender,
            provider: provider,
            amount: amount,
            createdAt: block.timestamp,
            timeoutAt: block.timestamp + timeoutSec,
            status: EscrowStatus.Locked
        });

        require(
            axis.transferFrom(msg.sender, address(this), amount),
            "Escrow: transferFrom failed"
        );

        emit EscrowLocked(jobId, msg.sender, provider, amount, block.timestamp + timeoutSec);
    }

    /**
     * @notice Releases an escrow to the provider after verified delivery.
     *         Authorised by a validator (the verification engine).
     * @param jobId The job whose escrow to release.
     */
    function release(bytes32 jobId) external onlyValidator nonReentrant {
        Escrow storage e = escrows[jobId];
        require(e.status == EscrowStatus.Locked, "Escrow: not locked");
        e.status = EscrowStatus.Released;
        require(axis.transfer(e.provider, e.amount), "Escrow: transfer failed");
        emit EscrowReleased(jobId, e.provider, e.amount);
    }

    /**
     * @notice Refunds an escrow to the requester. Authorised by a validator on
     *         fraud detection, or callable by the requester after the timeout.
     * @param jobId The job whose escrow to refund.
     */
    function refund(bytes32 jobId) external nonReentrant {
        Escrow storage e = escrows[jobId];
        require(e.status == EscrowStatus.Locked, "Escrow: not locked");
        require(
            registry.isValidator(msg.sender) ||
                (msg.sender == e.requester && block.timestamp >= e.timeoutAt),
            "Escrow: not authorised"
        );
        e.status = EscrowStatus.Refunded;
        require(axis.transfer(e.requester, e.amount), "Escrow: transfer failed");
        emit EscrowRefunded(jobId, e.requester, e.amount);
    }

    /**
     * @notice Flags a provider for fraud and refunds the requester. Validator-only.
     * @param jobId The job in which fraud was detected.
     */
    function flagFraud(bytes32 jobId) external onlyValidator nonReentrant {
        Escrow storage e = escrows[jobId];
        require(e.status == EscrowStatus.Locked, "Escrow: not locked");
        e.status = EscrowStatus.Refunded;
        fraudFlags[e.provider] += 1;
        require(axis.transfer(e.requester, e.amount), "Escrow: transfer failed");
        emit ProviderFlagged(jobId, e.provider);
        emit EscrowRefunded(jobId, e.requester, e.amount);
    }

    /**
     * @notice Returns the full escrow record for a job.
     */
    function getEscrow(bytes32 jobId) external view returns (Escrow memory) {
        return escrows[jobId];
    }
}
