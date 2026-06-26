// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title AXISToken
 * @author AXIS AI Protocol
 * @notice ERC-20 implementation of the AXIS AI token. AXIS is a fixed-supply,
 *         mining-only commodity token. Issuance is governed entirely by the
 *         deterministic Proof-of-AI-Work (PoAIW) rules encoded in this contract.
 *
 *         There is no owner, no admin, no multisig, no upgrade proxy and no
 *         pause function. The ONLY address permitted to mint is the immutable
 *         `validatorRegistry` contract, which itself is governed by a
 *         supermajority validator vote.
 *
 *         Reward formula (whitepaper section 5.3):
 *
 *             AXIS Reward = baseEpochReward x (W x Q) / (D x 100)
 *
 *         where:
 *             - baseEpochReward is the per-work-unit emission for the current
 *               epoch (200 / 100 / 50 / 25 AXIS during Genesis, then the
 *               geometric halving continuation for the Standard phases).
 *             - W is the verified workload units.
 *             - Q is the quality score, supplied as an integer 0..100
 *               representing the whitepaper's 0.0..1.0 range (divided by 100).
 *             - D is the on-chain difficulty factor.
 *
 *         A single standard work unit (W=1) at perfect quality (Q=100) and the
 *         lowest difficulty (D=1) therefore mints exactly the epoch reward,
 *         e.g. 200 AXIS in Genesis Epoch 1 — matching the whitepaper table.
 *
 * @dev    Total supply is hard-capped at 84,000,000 AXIS. Once reached, minting
 *         is permanently and automatically disabled forever.
 */
contract AXISToken is ERC20 {
    // --------------------------------------------------------------------- //
    //                              CONSTANTS                                 //
    // --------------------------------------------------------------------- //

    /// @notice Hard cap on total supply: 84,000,000 AXIS (18 decimals).
    uint256 public constant MAX_SUPPLY = 84_000_000 * 1e18;

    /// @notice End of the Genesis Phase: first 25% of supply (21,000,000 AXIS).
    uint256 public constant GENESIS_SUPPLY = 21_000_000 * 1e18;

    // Genesis epoch cumulative thresholds (whitepaper section 4.3).
    uint256 public constant GENESIS_EPOCH_1_END = 5_250_000 * 1e18;
    uint256 public constant GENESIS_EPOCH_2_END = 10_500_000 * 1e18;
    uint256 public constant GENESIS_EPOCH_3_END = 15_750_000 * 1e18;
    uint256 public constant GENESIS_EPOCH_4_END = 21_000_000 * 1e18;

    // Genesis epoch per-work-unit base rewards (whitepaper section 4.3).
    uint256 public constant GENESIS_EPOCH_1_REWARD = 200 * 1e18;
    uint256 public constant GENESIS_EPOCH_2_REWARD = 100 * 1e18;
    uint256 public constant GENESIS_EPOCH_3_REWARD = 50 * 1e18;
    uint256 public constant GENESIS_EPOCH_4_REWARD = 25 * 1e18;

    // Standard / Late / Terminal phase cumulative thresholds (section 6).
    uint256 public constant STANDARD_PHASE_END = 63_000_000 * 1e18; // +42,000,000
    uint256 public constant LATE_PHASE_END = 79_800_000 * 1e18; // +16,800,000
    uint256 public constant TERMINAL_PHASE_END = 84_000_000 * 1e18; // +4,200,000

    // Standard phase base rewards: geometric halving continuation of Genesis
    // (200 -> 100 -> 50 -> 25 -> 12.5 -> 6.25 -> 3.125).
    uint256 public constant STANDARD_PHASE_REWARD = 125 * 1e17; // 12.5 AXIS
    uint256 public constant LATE_PHASE_REWARD = 625 * 1e16; // 6.25 AXIS
    uint256 public constant TERMINAL_PHASE_REWARD = 3125 * 1e15; // 3.125 AXIS

    /// @notice Quality score is expressed as an integer 0..100 (=> 0.0..1.0).
    uint256 public constant QUALITY_DENOMINATOR = 100;

    // --------------------------------------------------------------------- //
    //                   POST-GENESIS DIFFICULTY RAMP                        //
    // --------------------------------------------------------------------- //
    // Mining is deliberately easiest while the network bootstraps (the first
    // 25% / Genesis Phase). Once 25% of supply is mined, an automatic,
    // supply-driven difficulty multiplier kicks in and grows linearly toward
    // the cap — so every AXIS minted past the Genesis Phase is progressively
    // harder to earn, on top of the per-epoch base-reward halvings.

    /// @notice Fixed-point scale for the supply difficulty multiplier
    ///         (RAMP_SCALE == 1.0x). The multiplier is held in this scale.
    uint256 public constant RAMP_SCALE = 10_000;

    /// @notice Difficulty multiplier once the entire supply is mined: 8.0x.
    ///         Ramps linearly from 1.0x at 25% (Genesis end) to this at 100%.
    uint256 public constant MAX_SUPPLY_DIFFICULTY_MULTIPLIER = 80_000; // 8.0x

    /// @notice Protocol burn taken from every PoAIW reward, in basis points
    ///         (300 = 3%). The miner receives the remaining 97%; the 3% is
    ///         permanently removed from circulation (never minted), making AXIS
    ///         progressively scarcer for every holder. Counts toward the cap, so
    ///         the 84M emission cap holds while only ~81.5M ever circulates.
    uint256 public constant BURN_BPS = 300; // 3.00%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // --------------------------------------------------------------------- //
    //                          IMMUTABLE STATE                              //
    // --------------------------------------------------------------------- //

    /// @notice The sole address allowed to mint AXIS. Set once at deployment
    ///         and never changeable. This is the ValidatorRegistry contract.
    address public immutable validatorRegistry;

    // --------------------------------------------------------------------- //
    //                            MUTABLE STATE                              //
    // --------------------------------------------------------------------- //

    /// @notice Total AXIS emission accounted to date (miner share + burned
    ///         share). Drives epoch transitions and the supply cap.
    uint256 public totalMinted;

    /// @notice Total AXIS permanently burned from emission (the 3% protocol
    ///         burn). `totalSupply()` == totalMinted - totalBurned.
    uint256 public totalBurned;

    /// @notice Current difficulty factor `D`. Updatable only by the registry.
    ///         Initialised to 1 (lowest permitted value) per whitepaper 4.5.
    uint256 public difficulty;

    /// @notice Becomes true forever once MAX_SUPPLY is reached.
    bool public mintingPermanentlyDisabled;

    // --------------------------------------------------------------------- //
    //                                EVENTS                                 //
    // --------------------------------------------------------------------- //

    /// @notice Emitted on every successful PoAIW reward mint.
    event WorkRewardMinted(
        address indexed miner,
        uint256 workload,
        uint256 quality,
        uint256 difficulty,
        uint256 baseReward,
        uint256 mintedAmount,
        uint256 newTotalMinted
    );

    /// @notice Emitted on every reward mint for the AXIS permanently burned
    ///         (the 3% protocol burn that accrues scarcity to all holders).
    event RewardBurned(address indexed miner, uint256 burnedAmount, uint256 newTotalBurned);

    /// @notice Emitted when the difficulty factor `D` is updated.
    event DifficultyUpdated(uint256 oldDifficulty, uint256 newDifficulty);

    /// @notice Emitted once, permanently, when the supply cap is reached.
    event MintingPermanentlyDisabledEvent(uint256 finalSupply);

    /// @notice Emitted whenever the protocol crosses an epoch boundary.
    event EpochTransition(uint256 indexed newEpoch, uint256 atTotalMinted, uint256 newBaseReward);

    // --------------------------------------------------------------------- //
    //                              MODIFIERS                                //
    // --------------------------------------------------------------------- //

    /// @dev Restricts a function to the immutable ValidatorRegistry contract.
    modifier onlyRegistry() {
        require(msg.sender == validatorRegistry, "AXIS: caller is not registry");
        _;
    }

    // --------------------------------------------------------------------- //
    //                             CONSTRUCTOR                               //
    // --------------------------------------------------------------------- //

    /**
     * @notice Deploys the AXIS token.
     * @param _validatorRegistry Address of the ValidatorRegistry contract that
     *        will hold the exclusive right to mint. Immutable after deployment.
     * @dev   No premine, no founder allocation, no treasury — supply starts at 0
     *        and grows only through verified PoAIW submissions.
     */
    constructor(address _validatorRegistry) ERC20("AXIS AI", "AXIS") {
        require(_validatorRegistry != address(0), "AXIS: registry is zero");
        validatorRegistry = _validatorRegistry;
        difficulty = 1; // lowest network-permitted value (whitepaper 4.5)
    }

    // --------------------------------------------------------------------- //
    //                            MINT (PoAIW)                               //
    // --------------------------------------------------------------------- //

    /**
     * @notice Mints AXIS for a verified PoAIW submission. Callable ONLY by the
     *         ValidatorRegistry contract. Enforces the reward formula on-chain
     *         and the global supply cap.
     * @param to The miner wallet that performed the verified work.
     * @param workload `W` — verified workload units (must be > 0).
     * @param quality  `Q` — quality score 0..100 (=> 0.0..1.0, must be <= 100).
     * @return minted The amount of AXIS actually minted (clamped to the cap).
     * @dev    Reverts if minting is disabled, inputs are invalid, or the
     *         computed reward rounds down to zero. Automatically clamps the
     *         final mint so total supply can never exceed MAX_SUPPLY, then
     *         permanently disables minting once the cap is reached.
     */
    function mint(
        address to,
        uint256 workload,
        uint256 quality
    ) external onlyRegistry returns (uint256 minted) {
        require(!mintingPermanentlyDisabled, "AXIS: minting disabled");
        require(to != address(0), "AXIS: mint to zero");
        require(workload > 0, "AXIS: workload is zero");
        require(quality > 0 && quality <= 100, "AXIS: quality out of range");
        require(difficulty > 0, "AXIS: difficulty is zero");
        require(totalMinted < MAX_SUPPLY, "AXIS: cap reached");

        uint256 epochBefore = currentEpoch();
        uint256 baseReward = currentBaseReward();
        require(baseReward > 0, "AXIS: no active emission");

        // AXIS Reward = baseEpochReward x (W x Q) / (Dₑ x 100), where the
        // effective difficulty Dₑ = D x supplyDifficultyMultiplier. During the
        // Genesis Phase the multiplier is exactly 1.0x, so this matches the
        // whitepaper formula; past 25% it grows, making rewards harder to mint.
        // Multiply before dividing to preserve integer precision.
        uint256 mult = supplyDifficultyMultiplier();
        uint256 reward = (baseReward * workload * quality * RAMP_SCALE) /
            (difficulty * QUALITY_DENOMINATOR * mult);
        require(reward > 0, "AXIS: reward rounds to zero");

        // Clamp the final mint so the hard cap is never exceeded.
        uint256 remaining = MAX_SUPPLY - totalMinted;
        if (reward > remaining) {
            reward = remaining;
        }

        // The full reward counts toward the cap; 3% is burned (never minted)
        // and 97% goes to the miner. `minted` is the miner's net share.
        totalMinted += reward;
        uint256 burnAmount = (reward * BURN_BPS) / BPS_DENOMINATOR;
        minted = reward - burnAmount;
        totalBurned += burnAmount;
        _mint(to, minted);

        emit WorkRewardMinted(
            to,
            workload,
            quality,
            effectiveDifficulty(),
            baseReward,
            minted,
            totalMinted
        );
        if (burnAmount > 0) {
            emit RewardBurned(to, burnAmount, totalBurned);
        }

        // Detect and announce epoch transitions caused by this mint.
        uint256 epochAfter = currentEpoch();
        if (epochAfter != epochBefore) {
            emit EpochTransition(epochAfter, totalMinted, currentBaseReward());
        }

        // Permanently and automatically disable minting at the cap.
        if (totalMinted == MAX_SUPPLY) {
            mintingPermanentlyDisabled = true;
            emit MintingPermanentlyDisabledEvent(totalMinted);
        }

        return minted;
    }

    // --------------------------------------------------------------------- //
    //                          DIFFICULTY CONTROL                          //
    // --------------------------------------------------------------------- //

    /**
     * @notice Updates the difficulty factor `D`. Callable ONLY by the registry
     *         (which gates the call behind a validator supermajority vote).
     * @param newDifficulty The new difficulty value (must be > 0).
     */
    function setDifficulty(uint256 newDifficulty) external onlyRegistry {
        require(newDifficulty > 0, "AXIS: difficulty must be > 0");
        uint256 old = difficulty;
        difficulty = newDifficulty;
        emit DifficultyUpdated(old, newDifficulty);
    }

    // --------------------------------------------------------------------- //
    //                             VIEW HELPERS                             //
    // --------------------------------------------------------------------- //

    /**
     * @notice Returns the current epoch number based on `totalMinted`.
     * @return 1-4 during the Genesis Phase, 5 (Standard), 6 (Late), 7 (Terminal)
     *         afterwards, or 0 once the supply is fully exhausted.
     */
    function currentEpoch() public view returns (uint256) {
        uint256 m = totalMinted;
        if (m < GENESIS_EPOCH_1_END) return 1;
        if (m < GENESIS_EPOCH_2_END) return 2;
        if (m < GENESIS_EPOCH_3_END) return 3;
        if (m < GENESIS_EPOCH_4_END) return 4;
        if (m < STANDARD_PHASE_END) return 5;
        if (m < LATE_PHASE_END) return 6;
        if (m < TERMINAL_PHASE_END) return 7;
        return 0; // fully mined
    }

    /**
     * @notice Returns true while the protocol is still within the Genesis Phase.
     */
    function isGenesisPhase() external view returns (bool) {
        return totalMinted < GENESIS_SUPPLY;
    }

    /**
     * @notice Returns the per-work-unit base reward for the current epoch.
     * @dev    Determined purely by `totalMinted`; no manual trigger exists.
     */
    function currentBaseReward() public view returns (uint256) {
        uint256 m = totalMinted;
        if (m < GENESIS_EPOCH_1_END) return GENESIS_EPOCH_1_REWARD;
        if (m < GENESIS_EPOCH_2_END) return GENESIS_EPOCH_2_REWARD;
        if (m < GENESIS_EPOCH_3_END) return GENESIS_EPOCH_3_REWARD;
        if (m < GENESIS_EPOCH_4_END) return GENESIS_EPOCH_4_REWARD;
        if (m < STANDARD_PHASE_END) return STANDARD_PHASE_REWARD;
        if (m < LATE_PHASE_END) return LATE_PHASE_REWARD;
        if (m < TERMINAL_PHASE_END) return TERMINAL_PHASE_REWARD;
        return 0;
    }

    /**
     * @notice Pure preview of the reward the formula would produce for the
     *         given inputs at the current epoch/difficulty, before cap clamping.
     * @param workload `W` verified workload units.
     * @param quality  `Q` quality score 0..100.
     * @return The reward in wei (AXIS * 1e18).
     */
    function previewReward(uint256 workload, uint256 quality)
        external
        view
        returns (uint256)
    {
        if (quality == 0 || quality > 100 || workload == 0 || difficulty == 0) {
            return 0;
        }
        uint256 baseReward = currentBaseReward();
        uint256 mult = supplyDifficultyMultiplier();
        uint256 gross = (baseReward * workload * quality * RAMP_SCALE) /
            (difficulty * QUALITY_DENOMINATOR * mult);
        // The miner receives the post-burn (97%) amount.
        return gross - (gross * BURN_BPS) / BPS_DENOMINATOR;
    }

    /**
     * @notice The automatic, supply-driven difficulty multiplier (RAMP_SCALE
     *         == 1.0x). Exactly 1.0x throughout the Genesis Phase (first 25%
     *         of supply); past 25% it ramps linearly toward
     *         MAX_SUPPLY_DIFFICULTY_MULTIPLIER (8.0x) as the cap is approached.
     * @return The multiplier scaled by RAMP_SCALE (e.g. 10000 == 1.0x).
     */
    function supplyDifficultyMultiplier() public view returns (uint256) {
        uint256 m = totalMinted;
        if (m <= GENESIS_SUPPLY) {
            return RAMP_SCALE; // 1.0x while the network bootstraps (Genesis)
        }
        uint256 past = m - GENESIS_SUPPLY; // minted beyond the first 25%
        uint256 span = MAX_SUPPLY - GENESIS_SUPPLY; // the remaining 75%
        uint256 extra = ((MAX_SUPPLY_DIFFICULTY_MULTIPLIER - RAMP_SCALE) * past) / span;
        return RAMP_SCALE + extra;
    }

    /**
     * @notice The effective difficulty `Dₑ` actually applied to the reward
     *         formula: the validator-set difficulty `D` scaled by the
     *         supply-driven multiplier. Always >= 1.
     */
    function effectiveDifficulty() public view returns (uint256) {
        uint256 eff = (difficulty * supplyDifficultyMultiplier()) / RAMP_SCALE;
        return eff > 0 ? eff : 1;
    }

    /**
     * @notice Remaining mintable supply before the hard cap is reached.
     */
    function remainingSupply() external view returns (uint256) {
        return MAX_SUPPLY - totalMinted;
    }
}
