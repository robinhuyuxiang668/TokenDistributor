use crate::error::*;
use crate::event::*;
use crate::state::*;
use anchor_lang::prelude::*;

/**
 * 设置默克尔根的账户上下文
 *
 * 此指令允许指定的操作员设置将用于验证代币申领的默克尔根哈希。
 *
 * 访问控制：只有操作员可以设置默克尔根
 *
 * 业务逻辑：
 * - 默克尔根定义谁可以申领代币以及申领多少
 * - 默克尔树中的每个叶子表示一个（申领者，数量）对
 * - 申领者必须提供有效的默克尔证明才能申领其代币
 * - 如果需要，操作员可以更新默克尔根
 */
#[event_cpi]
#[derive(Accounts)]
pub struct SetMerkleRoot<'info> {
    /// 要更新的分发器账户
    /// - 必须是有效的现有分发器 PDA
    #[account(mut)]
    pub distributor: Account<'info, TokenDistributor>,

    /// 可以设置默克尔根的操作员
    /// - 只有存储在分发器中的操作员可以调用此指令
    #[account(constraint = operator.key() == distributor.operator @ TokenDistributorError::OnlyOperator)]
    pub operator: Signer<'info>,
}

/**
 * 设置代币分发的默克尔根
 *
 * 此函数配置将用于验证代币申领的默克尔根哈希
 *
 * @param ctx - 包含分发器和操作员账户的账户上下文
 * @param merkle_root - 表示默克尔树根的 32 字节哈希
 *
 * 默克尔树结构：
 * - 每个叶子：hash(claimant_pubkey + max_amount)
 * - 中间节点：hash(left_child + right_child)，使用字典排序
 * - 根：树顶部的最终哈希
 *
 * 验证规则：
 * - 默克尔根不能全为零（空哈希）
 * - 只有指定的操作员可以设置默克尔根
 * - 如果需要，默克尔根可以多次更新
 *
 * 使用说明：
 * - 默克尔根应该从符合条件的申领者列表在链下生成
 * - 每个申领者都需要一个默克尔证明来验证他们在申领期间的资格
 * - 默克尔树构造应使用与 verify 函数相同的哈希算法
 */
pub fn handle_set_merkle_root(ctx: Context<SetMerkleRoot>, merkle_root: [u8; 32]) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;

    // 验证默克尔根不为空
    require!(merkle_root != [0; 32], TokenDistributorError::InvalidMerkleRoot);

    // 设置用于申领验证的默克尔根
    distributor.merkle_root = merkle_root;

    emit_cpi!(MerkleRootSet { distributor: distributor.key(), operator: ctx.accounts.operator.key(), merkle_root });

    Ok(())
}
