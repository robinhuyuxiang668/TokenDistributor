use crate::constants::*;
use crate::error::*;
use crate::event::*;
use crate::state::*;
use crate::utils::{close_token_account_with_pda, transfer_token};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

/**
 * 提取剩余代币的账户上下文
 *
 * 此指令允许分发器拥有者从金库中提取任何剩余代币。
 * 这作为清理机制来回收未分发的代币。
 *
 * 访问控制：只有拥有者可以提取剩余代币
 *
 * 业务逻辑：
 * - 可以在两种情况下调用：
 *   1. 分发期结束后（current_time > end_time）
 *   2. 如果从未设置分发时间（start_time = 0, end_time = 0）
 * - 从金库提取所有剩余代币
 * - 关闭金库代币账户以回收租金
 * - 关闭分发器账户以回收租金
 */
#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// 要从中提取并关闭的分发器账户
    /// - 必须是有效的分发器 PDA
    /// - 将被关闭，租金返还给拥有者
    #[account(
        mut,
        close = owner
    )]
    pub distributor: Account<'info, TokenDistributor>,

    /// 包含剩余代币的代币金库
    /// - 由分发器 PDA 控制
    /// - 派生自：["vault", distributor_key]
    /// - 将被清空并关闭
    #[account(
        mut,
        seeds = [VAULT_SEED.as_bytes(), distributor.key().as_ref()],
        bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// 拥有者接收剩余代币的代币账户
    #[account(
        mut,
        token::mint = distributor.token_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,

    /// 用于验证的代币铸造
    /// - 必须匹配分发器的代币铸造
    /// - 用于 transfer_checked 验证
    #[account(
        token::token_program = token_program,
        constraint = token_mint.key() == distributor.token_mint @ TokenDistributorError::TokenMintMismatch
    )]
    pub token_mint: InterfaceAccount<'info, anchor_spl::token_interface::Mint>,

    /// 分发器的拥有者
    /// - 必须匹配存储在分发器状态中的拥有者
    /// - 接收剩余代币和回收的租金
    #[account(
        mut,
        constraint = owner.key() == distributor.owner @ TokenDistributorError::OnlyOwner
    )]
    pub owner: Signer<'info>,

    /// 代币程序（支持 SPL Token 和 Token 2022）
    pub token_program: Interface<'info, TokenInterface>,
}

/**
 * 从分发器提取剩余代币
 *
 * @param ctx - 包含所有必需账户的账户上下文
 *
 * @returns Result<()> - 成功或错误
 *
 * 验证规则：
 * - 分发必须已结束或从未开始
 * - 只有拥有者可以调用此函数
 */
pub fn handle_withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let distributor = &ctx.accounts.distributor;

    // ===== 验证阶段 =====

    // 在允许提取之前，确保分发已结束或从未开始
    let current_time = Clock::get()?.unix_timestamp;
    require!(current_time > distributor.end_time, TokenDistributorError::DistributionNotEnded);

    // 获取剩余余额用于可能的转移和事件发出
    let remaining_balance = ctx.accounts.token_vault.amount;

    // ===== 交互阶段（代币转移和清理） =====

    // 准备用于代币操作的 PDA 签名种子
    let nonce_bytes = distributor.nonce.to_le_bytes();
    let seeds = &[
        DISTRIBUTOR_SEED.as_bytes(),
        distributor.token_mint.as_ref(),
        distributor.owner.as_ref(),
        nonce_bytes.as_ref(),
        &[distributor.bump],
    ];
    let signer = &[&seeds[..]];

    // 仅在存在剩余代币时转移
    if remaining_balance > 0 {
        // 兼容 SPL Token 和 Token 2022
        transfer_token(
            ctx.accounts.distributor.to_account_info(),
            ctx.accounts.token_vault.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.token_mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            remaining_balance,
            ctx.accounts.token_mint.decimals,
            Some(signer), // PDA 签名以确保安全转移
        )?;
    }

    // 关闭金库代币账户以回收租金
    // 这会将租金返还给拥有者并清理账户
    close_token_account_with_pda(
        ctx.accounts.token_vault.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.distributor.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        signer, // PDA 签名以确保安全关闭
    )?;

    emit_cpi!(TokensWithdrawn { distributor: distributor.key(), owner: ctx.accounts.owner.key(), amount_withdrawn: remaining_balance });

    Ok(())
}
