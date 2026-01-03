use crate::constants::*;
use crate::error::*;
use crate::event::*;
use crate::state::*;
use crate::utils::transfer_token;
use crate::utils::verify;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use solana_program::hash::{hashv, Hash};

/**
 * 申领代币的账户上下文
 *
 * 此指令允许符合条件的用户通过提供有效的默克尔证明来申领分配给他们的代币。
 * 该指令验证证明、更新申领状态，并将代币从金库转移到申领者。
 *
 */
#[event_cpi]
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub distributor: Account<'info, TokenDistributor>,

    /// 此申领者的个人申领状态
    /// - 跟踪此用户已申领的数量
    /// - 派生自：["claim", distributor_key, claimant_key]
    #[account(
        init_if_needed,
        payer = claimant,
        space = ClaimStatus::LEN,
        seeds = [CLAIM_SEED.as_bytes(), distributor.key().as_ref(), claimant.key().as_ref()],
        bump
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    /// 持有待分发代币的代币金库
    /// - 由分发器 PDA 控制
    /// - 派生自：["vault", distributor_key]
    #[account(
        mut,
        seeds = [VAULT_SEED.as_bytes(), distributor.key().as_ref()],
        bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// 申领者接收代币的代币账户
    /// - 必须由申领者拥有
    /// - 必须用于正确的代币铸造
    #[account(
        mut,
        token::mint = distributor.token_mint,
        token::authority = claimant,
        token::token_program = token_program,
    )]
    pub claimant_token_account: InterfaceAccount<'info, TokenAccount>,

    /// 用于验证的代币铸造
    /// - 必须匹配分发器的代币铸造
    #[account(
        mint::token_program = token_program,
        constraint = token_mint.key() == distributor.token_mint @ TokenDistributorError::TokenMintMismatch
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// 尝试申领代币的申领者
    #[account(mut)]
    pub claimant: Signer<'info>,

    /// 用于账户创建的系统程序
    pub system_program: Program<'info, System>,

    /// 代币程序（支持 SPL Token 和 Token 2022）
    pub token_program: Interface<'info, TokenInterface>,
}

/**
 * 使用默克尔证明验证处理代币申领
 *
 * @param ctx - 包含所有必需账户的账户上下文
 * @param max_amount - 此用户有资格申领的最大数量（来自默克尔树）
 * @param proof - 形成默克尔证明路径的 32 字节哈希数组
 *
 * 验证过程：
 * 1. 验证默克尔根已设置且分发处于活动状态
 * 2. 检查当前时间是否在分发窗口内
 * 3. 验证（申领者，max_amount）对的默克尔证明
 * 4. 计算并转移待处理数量
 */
pub fn handle_claim(ctx: Context<Claim>, max_amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;
    let claim_status = &mut ctx.accounts.claim_status;

    // ===== 验证阶段 =====

    // 确保已设置默克尔根
    require!(distributor.merkle_root != [0; 32], TokenDistributorError::NoMerkleRoot);

    // 验证分发处于活动状态（在时间窗口内）
    let current_time = Clock::get()?.unix_timestamp;
    // 检查是否已设置开始时间
    require!(distributor.start_time > 0, TokenDistributorError::StartTimeNotSet);

    // 检查分发时间是否在窗口内
    require!(current_time >= distributor.start_time, TokenDistributorError::DistributionNotStarted);
    require!(current_time <= distributor.end_time, TokenDistributorError::DistributionEnded);

    // 检查用户是否仍可以申领更多代币
    let claimed_amount = claim_status.claimed_amount;
    require!(max_amount > claimed_amount, TokenDistributorError::InvalidAmount);

    // ===== 默克尔证明验证 =====

    let claimant_account = &ctx.accounts.claimant;

    // 创建叶子节点哈希（claimant_pubkey + max_amount）
    // Solana 的 hashv 实现使用 SHA-256（不是 Keccak-256！）
    let leaf: Hash = hashv(&[&claimant_account.key().to_bytes(), &max_amount.to_le_bytes()]);

    // 验证默克尔证明
    // 这确保用户有资格申领该数量
    require!(verify(proof, distributor.merkle_root, leaf.to_bytes()), TokenDistributorError::InvalidProof);

    // ===== 效果阶段（状态更新） =====

    // 计算要转移的数量
    let pending_amount = max_amount - claimed_amount;

    // 检查金库是否有足够的余额
    require!(ctx.accounts.token_vault.amount >= pending_amount, TokenDistributorError::InsufficientVaultBalance);

    let nonce_bytes = distributor.nonce.to_le_bytes();
    let token_mint_key = distributor.token_mint;
    let owner_key = distributor.owner;
    let distributor_bump = distributor.bump;
    let distributor_key = distributor.key();

    // 更新申领状态（CEI 模式 - 交互前先更新效果）
    claim_status.claimed_amount = max_amount; // 设置为总数量

    // 使用溢出保护计算新的总申领数量
    let new_total_claimed = distributor.total_claimed.checked_add(pending_amount).ok_or(TokenDistributorError::ArithmeticOverflow)?;

    // 更新分发器的总申领数量
    distributor.total_claimed = new_total_claimed;

    // ===== 交互阶段（代币转移） =====

    // 准备用于代币转移的 PDA 签名种子
    let seeds = &[DISTRIBUTOR_SEED.as_bytes(), token_mint_key.as_ref(), owner_key.as_ref(), nonce_bytes.as_ref(), &[distributor_bump]];
    let signer = &[&seeds[..]];

    // 使用 PDA 权限从金库向申领者转移代币
    transfer_token(
        ctx.accounts.distributor.to_account_info(), // 延迟 AccountInfo 获取
        ctx.accounts.token_vault.to_account_info(),
        ctx.accounts.claimant_token_account.to_account_info(),
        ctx.accounts.token_mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        pending_amount,
        ctx.accounts.token_mint.decimals,
        Some(signer), // PDA 签名以确保安全转移
    )?;

    emit_cpi!(TokensClaimed {
        distributor: distributor_key,
        claimant: ctx.accounts.claimant.key(),
        user_amount_claimed: pending_amount, // 用户在此交易中申领的数量
        user_max_amount: max_amount,         // 用户有资格申领的最大数量
        total_claimed: new_total_claimed,    // 分发器申领的总数量
    });

    Ok(())
}
