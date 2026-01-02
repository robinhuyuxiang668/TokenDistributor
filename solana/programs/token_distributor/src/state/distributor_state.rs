use anchor_lang::prelude::*;

/**
 * 主分发器状态账户
 *
 * 此结构表示代币分发活动的核心状态。
 * 它存储管理基于默克尔树的代币分发所需的所有参数和跟踪信息。
 *
 *
 * 生命周期：
 * 1. 在 create_distributor 指令期间创建
 * 2. 在设置 start_time 和 merkle_root 时更新
 * 3. 在申领期间更新（total_claimed 递增）
 * 4. 在 withdraw 指令期间关闭
 */
#[account]
#[derive(Default, Debug)]
pub struct TokenDistributor {
    /// PDA 派生的 Bump 种子
    /// - 保存以避免在申领操作期间重新计算
    pub bump: u8,

    /// 此分发器的 Nonce 编号
    /// - 允许同一代币/拥有者对进行多个分发活动
    pub nonce: u32,

    /// 分发器的拥有者
    /// - 可以在分发结束后提取剩余代币
    pub owner: Pubkey,

    /// 可以管理分发的操作员
    /// - 可以设置开始时间和更新默克尔根
    pub operator: Pubkey,

    /// 代币铸造地址
    /// - 指定正在分发的代币
    pub token_mint: Pubkey,

    /// 金库代币账户地址
    /// - 持有待分发代币的 PDA
    /// - 由分发器 PDA 控制
    /// - 派生自：["vault", distributor_key]
    pub token_vault: Pubkey,

    /// 存入的初始代币总数量
    /// - 在分发器创建期间设置
    pub initial_total_amount: u64,

    /// 所有用户申领的代币总数量
    /// - 每次成功申领时递增
    /// - 用于跟踪分发进度
    pub total_claimed: u64,

    /// 分发的开始时间（Unix 时间戳）
    /// - 由操作员在分发开始前设置
    /// - 只有在此时间之后才允许申领
    pub start_time: i64,

    /// 分发的结束时间（Unix 时间戳）
    /// - 自动计算为 start_time + DURATION
    /// - 只有在此时间之前才允许申领
    /// - 只有在此时间之后才允许提取
    pub end_time: i64,

    /// 用于申领验证的默克尔根
    /// - 表示默克尔树根的 32 字节哈希
    /// - 用于使用默克尔证明验证用户申领
    /// - 操作员可以随时更新
    pub merkle_root: [u8; 32],
}

impl TokenDistributor {
    /// 计算此账户所需的空间
    /// - 包括 8 字节鉴别器 + 结构体大小
    pub const LEN: usize = 8 + std::mem::size_of::<TokenDistributor>();
}
