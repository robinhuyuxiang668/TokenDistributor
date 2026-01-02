use anchor_lang::prelude::*;

declare_id!("2Ab8No85xrnnd2rFamKjQqGAK6Qu9EQ4eEh59oaZEPBL");

pub mod constants;
pub mod error;
pub mod event;
pub mod instructions;
pub mod state;
pub mod utils;

#[cfg(test)]
pub mod test;

use instructions::*;

/**
 * 代币分发程序
 *
 * 一个使用默克尔树验证向多个接收者分发代币的 Solana 程序。
 * 该程序通过以下功能实现高效且安全的代币空投：
 *
 * 主要功能：
 * - 基于默克尔树的申领验证
 * - 支持单次申领（当根设置一次时）或通过调整 max_amount 而不重置先前申领的增量分发
 * - 灵活的默克尔根更新（操作员可以随时更新根，无时间限制）
 * - 时间限制的分发（可配置的开始和结束时间）
 * - 操作员委托（独立的拥有者和操作员角色）
 * - 跨程序调用事件发出以实现可组合性
 * - 支持 SPL Token 和 Token 2022
 *
 * 架构：
 * - Nonce State PDA：跟踪每个拥有者的 nonce 计数器（自动 nonce 管理）
 * - Distributor PDA：存储分发参数和状态
 * - Token Vault PDA：持有待分发的代币
 * - Claim Status PDAs：跟踪每个用户已申领的数量
 *
 * 工作流程：
 * 1. 拥有者创建分发器并存入代币
 * 2. 操作员设置开始时间和默克尔根
 * 3. 用户使用有效的默克尔证明申领代币
 * 4. 拥有者在分发结束后提取剩余代币
 * 5. 用户可以选择关闭 ClaimStatus 账户以回收租金
 */
#[program]
pub mod token_distributor {
    use super::*;

    /**
     * 创建新的代币分发器
     *
     * 使用自动 nonce 管理初始化新的代币分发活动。
     * 拥有者将代币存入由分发器 PDA 控制的金库。
     * Nonce 编号使用拥有者特定的计数器自动分配。
     *
     * @param ctx - 包含分发器、金库、计数器和拥有者账户的账户上下文
     * @param initial_total_amount - 要分发的代币总数量
     *
     * 访问控制：仅拥有者
     */
    pub fn create_distributor(ctx: Context<CreateDistributor>, initial_total_amount: u64) -> Result<()> {
        handle_create_distributor(ctx, initial_total_amount)
    }

    /**
     * 设置分发时间
     *
     * 配置代币分发何时开始，并自动
     * 计算结束时间（start_time + 14 天）。
     *
     * @param ctx - 包含分发器和操作员账户的账户上下文
     * @param start_time - 分发应开始的 Unix 时间戳
     *
     * 访问控制：仅操作员
     */
    pub fn set_time(ctx: Context<SetTime>, start_time: i64) -> Result<()> {
        handle_set_time(ctx, start_time)
    }

    /**
     * 设置用于申领验证的默克尔根
     *
     * 配置将用于验证代币申领的默克尔根哈希。
     * 默克尔根表示所有符合条件的（申领者，数量）对的树。
     *
     * @param ctx - 包含分发器和操作员账户的账户上下文
     * @param merkle_root - 表示默克尔树根的 32 字节哈希
     *
     * 访问控制：仅操作员
     * 注意：如果需要，默克尔根可以多次更新
     */
    pub fn set_merkle_root(ctx: Context<SetMerkleRoot>, merkle_root: [u8; 32]) -> Result<()> {
        handle_set_merkle_root(ctx, merkle_root)
    }

    /**
     * 使用默克尔证明验证申领代币
     *
     * 允许符合条件的用户通过提供有效的默克尔证明来申领分配给他们的代币
     * @param ctx - 包含分发器、申领状态和代币账户的账户上下文
     * @param max_amount - 此用户有资格申领的最大数量
     * @param proof - 形成默克尔证明的 32 字节哈希数组
     *
     * 访问控制：任何具有有效默克尔证明的用户
     */
    pub fn claim(ctx: Context<Claim>, max_amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        handle_claim(ctx, max_amount, proof)
    }

    /**
     * 关闭 ClaimStatus 账户并回收租金
     *
     * 允许用户在分发结束后关闭其 ClaimStatus 账户，
     * 以回收他们在账户创建时支付的租金。
     *
     * @param ctx - 包含申领状态和申领者账户的账户上下文
     *
     * 访问控制：仅申领者（通过 PDA seeds 强制执行）
     *
     * 注意：这使用户能够选择性地回收参与申领的成本
     */
    pub fn close_claim_status(ctx: Context<CloseClaimStatus>) -> Result<()> {
        handle_close_claim_status(ctx)
    }

    /**
     * 在分发结束后提取剩余代币
     *
     * 允许拥有者在分发期结束后回收任何未分发的代币。
     * 这也会关闭分发器和金库账户。
     *
     * @param ctx - 包含分发器、金库和拥有者账户的账户上下文
     *
     * 访问控制：仅拥有者
     * 注意：这提供了完整的清理和租金回收
     */
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        handle_withdraw(ctx)
    }
}
