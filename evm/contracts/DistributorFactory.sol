// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./TokenDistributor.sol";

/**
 * @title DistributorFactory - Token reward distribution factory contract
 * @notice 这是一个奖励分发工厂合约，允许任何人配置代币分发活动
 * @dev 工作流程:
 *      1. 任何人都可以调用createDistributor创建奖励分发合约
 *      2. 创建时需指定代币地址、操作员地址和总奖励金额
 *      3. 工厂合约会自动将代币转账到新建的分发合约
 *      4. 操作员可在分发合约中设置merkle根
 *      5. 用户通过提供merkle证明领取奖励
 *      6. 支持ERC20代币和原生代币分发
 */
contract DistributorFactory {
    using SafeERC20 for IERC20;

    /// @notice 原生代币标识符地址
    address constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice 检查某地址是否为本工厂创建的分发合约
    mapping(address => bool) public isDistributor;

    // 自定义错误，用于高效Gas的异常处理
    error AmountMismatch(); // 金额不匹配
    error InvalidAmount(); // 无效金额
    error InvalidOperator(); // 无效操作员地址
    error InvalidToken(); // 无效代币地址
    error InvalidTotalAmount(); // 无效总奖励金额
    error NativeSendFailed(); // 原生代币发送失败
    error UnexpectedNative(); // 意外的原生货币

    /**
     * @notice 当新分发合约被创建时触发
     * @param owner 合约所有者（创建者）
     * @param operator 操作员地址（负责设置merkle根）
     * @param token 奖励代币地址
     * @param distributorAddress 新创建的分发合约地址
     */
    event DistributorCreated(address indexed owner, address indexed operator, address token, address distributorAddress);

    /**
     * @notice 创建新的奖励分发合约
     * @dev 任何人都可以调用该函数创建分发合约
     *      创建后，指定数量的代币会自动转账至新合约
     * @param token 奖励代币地址
     * @param operator 操作员地址，负责设置merkle根和发放开始时间
     * @param initialTotalAmount 总奖励额度，调用者需有充足ERC20余额并授权或发送相应原生代币
     * @return distributorAddress 新创建的分发合约地址
     */
    function createDistributor(address token, address operator, uint256 initialTotalAmount) external payable returns (address distributorAddress) {
        if (token == address(0)) revert InvalidToken();
        if (operator == address(0)) revert InvalidOperator();
        if (initialTotalAmount == 0) revert InvalidTotalAmount();

        // 创建分发合约实例
        // msg.sender作为合约所有者，operator成为管理员
        distributorAddress = address(
            new TokenDistributor(
                msg.sender, // owner: 合约拥有者，可提取剩余资金
                operator, // operator: 管理员，可设置merkle根和开始时间
                token, // token: 奖励代币地址
                initialTotalAmount // initialTotalAmount: 总奖励金额
            )
        );
        if (token == ETH_ADDRESS) {
            // 校验调用者发送的ETH与分发金额是否完全匹配
            if (msg.value != initialTotalAmount) revert AmountMismatch();

            // 向分发合约转入ETH
            (bool success,) = payable(distributorAddress).call{value: initialTotalAmount}("");
            if (!success) revert NativeSendFailed();
        } else {
            // 校验未意外发送ETH
            if (msg.value > 0) revert UnexpectedNative();
            // 从创建者转账ERC20代币到分发合约
            IERC20(token).safeTransferFrom(msg.sender, distributorAddress, initialTotalAmount);
        }

        // 记录新创建的分发合约
        isDistributor[distributorAddress] = true;

        // 触发事件
        emit DistributorCreated(msg.sender, operator, token, distributorAddress);
    }
}
