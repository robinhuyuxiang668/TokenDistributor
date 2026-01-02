use crate::constants::*;
use crate::error::*;
use crate::event::*;
use crate::state::*;
use anchor_lang::prelude::*;

/**
 * 设置分发时间
 *
 * 此指令允许指定的操作员设置代币分发何时开始，
 * 并根据 DURATION 常量自动计算结束时间。
 *
 * 访问控制：只有操作员可以设置时间
 *
 * 业务逻辑：
 * - 在分发开始前可以多次修改时间
 * - 一旦分发开始，时间就不能再修改
 * - 每次修改限制为距当前时间最多 90 天（防止在单次操作中设置过远的时间）
 * - 结束时间自动计算为 time + DURATION
 */
#[event_cpi]
#[derive(Accounts)]
pub struct SetTime<'info> {
    /// 要更新的分发器账户
    /// - 必须是有效的现有分发器 PDA
    #[account(mut)]
    pub distributor: Account<'info, TokenDistributor>,

    /// 可以设置时间的操作员
    /// - 只有存储在分发器中的操作员可以调用此指令
    #[account(constraint = operator.key() == distributor.operator @ TokenDistributorError::OnlyOperator)]
    pub operator: Signer<'info>,
}

/**
 * 设置代币分发的时间
 *
 * @param ctx - 包含分发器和操作员账户的账户上下文
 * @param start_time - 分发应开始的 Unix 时间戳
 *
 */
pub fn handle_set_time(ctx: Context<SetTime>, start_time: i64) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;

    // 验证时间约束
    let current_time = Clock::get()?.unix_timestamp;

    // 检查分发是否已经开始 - 如果是，则无法修改时间
    if distributor.start_time > 0 && current_time >= distributor.start_time {
        return err!(TokenDistributorError::DistributionAlreadyStarted);
    }

    // 时间必须在未来以防止回溯
    require!(start_time > current_time, TokenDistributorError::InvalidStartTime);

    // 时间不能太远（MAX_START_TIME = 90 天）
    require!(start_time <= current_time + MAX_START_TIME, TokenDistributorError::StartTimeTooFar);

    // 设置分发周期
    distributor.start_time = start_time;
    distributor.end_time = start_time + DURATION; // DURATION = 14 天

    emit_cpi!(StartTimeSet {
        distributor: distributor.key(),
        operator: ctx.accounts.operator.key(),
        start_time,
        end_time: distributor.end_time,
    });

    Ok(())
}
