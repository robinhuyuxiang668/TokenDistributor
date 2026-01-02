# 代币分发器

一个基于 Solana 的代币分发程序，利用默克尔树（Merkle Tree）验证机制实现对多个接收者的高效安全空投。该程序支持大规模代币分发，并为 Solana 生态提供了先进的管理特性。

## 项目结构

```
Boost-TokenDistributor-Solana/
├── programs/
│   └── token_distributor/
│       ├── Cargo.toml
│       ├── Xargo.toml
│       └── src/
│           ├── constants.rs
│           ├── error.rs
│           ├── event.rs
│           ├── instructions/
│           │   ├── claim.rs
│           │   ├── close_claim_status.rs
│           │   ├── create_distributor.rs
│           │   ├── mod.rs
│           │   ├── set_merkle_root.rs
│           │   ├── set_time.rs
│           │   └── withdraw.rs
│           ├── lib.rs
│           ├── state/
│           │   ├── claim_state.rs
│           │   ├── distributor_state.rs
│           │   ├── mod.rs
│           │   └── nonce_state.rs
│           ├── test/
│           │   ├── mod.rs
│           │   └── test_merkle.rs
│           └── utils/
│               ├── mod.rs
│               ├── token.rs
│               └── verify.rs
├── tests/
│   ├── token_distributor.ts
│   ├── token_distributor_bankrun.ts
│   ├── token_distributor_bankrun_simple.ts
│   ├── token_distributor_litesvm.ts
│   └── utils/
│       └── merkle_tree.ts
├── Anchor.toml
├── Cargo.toml
├── package.json
└── README.md
```

### 安装与设置

```bash
# 安装依赖
yarn install

# 构建程序
anchor build

# 运行测试
anchor test
```

### 测试

本项目包含多套测试以确保充分验证功能：

- **标准 Anchor 测试**：`tests/token_distributor.ts` - 传统 Anchor 框架测试
- **Bankrun 测试**：`tests/token_distributor_bankrun.ts` - 高性能测试框架
- **LiteSVM 测试**：`tests/token_distributor_litesvm.ts` - 快速模拟测试
- **简易 Bankrun**：`tests/token_distributor_bankrun_simple.ts` - 简化测试示例

## 程序功能

### 核心指令

- **create_distributor**：初始化新的分发活动，自动管理 nonce
- **set_time**：设置分发的起始和结束时间（14 天窗口，可在分发前修改）
- **set_merkle_root**：设置默克尔根实现领取验证
- **claim**：用户提交默克尔证明领取代币
- **withdraw**：分发结束后提取剩余代币
- **close_claim_status**：关闭领取状态账户，回收租金

### 主要特性

- **默克尔树验证**：安全高效地校验领取资格
- **定时分发窗口**：可配置的 14 天领取周期
- **基于角色的访问控制**：所有者与操作员权限分离
- **持续的领取追踪**：默克尔根更新后仍可追踪领取状态
- **跨程序兼容**：支持 SPL Token 及 Token 2022
- **事件系统**：全面事件跟踪与分析支持

## 架构简述

- **Distributor PDA**：保存分发参数及状态
- **Token Vault PDA**：托管待分发代币，由分发合约控制
- **Claim Status PDAs**：追踪各用户领取进度
- **Owner Nonce PDA**：管理多重分发活动的自动 nonce 分配
- **Merkle Tree**：链下结构，实现高效领取验证
