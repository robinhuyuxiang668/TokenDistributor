use anchor_lang::prelude::*;

/**
 * 个人申领状态账户
 *
 * 此结构跟踪分发中每个用户的申领进度。
 * 支持单次申领（当根设置一次时）或通过调整 maxAmount 而不重置先前申领的增量分发。
 *
 * 派生：["claim", distributor_key, claimant_key]
 *
 * 生命周期：
 * 1. 在首次申领时创建（使用 init_if_needed）
 * 2. 每次后续申领时更新
 * 3. 分发结束后可以关闭以回收租金
 *
 * 设计说明：
 * - 每个（分发器，申领者）对有一个 ClaimStatus 账户
 * - 实现高效的个人申领进度跟踪
 * - 当操作员更新默克尔根时防止重复申领
 */
#[account]
#[derive(Default, Debug)]
pub struct ClaimStatus {
    /// 此用户累积申领的总量
    pub claimed_amount: u64,
}

impl ClaimStatus {
    /// 计算此账户所需的空间
    /// - 包括 8 字节鉴别器 + 结构体大小
    pub const LEN: usize = 8 + std::mem::size_of::<ClaimStatus>();
}
