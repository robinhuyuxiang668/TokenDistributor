use crate::constants::*;
use crate::error::*;
use crate::event::*;
use crate::state::*;
use crate::utils::transfer_token;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

/**
 * 创建代币分发器
 *
 * 自动 nonce 初始化新的代币分发器：
 * - 创建具有自动递增 nonce 的分发器 PDA
 * - 创建金库代币 PDA
 * - 将初始代币数量从拥有者转移到金库
 * - 设置可以管理分发的操作员
 *
 * 访问控制：只有拥有者可以创建分发器
 *
 * #[event_cpi]:
 * 当前指令被 CPI调用时，仍然能够正常 emit事件
 */
#[event_cpi]
#[derive(Accounts)]
pub struct CreateDistributor<'info> {
    /// 跟踪此拥有者 nonce 编号的 Nonce 状态账户（PDA）
    /// - 存储当前 nonce 计数器以进行自动 nonce 分配
    /// - 派生自：["owner_nonce", owner]
    #[account(
        init_if_needed,
        payer = owner,
        space = NonceState::LEN,
        seeds = [OWNER_NONCE_SEED.as_bytes(), owner.key().as_ref()],
        bump
    )]
    pub owner_nonce: Account<'info, NonceState>,

    /// 主分发器账户（PDA）
    /// - 存储所有分发参数和状态
    /// - 派生自：["distributor", token_mint, owner, current_nonce]
    /// - Nonce 自动从 owner_nonce.nonce + 1 确定
    #[account(
        init,
        payer = owner,
        space = TokenDistributor::LEN,
        seeds = [
            DISTRIBUTOR_SEED.as_bytes(),
            token_mint.key().as_ref(),
            owner.key().as_ref(),
            (owner_nonce.nonce + 1).to_le_bytes().as_ref()
        ],
        bump
    )]
    pub distributor: Account<'info, TokenDistributor>,

    /// 持有待分发代币的代币金库账户（PDA）
    /// - 由分发器 PDA 作为代币权限控制
    /// - 派生自：["vault", distributor_key]
    #[account(
        init,
        payer = owner,
        seeds = [VAULT_SEED.as_bytes(), distributor.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = distributor,
        token::token_program = token_program,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// 正在分发的铸造代币
    /// - 支持 SPL Token 和 Token 2022 程序
    #[account(
        mint::token_program = token_program,
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// owner的代币账户
    /// - 必须由拥有者签名者拥有
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,

    /// 分发器的拥有者
    /// - 对分发器拥有完全控制权
    /// - 可以在分发结束后提取剩余代币
    #[account(mut)]
    pub owner: Signer<'info>,

    /// 可以管理分发的操作员账户
    /// - 可以设置开始时间和更新默克尔根
    /// CHECK:通过将其公钥存储在分发器PDA来验证此账户
    pub operator: AccountInfo<'info>,

    /// 用于账户创建的系统程序
    pub system_program: Program<'info, System>,

    /// 代币程序（支持 SPL Token 和 Token 2022）
    pub token_program: Interface<'info, TokenInterface>,
}

/**
 * 使用自动 nonce 管理创建新的代币分发器
 *
 * @param ctx - 包含所有必需账户的账户上下文
 * @param initial_total_amount - 要分发的代币总数量
 */
pub fn handle_create_distributor(ctx: Context<CreateDistributor>, initial_total_amount: u64) -> Result<()> {
    // 验证初始总数量
    require!(initial_total_amount > 0, TokenDistributorError::InvalidAmount);

    // 验证操作员不是空账户
    require!(ctx.accounts.operator.key() != Pubkey::default(), TokenDistributorError::InvalidOperator);

    let owner_nonce = &mut ctx.accounts.owner_nonce;
    let distributor = &mut ctx.accounts.distributor;

    // 使用溢出保护计算 nonce 编号
    let current_nonce = owner_nonce.nonce.checked_add(1).ok_or(TokenDistributorError::ArithmeticOverflow)?;

    // 使用当前 nonce 更新 nonce 状态
    owner_nonce.nonce = current_nonce;

    // 使用自动分配的 nonce 初始化分发器状态
    distributor.bump = ctx.bumps.distributor;
    distributor.nonce = current_nonce;
    distributor.owner = ctx.accounts.owner.key();
    distributor.operator = ctx.accounts.operator.key();
    distributor.token_mint = ctx.accounts.token_mint.key();
    distributor.token_vault = ctx.accounts.token_vault.key();
    distributor.initial_total_amount = initial_total_amount;
    // 注意：total_claimed、start_time、end_time、merkle_root 使用默认值（0）

    // 从拥有者转移代币到金库
    // 使用 transfer_checked 以兼容 SPL Token 和 Token 2022
    transfer_token(
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.owner_token_account.to_account_info(),
        ctx.accounts.token_vault.to_account_info(),
        ctx.accounts.token_mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        initial_total_amount,
        ctx.accounts.token_mint.decimals,
        None, // 拥有者签名的转移不需要签名种子
    )?;

    // 使用 emit_cpi:当前指令被 CPI调用时，仍然能够正常 emit事件
    emit_cpi!(DistributorCreated {
        distributor: distributor.key(),
        nonce: current_nonce,
        owner: ctx.accounts.owner.key(),
        operator: ctx.accounts.operator.key(),
        token_mint: ctx.accounts.token_mint.key(),
        token_vault: ctx.accounts.token_vault.key(),
        initial_total_amount,
    });

    Ok(())
}
