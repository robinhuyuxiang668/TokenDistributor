// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title TokenDistributor - 基于 Merkle 树的代币分发合约
 * @notice 本合约允许用户根据 merkle 证明申领代币
 * @dev 本合约使用 Merkle 树高效地向大量收件人分发代币
 *      Operator 设置 merkle 根和开始时间，Owner 在分发结束或尚未开始时提取剩余代币
 *      支持 ERC20 代币和原生代币两种分发方式
 */
contract TokenDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 分发周期持续时间（14天）
    uint256 public constant DURATION = 14 days;

    /// @notice 距当前时间允许的最大开始时间偏移（90天）
    uint256 public constant MAX_START_TIME = 90 days;

    /// @notice 原生代币标识地址
    address constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // ============ 不可变变量 ============

    /// @notice 被分发代币的地址
    address public immutable token;

    /// @notice 初始分发的总代币数量
    uint256 public immutable initialTotalAmount;

    /// @notice 有权设置 merkle 根和启动时间的地址
    address public immutable operator;

    /// @notice 有权提取剩余代币的地址
    address public immutable owner;

    // ============ 可变状态变量 ============

    /// @notice 用于校验证明的 merkle 根哈希
    bytes32 public merkleRoot;

    /// @notice 已被申领的代币总量
    uint256 public totalClaimed;

    /// @notice 分发开始的时间戳
    /// @notice 分发结束的时间戳
    /// @dev 打包一起以节省存储槽和降低 gas 成本
    uint64 public startTime;
    uint64 public endTime;

    /// @notice 记录地址已申领的数量
    mapping(address => uint256) public claimedAmounts;

    // 节省gas的自定义错误信息
    error AlreadyStarted(); // 分发已开始
    error InvalidAmount(); // 数量不能为零
    error InvalidProof(); // merkle 证明无效
    error InvalidRoot(); // 无效的 merkle 根
    error InvalidTime(); // 无效的时间戳
    error NativeSendFailed(); // 原生代币发送失败
    error NativeNotAccepted(); // 不接受原生代币
    error NoRoot(); // 未设置 merkle 根
    error NoTokens(); // 没有可用的代币
    error OnlyOperator(); // 仅操作员可调用
    error OnlyOwner(); // 仅所有者可调用
    error StartTimeNotSet(); // 未设置开始时间
    error TooEarly(); // 分发尚未开始
    error TooLate(); // 分发已结束

    /// @notice 设置分发时间时触发
    event TimeSet(uint64 startTime, uint64 endTime);

    /// @notice 设置 merkle 根时触发
    event MerkleRootSet(bytes32 merkleRoot);

    /// @notice 申领奖励时触发
    event Claimed(address indexed account, uint256 amount);

    /// @notice 提取剩余代币时触发
    event Withdrawn(address to, uint256 amount);

    /// @notice 仅允许 operator 调用
    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    /// @notice 仅允许 owner 调用
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @notice 初始化分发合约
    /// @param _owner 可提取剩余代币的所有者地址
    /// @param _operator 可设置 merkle 根及分发开始时间的操作员地址
    /// @param _token 待分发的代币地址
    /// @param _initialTotalAmount 初始要分发的代币总量
    constructor(address _owner, address _operator, address _token, uint256 _initialTotalAmount) {
        owner = _owner;
        operator = _operator;
        token = _token;
        initialTotalAmount = _initialTotalAmount;
    }

    /// @notice 设置空投分发的开始时间
    /// @dev 可由操作员多次调用，限制如下:
    /// 1. 分发已开始则无法设置
    /// 2. 开始时间需晚于当前区块时间戳
    /// 3. 开始时间需小于等于当前时间+90天
    /// 4. 只要分发未开始就可以设置
    /// @param _startTime 开始时间戳（需在未来且不超过 MAX_START_TIME）
    function setTime(uint256 _startTime) external onlyOperator {
        if (_startTime <= block.timestamp) revert InvalidTime();
        if (_startTime > block.timestamp + MAX_START_TIME) revert InvalidTime();
        if (block.timestamp >= startTime && startTime > 0) revert AlreadyStarted();

        startTime = uint64(_startTime);
        endTime = uint64(_startTime + DURATION);

        emit TimeSet(startTime, endTime);
    }

    /// @notice 设置申领校验所需的 merkle 根
    /// @dev 操作员可多次设置/更新 merkle 根
    /// @param _merkleRoot merkle 根哈希
    function setMerkleRoot(bytes32 _merkleRoot) external onlyOperator {
        if (_merkleRoot == bytes32(0)) revert InvalidRoot();
        merkleRoot = _merkleRoot;

        emit MerkleRootSet(_merkleRoot);
    }

    /// @notice 在分发结束后提取剩余代币
    /// @dev 仅 owner 可以在分发结束或未设置开始时间时调用
    function withdraw() external onlyOwner {
        // 分发必须已结束才能提现
        if (block.timestamp <= endTime) revert InvalidTime();

        uint256 balance = getBalance();
        if (balance == 0) revert NoTokens();

        transfer(msg.sender, balance);

        emit Withdrawn(msg.sender, balance);
    }

    /// @notice 使用 merkle 证明申领奖励代币
    /// @dev 支持一次性申领（merkle 根仅设定一次）或增量分发
    ///      通过调整 maxAmount 而无需重置历史已申领
    /// @param maxAmount 该地址最大可申领数量（来源于 merkle 树）
    /// @param proof 用于校验申领的 merkle 证明
    function claim(uint256 maxAmount, bytes32[] calldata proof) external nonReentrant {
        // 校验分发状态
        if (startTime == 0) revert StartTimeNotSet();
        if (block.timestamp < startTime) revert TooEarly();
        if (block.timestamp > endTime) revert TooLate();
        if (merkleRoot == bytes32(0)) revert NoRoot();

        // 检查用户是否已申领最大数量
        uint256 claimedAmount = claimedAmounts[msg.sender];
        if (maxAmount <= claimedAmount) revert InvalidAmount();

        // 校验 merkle 证明
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, maxAmount));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        // 计算待申领数量
        uint256 pendingAmount;
        unchecked {
            pendingAmount = maxAmount - claimedAmount; // 安全：上面已确保 maxAmount > claimedAmount
        }

        // 在转账前更新申领记录（CEI 模式）
        claimedAmounts[msg.sender] = maxAmount;

        // 更新已申领总量
        totalClaimed += pendingAmount;

        // 向申领者转账
        transfer(msg.sender, pendingAmount);

        emit Claimed(msg.sender, pendingAmount);
    }

    /// @notice 获取合约当前余额
    function getBalance() internal view returns (uint256) {
        if (token == ETH_ADDRESS) {
            return address(this).balance;
        } else {
            return IERC20(token).balanceOf(address(this));
        }
    }

    /// @notice 向指定地址转账代币
    function transfer(address to, uint256 amount) internal {
        if (token == ETH_ADDRESS) {
            (bool success,) = payable(to).call{value: amount, gas: 5000}("");
            if (!success) revert NativeSendFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev 接受原生代币
    receive() external payable {
        if (token != ETH_ADDRESS) revert NativeNotAccepted();
    }
}
