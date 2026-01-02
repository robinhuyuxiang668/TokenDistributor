use anchor_lang::prelude::*;

#[constant]
/// ===== 时间常量 =====

/// 每个分发周期的持续时间（14 天）
/// - 在设置 start_time 时应用以计算 end_time
/// - 值：14 天 * 24 小时 * 60 分钟 * 60 秒 = 1,209,600 秒
pub const DURATION: i64 = 14 * 24 * 60 * 60; // 14 天（秒）

/// 允许的最大未来开始时间（90 天）
/// - 每次修改限制为距当前时间最多 90 天
/// - 防止在单次操作中设置过远的时间
/// - 值：90 天 * 24 小时 * 60 分钟 * 60 秒 = 7,776,000 秒
pub const MAX_START_TIME: i64 = 90 * 24 * 60 * 60; // 90 天（秒）

/// ===== PDA 种子常量 =====

/// 拥有者 nonce PDA 派生的种子
/// - 用于：["owner_nonce", owner]
/// - 为每个拥有者创建唯一的 nonce 跟踪账户
/// - 实现分发器的自动 nonce 分配
pub const OWNER_NONCE_SEED: &str = "owner_nonce";

/// 分发器 PDA 派生的种子
/// - 用于：["distributor", token_mint, owner, nonce]
/// - 为每个（代币，拥有者，nonce）组合创建唯一的分发器账户
/// - 确保确定性和无冲突的 PDA 生成
pub const DISTRIBUTOR_SEED: &str = "distributor";

/// 代币金库 PDA 派生的种子
/// - 用于：["vault", distributor_key]
/// - 为每个分发器创建唯一的金库
/// - 确保金库由分发器 PDA 控制
pub const VAULT_SEED: &str = "vault";

/// 申领状态 PDA 派生的种子
/// - 用于：["claim", distributor_key, claimant_key]
/// - 为每个（分发器，申领者）对创建唯一的申领跟踪
/// - 实现高效的申领状态管理并防止重复申领
/// - 即使操作员更新默克尔根也跟踪累积的申领数量
pub const CLAIM_SEED: &str = "claim";
