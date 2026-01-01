# Token Distributor（代币分发器）

本仓库提供了TokenDistributor的详细文档和智能合约示例——一个以安全性、燃气效率和可扩展性为核心构建的复杂代币分发平台。该平台支持ERC20代币和原生代币（ETH），能够满足灵活的多种发放需求。

## 项目结构

```
contracts/
├── DistributorFactory.sol    # 用于创建分发器合约的工厂合约
└── TokenDistributor.sol      # 支持Merkle树校验的核心分发合约

test/
├── DistributorFactoryTest.t.sol     # 完整的单元与集成测试
├── DistributorComplexTest.t.sol     # 基于真实Merkle树校验的高级测试
└── NativeTokenDistributorTest.t.sol # 原生代币的分发测试
```

## 智能合约说明

### DistributorFactory.sol

一个工厂合约，使任何人都可以为ERC20或原生代币创建分发活动。

**主要特性：**
- **工厂模式**：创建新的 `TokenDistributor` 分发合约实例
- **双代币支持**：同时支持ERC20代币与原生代币（ETH）
- **自动转账**：自动将代币从创建者转至分发合约
- **权限校验**：校验代币地址、操作员地址和分发总额
- **事件追踪**：通过 `DistributorCreated` 事件进行透明化跟踪

**核心函数：**
- `createDistributor(address token, address operator, uint256 initialTotalAmount)` —— 新建分发合约
  - ERC20: 需要充足余额且授权
  - 原生代币: 需在交易中携带ETH

**安全特性：**
- 自定义错误，节省燃气
- 输入校验，防止零地址和零金额
- 使用SafeERC20进行安全的代币转账
- 严格检测和保护原生代币转账

### TokenDistributor.sol

基于Merkle树的高级分发合约，支持ERC20和原生代币。

**主要特性：**
- **Merkle树校验**：高效支持大量地址的分发
- **双代币支持**：全面覆盖ERC20和原生代币（ETH）
- **时间限制分发**：可配置开始/结束时间，默认持续14天
- **递增式领取**：支持部分领取与分发额度调整
- **权限管理**：区分owner与operator角色
- **防重入攻击**：采用OpenZeppelin的ReentrancyGuard

**核心函数：**
- `setTime(uint256 _startTime)` —— 设置分发开始时间，仅operator可调用
- `setMerkleRoot(bytes32 _merkleRoot)` —— 设定领取Merkle根，仅operator可调用
- `claim(uint256 maxAmount, bytes32[] calldata proof)` —— 利用Merkle证明领取代币
- `withdraw()` —— 分发前或结束后提取剩余资金，仅owner可调用


**常量说明：**
- `DURATION = 14 days` —— 分发周期
- `MAX_START_TIME = 90 days` —— 最大可配置的未来开始时间
- `ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` —— 原生代币 (ETH) 标识符

## 测试套件

### DistributorTest.t.sol

完整测试覆盖所有ERC20和原生代币功能。

**测试类别：**

**工厂测试：**
- 成功创建ERC20分发器
- 成功创建原生代币分发器
- 输入校验（无效代币、操作员、金额）
- ERC20授权校验不足的情况
- 原生代币数量校验

**分发合约核心测试：**
- 构造函数参数验证
- 时间设置与限制
- Merkle根设置与更新
- 领取功能，并覆盖多场景测试
- 提现及权限控制

**集成测试：**
- 完整流程：创建至提现
- 多用户场景
- 递增式领取
- 原生代币分发生命周期

**边界&异常测试：**
- 无效Merkle证明、无效金额
- 防止重复领取
- 时序限制
- 权限校验
- 原生代币特殊场景

### DistributorComplexTest.t.sol

针对ERC20的真实Merkle树高级测试。

**主要特性：**
- **真实Merkle树**：内置完整的Merkle树生成与校验逻辑
- **多用户测试**：三位用户（Alice、Bob、Charlie）领取数额各异
- **复杂流程测试**：端到端的分发场景
- **证明校验**：验证有效与无效Merkle证明
- **递增式领取**：演示分发增量领取能力

### NativeTokenDistributorTest.t.sol

专注于原生代币分发功能的测试套件。

**主要特性：**
- **原生代币全流程**：包括ETH分发完整流程测试
- **工厂集成测试**：通过工厂创建原生代币分发器
- **领取测试**：结合Merkle校验的ETH领取
- **提现测试**：owner提取未领取ETH
- **边界&异常**：原生代币相关的特殊错误处理


### 主要亮点

**安全性：**
- 防重入保护
- owner/operator 权限分离
- 基于Merkle树的高效校验
- 时间限制与数据验证
- 原生代币严格校验