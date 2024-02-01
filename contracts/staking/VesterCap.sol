// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "../libraries/math/SafeMath.sol";
import "../libraries/token/IERC20.sol";
import "../libraries/token/SafeERC20.sol";
import "../libraries/utils/ReentrancyGuard.sol";

import "../access/Governable.sol";
import "./interfaces/IRewardTracker.sol";

contract VesterCap is ReentrancyGuard, Governable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS_DIVISOR = 10000;

    address public stakedGmxTracker;
    address public feeGmxTracker;
    address public bnGmx;

    uint256 public maxBoostBasisPoints;

    constructor (
        address _stakedGmxTracker,
        address _feeGmxTracker,
        address _bnGmx,
        uint256 _maxBoostBasisPoints
    ) public {
        stakedGmxTracker = _stakedGmxTracker;
        feeGmxTracker = _feeGmxTracker;
        bnGmx = _bnGmx;
        maxBoostBasisPoints = _maxBoostBasisPoints;
    }

    function unreservePairToken(address _account) external nonReentrant onlyGov {
        uint256 baseStakedAmount = IRewardTracker(stakedGmxTracker).stakedAmounts(_account);
        uint256 maxAllowedBnGmxAmount = baseStakedAmount.mul(maxBoostBasisPoints).div(BASIS_POINTS_DIVISOR);
        uint256 currentBnGmxAmount = IRewardTracker(feeGmxTracker).depositBalances(_account, bnGmx);
        uint256 amountToUnstake = currentBnGmxAmount.sub(maxAllowedBnGmxAmount);
        uint256 feeGmxTrackerBalance = IERC20(feeGmxTracker).balanceOf(_account);

        uint256 amountToUnvest;

        if (feeGmxTrackerBalance < amountToUnstake) {
            amountToUnvest = amountToUnstake - feeGmxTrackerBalance;
        }

        if (amountToUnvest == 0) {
            return;
        }

        IERC20(feeGmxTracker).safeTransfer(_account, amountToUnvest);
    }
}
