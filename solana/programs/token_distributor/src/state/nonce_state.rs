use anchor_lang::prelude::*;

/**
 * Nonce 状态账户
 *
 * 此结构跟踪每个拥有者的 nonce 计数器，实现新分发器的自动 nonce 分配。
 *
 * 设计说明：
 * - 每个拥有者一个 NonceState 账户
 * - 实现自动 nonce 分配
 */
#[account]
#[derive(Default, Debug)]
pub struct NonceState {
    /// 每次创建分发器时递增
    /// - 确保每个拥有者的分发器具有唯一的 nonce
    pub nonce: u32,
}

impl NonceState {
    /// 计算此账户所需的空间
    /// - 包括 8 字节鉴别器 + 结构体大小
    pub const LEN: usize = 8 + std::mem::size_of::<NonceState>();
}
