use anchor_lang::prelude::*;
use anchor_spl::token_interface::{close_account, transfer_checked, CloseAccount, TransferChecked};

/// 支持 SPL Token 和 Token 2022 的通用代币转账函数
pub fn transfer_token<'a>(
    authority: AccountInfo<'a>,
    from: AccountInfo<'a>,
    to: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    token_program: AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let cpi_accounts = TransferChecked { from, mint, to, authority };

    let cpi_program = token_program;

    let cpi_ctx = if let Some(seeds) = signer_seeds {
        CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds)
    } else {
        CpiContext::new(cpi_program, cpi_accounts)
    };

    transfer_checked(cpi_ctx, amount, decimals)
}

/// 使用 PDA 权限关闭 SPL Token 和 Token 2022 的代币账户
pub fn close_token_account_with_pda<'a>(
    token_account: AccountInfo<'a>,
    destination: AccountInfo<'a>,
    authority: AccountInfo<'a>,
    token_program: AccountInfo<'a>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if token_account.get_lamports() == 0 {
        return Ok(());
    }

    let close_accounts = CloseAccount { account: token_account, destination, authority };

    close_account(CpiContext::new_with_signer(token_program, close_accounts, signer_seeds))
}
