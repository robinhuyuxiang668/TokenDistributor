use anchor_lang::prelude::*;

/// 创建新分发器时发出的事件
#[event]
pub struct DistributorCreated {
    /// 分发器账户公钥
    pub distributor: Pubkey,
    /// 分发器的 Nonce
    pub nonce: u32,
    /// 分发器的拥有者
    pub owner: Pubkey,
    /// 分发器的操作员
    pub operator: Pubkey,
    /// 代币铸造地址
    pub token_mint: Pubkey,
    /// 金库代币地址
    pub token_vault: Pubkey,
    /// 存入的初始代币总数量
    pub initial_total_amount: u64,
}

/// 设置开始时间时发出的事件
#[event]
pub struct StartTimeSet {
    /// 分发器账户公钥
    pub distributor: Pubkey,
    /// 设置开始时间的操作员
    pub operator: Pubkey,
    /// 分发的开始时间
    pub start_time: i64,
    /// 分发的结束时间
    pub end_time: i64,
}

/// 设置默克尔根时发出的事件
#[event]
pub struct MerkleRootSet {
    /// 分发器账户公钥
    pub distributor: Pubkey,
    /// 设置默克尔根的操作员
    pub operator: Pubkey,
    /// 默克尔根哈希
    pub merkle_root: [u8; 32],
}

/// 申领代币时发出的事件
#[event]
pub struct TokensClaimed {
    /// 分发器账户公钥
    pub distributor: Pubkey,
    /// 申领者的地址
    pub claimant: Pubkey,
    /// 用户在此交易中申领的代币数量
    pub user_amount_claimed: u64,
    /// 用户有资格申领的最大数量
    pub user_max_amount: u64,
    /// 所有用户从分发器申领的总数量
    pub total_claimed: u64,
}

/// 提取剩余代币时发出的事件
#[event]
pub struct TokensWithdrawn {
    /// 分发器账户公钥
    pub distributor: Pubkey,
    /// 提取代币的拥有者
    pub owner: Pubkey,
    /// 提取的代币数量
    pub amount_withdrawn: u64,
}

/// 关闭 ClaimStatus 账户时发出的事件
#[event]
pub struct ClaimStatusClosed {
    /// 分发器账户公钥
    pub distributor: Pubkey,
    /// 关闭账户的申领者地址
    pub claimant: Pubkey,
    /// 此用户申领的总数量
    pub claimed_amount: u64,
}
