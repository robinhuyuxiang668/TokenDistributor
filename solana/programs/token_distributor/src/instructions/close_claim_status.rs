use anchor_lang::prelude::*;
use crate::state::*;
use crate::error::*;
use crate::event::*;
use crate::constants::*;

/**
 * 关闭申领状态账户的账户上下文
 * 
 * 此指令允许用户在分发结束后关闭其 ClaimStatus 账户，
 * 以回收在账户创建时支付的租金。
 * 
 * 访问控制：只有原始申领者可以关闭其 ClaimStatus 账户
 * 
 */
#[event_cpi]
#[derive(Accounts)]
pub struct CloseClaimStatus<'info> {
    /// 要关闭的 ClaimStatus 账户，租金返还给申领者
    /// - 必须是有效的现有 ClaimStatus 账户
    /// - 派生自：["claim", distributor_key, claimant_key]
    /// - 将被关闭，租金返还给申领者
    #[account(
        mut,
        close = claimant,
        seeds = [CLAIM_SEED.as_bytes(), distributor_key.key().as_ref(), claimant.key().as_ref()],
        bump 
    )]
    pub claim_status: Account<'info, ClaimStatus>,
    
    /// 最初创建 ClaimStatus 账户的申领者
    /// - 必须是支付账户创建费用的同一申领者
    /// - 将收到回收的租金
    #[account(mut)]
    pub claimant: Signer<'info>,
    
    /// 用于 PDA 派生和时间验证的分发器账户
    /// CHECK:已关闭或有效的 TokenDistributor
    pub distributor_key: AccountInfo<'info>,
}

/**
 * 关闭 ClaimStatus 账户并将租金返还给申领者
 *
 * @param ctx - 包含 ClaimStatus 和申领者账户的账户上下文
 * 
 * 验证过程：
 * 1. 使用存储的 end_time 检查分发是否已结束
 * 2. Anchor 自动转移 lamports 并关闭账户
 */
pub fn handle_close_claim_status(ctx: Context<CloseClaimStatus>) -> Result<()> {
    let distributor_key = &ctx.accounts.distributor_key;
    
    // 仅在分发器账户仍存在时进行验证
    if distributor_key.data_len() != 0 {
        // 明确验证分发器账户由此程序拥有
        require!(
            distributor_key.owner == &crate::ID,
            TokenDistributorError::DistributorNotOwnedByProgram
        );
        
        // 反序列化分发器数据以访问 end_time
        let distributor_data = distributor_key.try_borrow_data()?;
        let distributor = TokenDistributor::try_deserialize(&mut distributor_data.as_ref())?;
        
        // 检查分发是否已结束
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            current_time > distributor.end_time,
            TokenDistributorError::DistributionNotEnded
        );
    }
    
    // 发出事件用于链下索引和监控
    emit_cpi!(ClaimStatusClosed {
        distributor: ctx.accounts.distributor_key.key(),
        claimant: ctx.accounts.claimant.key(),
        claimed_amount: ctx.accounts.claim_status.claimed_amount,
    });
    
    Ok(())
}