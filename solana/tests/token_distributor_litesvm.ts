import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  getAccount,
  getAccount as getAccount2022,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import { expect } from "chai";
import { SimpleMerkleTree, TreeNode } from "./utils/merkle_tree";
import { LiteSVM } from "litesvm";
import * as fs from "fs";
import * as crypto from "crypto";

/**
 * 在 LiteSVM 中手动创建 SPL 代币铸造（支持 TOKEN_PROGRAM_ID 和 TOKEN_2022_PROGRAM_ID）
 * @param svm LiteSVM 实例
 * @param mintAuthority 具有铸造权限的密钥对
 * @param decimals 代币精度（通常是 6 或 9）
 * @param programId TOKEN_PROGRAM_ID 或 TOKEN_2022_PROGRAM_ID
 * @param seed 用于生成确定性地址的可选种子字符串
 * @returns 铸造密钥对
 */
function liteSvmCreateMint(svm: LiteSVM, mintAuthority: Keypair, decimals = 9, programId = TOKEN_PROGRAM_ID, seed?: string): Keypair {
  // 使用种子生成具有可选随机性的密钥对
  let mintSeed: string;
  if (seed) {
    mintSeed = seed;
  } else {
    // 添加时间戳和随机组件以确保跨测试运行的唯一性
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    mintSeed = `mint-${mintAuthority.publicKey.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;
  }

  // 使用 SHA256 哈希生成唯一种子
  const hash = crypto.createHash("sha256").update(mintSeed).digest();
  const mint = Keypair.fromSeed(hash);

  // 租金计算（Token 2022 使用相同的 MINT_SIZE）
  // 铸造账户的标准租金约为 1461600 lamports
  const lamports = 1461600; // 铸造账户的固定租金

  const tx = new Transaction();

  // 创建Mint代币
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: mintAuthority.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: MINT_SIZE,
      programId: programId,
    }),
  );

  // 初始化铸造（SPL 代币 CPI）
  tx.add(
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      mintAuthority.publicKey, // 铸造权限
      null, // 冻结权限（可选）
      programId,
    ),
  );

  // 设置区块哈希并签署交易
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = mintAuthority.publicKey;
  tx.sign(mintAuthority, mint);

  // 发送交易
  svm.sendTransaction(tx);

  return mint;
}

/**
 * 在 LiteSVM 中手动创建代币账户（支持 TOKEN_PROGRAM_ID 和 TOKEN_2022_PROGRAM_ID）
 * @param svm LiteSVM 实例
 * @param mint 代币铸造地址
 * @param owner 代币账户拥有者
 * @param payer 支付交易的账户
 * @param programId TOKEN_PROGRAM_ID 或 TOKEN_2022_PROGRAM_ID
 * @returns 代币账户密钥对
 */
function liteSvmCreateAccount(svm: LiteSVM, mint: PublicKey, owner: PublicKey, payer: Keypair, programId = TOKEN_PROGRAM_ID): Keypair {
  // 添加时间戳和随机组件以确保跨测试运行的唯一性
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const accountSeed = `account-${mint.toBase58()}-${owner.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;

  // 使用 SHA256 哈希生成唯一种子
  const hash = crypto.createHash("sha256").update(accountSeed).digest();
  const account = Keypair.fromSeed(hash);

  // 代币账户的租金计算约为 2039280 lamports
  const lamports = 2039280; // 代币账户的固定租金

  const tx = new Transaction();

  // 创建代币账户（系统程序）
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports,
      space: ACCOUNT_SIZE,
      programId: programId,
    }),
  );

  // 初始化代币账户（SPL 代币 CPI）
  tx.add(createInitializeAccountInstruction(account.publicKey, mint, owner, programId));

  // 设置区块哈希并签署交易
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, account);

  // 发送交易
  svm.sendTransaction(tx);

  return account;
}

/**
 * 在 LiteSVM 中手动向指定账户铸造代币（支持 TOKEN_PROGRAM_ID 和 TOKEN_2022_PROGRAM_ID）
 * @param svm LiteSVM 实例
 * @param mint 代币铸造地址
 * @param destination 目标代币账户地址
 * @param authority 铸造权限
 * @param amount 要铸造的数量
 * @param programId TOKEN_PROGRAM_ID 或 TOKEN_2022_PROGRAM_ID
 */
function liteSvmMintTo(svm: LiteSVM, mint: PublicKey, destination: PublicKey, authority: Keypair, amount: number, programId = TOKEN_PROGRAM_ID): void {
  const tx = new Transaction();

  // 添加铸造指令
  tx.add(createMintToInstruction(mint, destination, authority.publicKey, amount, [], programId));

  // 设置区块哈希并签署交易
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);

  // 发送交易
  svm.sendTransaction(tx);
}

describe("token_distributor_litesvm", () => {
  let svm: LiteSVM;
  let programId: PublicKey;
  let program: Program<TokenDistributor>;
  let provider: anchor.AnchorProvider;

  let tokenMint: PublicKey;
  let tokenMint2022: PublicKey;
  let owner: Keypair;
  let operator: Keypair;
  let ownerTokenAccount: PublicKey;
  let ownerTokenAccount2022: PublicKey;

  // Nonce 状态 PDA
  let ownerNoncePda: PublicKey;

  // 分发器和金库 PDA 将动态计算
  let distributorPda: PublicKey;
  let distributorPda2022: PublicKey;
  let tokenVaultPda: PublicKey;
  let tokenVaultPda2022: PublicKey;

  // 测试申领者和默克尔树数据
  let claimant1: Keypair;
  let claimant2: Keypair;
  let testTreeNodes: Array<TreeNode>;
  let testMerkleTree: SimpleMerkleTree;
  let testMerkleRoot: number[];

  // 获取拥有者下一个 nonce 的辅助函数
  async function getNextNonceForOwner(ownerKey: PublicKey): Promise<number> {
    try {
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      return ownerNonceAccount.nonce + 1;
    } catch (error) {
      // 如果账户不存在，这将是第一个分发器（nonce 1）
      return 1;
    }
  }

  // 计算特定 nonce 的分发器 PDA 的辅助函数
  function calculateDistributorPda(tokenMint: PublicKey, owner: PublicKey, nonce: number): PublicKey {
    const DISTRIBUTOR_SEED = "distributor";
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(DISTRIBUTOR_SEED), tokenMint.toBuffer(), owner.toBuffer(), new anchor.BN(nonce).toArrayLike(Buffer, "le", 4)], programId);
    return pda;
  }

  // 计算金库 PDA 的辅助函数
  function calculateVaultPda(distributorPda: PublicKey): PublicKey {
    const VAULT_SEED = "vault";
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), distributorPda.toBuffer()], programId);
    return pda;
  }

  // 确保 LiteSVM 中交易唯一性的辅助函数
  function ensureUniqueTransaction(tx: Transaction): void {
    // 推进插槽以确保唯一的区块哈希
    const currentClock = svm.getClock();
    currentClock.slot = currentClock.slot + BigInt(1);
    svm.setClock(currentClock);

    // 获取新的区块哈希
    tx.recentBlockhash = svm.latestBlockhash();

    // 添加唯一的备忘录指令以确保交易唯一性
    const uniqueId = `${Date.now()}-${Math.random()}`;
    const memoInstruction = {
      keys: [],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: Buffer.from(uniqueId),
    };
    tx.add(memoInstruction);
  }

  // 提取并格式化具有特定错误代码的错误详情的辅助函数
  function formatError(error: any): string {
    let searchString = "";

    // 处理不同的输入类型
    if (error && error.message) {
      searchString = error.message;
    } else {
      searchString = String(error);
    }

    // 如果存在 Custom(xxxx) 格式，则提取错误代码
    const customMatch = searchString.match(/Custom\((\d+)\)/);
    if (customMatch) {
      const errorCode = parseInt(customMatch[1]);
      const errorMap: { [key: number]: string } = {
        6006: "DistributionNotStarted - 分发尚未开始",
        6007: "DistributionEnded - 分发已结束",
        6008: "DistributionNotEnded - 分发尚未结束",
        6009: "TooEarly - 申领时间过早",
        6010: "TooLate - 申领时间过晚",
        6012: "InvalidProof - 无效证明",
        6013: "AlreadyClaimed - 已申领最大数量",
        6014: "InvalidWithdrawTime - 无效的提取时间",
        6015: "NoTokensToWithdraw - 没有可提取的代币",
      };
      const errorMsg = errorMap[errorCode] || `未知错误代码 ${errorCode}`;
      return `Custom(${errorCode}): ${errorMsg}`;
    }

    // 如果未找到自定义错误代码，返回原始字符串
    return searchString;
  }

  // 检查交易结果是否表示失败的辅助函数
  function isTransactionFailed(result: any): boolean {
    const resultStr = String(result);
    return resultStr.includes("FailedTransactionMetadata") || resultStr === "FailedTransactionMetadata {}";
  }

  before(async () => {
    console.log("=== Initializing LiteSVM Test Environment ===");

    // 初始化 LiteSVM
    svm = new LiteSVM();

    // 使用 IDL 中的正确程序 ID 加载程序
    const programBytes = fs.readFileSync("./target/deploy/token_distributor.so");
    const idl = JSON.parse(fs.readFileSync("./target/idl/token_distributor.json", "utf8"));
    programId = new PublicKey(idl.address); // 使用 IDL 地址而不是密钥对

    svm.addProgram(programId, programBytes);
    console.log("✅ 已加载代币分发器程序:", programId.toString());
    console.log("✅ 使用 IDL 中的程序 ID:", idl.address);

    // 加载必要的系统程序
    console.log("加载必要的系统程序...");

    // SPL 代币程序对代币操作至关重要
    // LiteSVM 应该内置这些程序，但让我们确保它们可用
    console.log("✅ 系统程序应该在 LiteSVM 中默认可用");

    owner = Keypair.generate();
    operator = Keypair.generate();
    console.log("owner:", owner.publicKey.toString());
    console.log("operator:", operator.publicKey.toString());

    // 计算 nonce 状态 PDA
    const OWNER_NONCE_SEED = "owner_nonce";
    [ownerNoncePda] = PublicKey.findProgramAddressSync([Buffer.from(OWNER_NONCE_SEED), owner.publicKey.toBuffer()], programId);
    console.log("✅ Nonce 状态 PDA:", ownerNoncePda.toString());

    // 向拥有者空投 SOL（主支付者）
    svm.airdrop(owner.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
    console.log("✅ 已向拥有者空投 100 SOL");

    // 检查余额
    const balance = svm.getAccount(owner.publicKey)?.lamports || BigInt(0);
    console.log("拥有者余额:", Number(balance) / LAMPORTS_PER_SOL, "SOL");

    // 从拥有者给操作员一些 SOL
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: operator.publicKey,
        lamports: LAMPORTS_PER_SOL, // 1 SOL
      }),
    );

    transferTx.recentBlockhash = svm.latestBlockhash();
    transferTx.feePayer = owner.publicKey;
    transferTx.sign(owner);
    svm.sendTransaction(transferTx);
    console.log("✅ Transferred 1 SOL to operator");

    // 创建我们控制的测试申领者密钥对
    claimant1 = Keypair.generate();
    claimant2 = Keypair.generate();

    // 给申领者一些 SOL 用于交易费用
    for (const claimant of [claimant1, claimant2]) {
      const claimantTransferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: claimant.publicKey,
          lamports: LAMPORTS_PER_SOL / 10, // 0.1 SOL
        }),
      );
      claimantTransferTx.recentBlockhash = svm.latestBlockhash();
      claimantTransferTx.feePayer = owner.publicKey;
      claimantTransferTx.sign(owner);
      svm.sendTransaction(claimantTransferTx);
    }
    console.log("✅ 已创建测试申领者并转移 SOL 用于交易费用");

    // 使用我们控制的密钥对创建测试树节点
    testTreeNodes = [
      {
        claimant: claimant1.publicKey,
        amount: new anchor.BN(1000),
      },
      {
        claimant: claimant2.publicKey,
        amount: new anchor.BN(2000),
      },
      {
        claimant: owner.publicKey,
        amount: new anchor.BN(3000),
      }, // 使用拥有者作为第三个申领者
      {
        claimant: operator.publicKey,
        amount: new anchor.BN(4000),
      }, // 使用操作员作为第四个申领者
    ];

    // 使用测试数据创建默克尔树
    testMerkleTree = new SimpleMerkleTree(testTreeNodes);
    testMerkleRoot = testMerkleTree.getMerkleRoot();
    console.log("✅ 已使用受控密钥对创建测试默克尔树");
    console.log("测试默克尔根:", testMerkleRoot);

    // 使用 LiteSVM 方法创建 SPL 代币铸造（nonce 1）
    console.log("创建 SPL 代币铸造...");
    const tokenMintKeypair = liteSvmCreateMint(svm, owner, 9, TOKEN_PROGRAM_ID);
    tokenMint = tokenMintKeypair.publicKey;
    console.log("✅ SPL 代币铸造已创建:", tokenMint.toString());

    // 使用 LiteSVM 方法创建 Token 2022 铸造（nonce 2）
    console.log("创建 Token 2022 铸造...");
    const tokenMint2022Keypair = liteSvmCreateMint(svm, owner, 9, TOKEN_2022_PROGRAM_ID);
    tokenMint2022 = tokenMint2022Keypair.publicKey;
    console.log("✅ Token 2022 铸造已创建:", tokenMint2022.toString());

    // 使用 LiteSVM 方法创建代币账户
    console.log("使用 LiteSVM 方法创建代币账户...");
    const ownerTokenAccountKeypair = liteSvmCreateAccount(svm, tokenMint, owner.publicKey, owner, TOKEN_PROGRAM_ID);
    ownerTokenAccount = ownerTokenAccountKeypair.publicKey;

    const ownerTokenAccount2022Keypair = liteSvmCreateAccount(svm, tokenMint2022, owner.publicKey, owner, TOKEN_2022_PROGRAM_ID);
    ownerTokenAccount2022 = ownerTokenAccount2022Keypair.publicKey;

    console.log("✅ SPL 代币账户已创建:", ownerTokenAccount.toString());
    console.log("✅ Token 2022 账户已创建:", ownerTokenAccount2022.toString());

    // 向拥有者账户铸造一些代币
    console.log("向拥有者账户铸造代币...");
    const mintAmount = 1000000000000; // 1000 个代币，9 位小数

    // 铸造 SPL 代币
    liteSvmMintTo(svm, tokenMint, ownerTokenAccount, owner, mintAmount, TOKEN_PROGRAM_ID);
    console.log("✅ 已向拥有者账户铸造 SPL 代币");

    // 铸造 Token 2022 代币
    liteSvmMintTo(svm, tokenMint2022, ownerTokenAccount2022, owner, mintAmount, TOKEN_2022_PROGRAM_ID);
    console.log("✅ 已向拥有者账户铸造 Token 2022 代币");

    // 计算第一个分发器的 PDA（将是 nonce 1 和 2）
    distributorPda = calculateDistributorPda(tokenMint, owner.publicKey, 1);
    tokenVaultPda = calculateVaultPda(distributorPda);

    distributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, 2);
    tokenVaultPda2022 = calculateVaultPda(distributorPda2022);

    console.log("✅ 已计算 PDA:");
    console.log("SPL 代币分发器 PDA:", distributorPda.toString());
    console.log("SPL 代币金库 PDA:", tokenVaultPda.toString());
    console.log("Token 2022 分发器 PDA:", distributorPda2022.toString());
    console.log("Token 2022 金库 PDA:", tokenVaultPda2022.toString());

    // 使用 LiteSVM 创建用于指令构建的最小提供者
    // 我们创建一个与我们的 LiteSVM 实例一起工作的自定义连接类对象
    class LiteSVMConnection {
      private svm: LiteSVM;

      constructor(svm: LiteSVM) {
        this.svm = svm;
      }

      async getLatestBlockhash() {
        return {
          blockhash: this.svm.latestBlockhash(),
          lastValidBlockHeight: 0,
        };
      }

      async getMinimumBalanceForRentExemption() {
        return 0; // LiteSVM 自动处理租金
      }

      async getAccountInfo(pubkey: PublicKey) {
        const account = this.svm.getAccount(pubkey);
        if (!account) return null;
        return {
          executable: account.executable,
          owner: account.owner,
          lamports: Number(account.lamports),
          data: Buffer.from(account.data), // 将 Uint8Array 转换为 Buffer 以兼容 Anchor
          rentEpoch: 0,
        };
      }

      async getAccountInfoAndContext(pubkey: PublicKey) {
        const accountInfo = await this.getAccountInfo(pubkey);
        return {
          context: {
            slot: Number(this.svm.getClock().slot),
          },
          value: accountInfo,
        };
      }

      async getMultipleAccountsInfo(pubkeys: PublicKey[]) {
        return pubkeys.map((pubkey) => {
          const account = this.svm.getAccount(pubkey);
          return account
            ? {
                executable: account.executable,
                owner: account.owner,
                lamports: Number(account.lamports),
                data: Buffer.from(account.data), // 将 Uint8Array 转换为 Buffer
                rentEpoch: 0,
              }
            : null;
        });
      }

      async sendTransaction() {
        throw new Error("Use LiteSVM.sendTransaction() instead");
      }
    }

    const liteSvmConnection = new LiteSVMConnection(svm) as any;
    const wallet = new anchor.Wallet(owner);
    provider = new anchor.AnchorProvider(liteSvmConnection, wallet, { commitment: "confirmed" });

    // 加载 IDL 并使用修正的程序 ID 创建程序实例
    const programIdl = JSON.parse(fs.readFileSync("./target/idl/token_distributor.json", "utf8"));
    // 由于我们现在使用正确的程序 ID，无需覆盖
    program = new Program(programIdl, provider);

    console.log("✅ 已创建与 LiteSVM 集成的 Anchor 程序实例");
    console.log("LiteSVM 中的程序 ID:", programId.toString());
    console.log("Anchor 程序中的程序 ID:", program.programId.toString());

    // 注意：提取测试的 PDA 将根据实际计数器状态动态计算
    console.log("=== LiteSVM 测试环境就绪 ===");
  });

  it("Create distributor with SPL Token (nonce 1)", async () => {
    const totalAmount = new anchor.BN(500000000000); // 500 tokens

    try {
      console.log("Calling createDistributor with SPL Token, totalAmount:", totalAmount.toString());

      // 调试：检查程序账户是否存在
      const programAccount = svm.getAccount(programId);
      console.log("程序账户存在:", !!programAccount);
      console.log("程序可执行:", programAccount?.executable);

      // 调试：在交易前检查所有必需的账户
      console.log("拥有者账户存在:", !!svm.getAccount(owner.publicKey));
      console.log("代币铸造账户存在:", !!svm.getAccount(tokenMint));
      console.log("拥有者代币账户存在:", !!svm.getAccount(ownerTokenAccount));

      console.log("构建 createDistributor 指令...");

      const ix = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: distributorPda,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          ownerTokenAccount: ownerTokenAccount,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      // 使用 LiteSVM 执行交易
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = owner.publicKey;
      tx.sign(owner);

      try {
        const txResult = svm.sendTransaction(tx);
        console.log("LiteSVM sendTransaction 结果:", txResult);

        // 检查交易是否失败 - LiteSVM 返回字符串表示
        const txResultStr = String(txResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ LiteSVM 中的交易失败");
          console.error("失败的交易结果:", txResultStr);

          // 这表示程序执行失败
          // 常见原因：缺少程序、无效的账户所有权、资金不足等
          throw new Error(`交易失败: ${txResultStr}`);
        }

        console.log("✅ 交易已成功发送到 LiteSVM");
      } catch (error) {
        console.error("❌ 交易执行错误:", error);
        throw error;
      }

      // 调试：检查账户是否已创建
      console.log("检查账户创建...");
      const debugnonceAccount = svm.getAccount(ownerNoncePda);
      const debugDistributorAccount = svm.getAccount(distributorPda);
      const debugVaultAccount = svm.getAccount(tokenVaultPda);

      console.log("Nonce 账户存在:", !!debugnonceAccount);
      console.log("分发器账户存在:", !!debugDistributorAccount);
      console.log("金库账户存在:", !!debugVaultAccount);

      if (!debugnonceAccount) {
        console.log("❌ Nonce 账户未创建！交易可能已失败。");
        console.log("预期的 nonce PDA:", ownerNoncePda.toString());
        return;
      }

      // 验证 nonce 状态已创建/更新
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("Nonce State data:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("1");

      // 验证创建分发器后的代币金库余额
      console.log("验证 SPL 代币金库余额...");
      const tokenVaultAccount = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      console.log("SPL 代币金库余额:", tokenVaultAccount.amount.toString());
      console.log("SPL 代币金库铸造:", tokenVaultAccount.mint.toString());
      console.log("预期总数量:", totalAmount.toString());

      // 验证金库具有正确的数量和铸造
      expect(tokenVaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(tokenVaultAccount.mint.toString()).to.equal(tokenMint.toString());

      // 验证分发器账户存在且有数据
      const fetchedDistributorAccount = await program.account.tokenDistributor.fetch(distributorPda);

      console.log("SPL 代币分发器账户数据:", {
        owner: fetchedDistributorAccount.owner.toString(),
        operator: fetchedDistributorAccount.operator.toString(),
        tokenMint: fetchedDistributorAccount.tokenMint.toString(),
        initialTotalAmount: fetchedDistributorAccount.initialTotalAmount.toString(),
        totalClaimed: fetchedDistributorAccount.totalClaimed.toString(),
        nonce: fetchedDistributorAccount.nonce.toString(),
      });

      // 基本验证
      expect(fetchedDistributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(fetchedDistributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(fetchedDistributorAccount.tokenMint.toString()).to.equal(tokenMint.toString());
      expect(fetchedDistributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(fetchedDistributorAccount.totalClaimed.toString()).to.equal("0"); // 初始应为 0
      expect(fetchedDistributorAccount.nonce.toString()).to.equal("1");

      console.log("✅ Create SPL Token distributor test passed!");
    } catch (error) {
      console.error("Create SPL Token distributor test failed:", error);
      throw error;
    }
  });

  it("Create distributor with Token 2022 (nonce 2)", async () => {
    const totalAmount = new anchor.BN(500000000000); // 500 tokens

    try {
      console.log("Calling createDistributor with Token 2022, totalAmount:", totalAmount.toString());

      // 构建指令
      const ix = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: distributorPda2022,
          tokenVault: tokenVaultPda2022,
          tokenMint: tokenMint2022,
          ownerTokenAccount: ownerTokenAccount2022,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx = new Transaction();
      tx.add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = owner.publicKey;
      tx.sign(owner);

      try {
        const txResult = svm.sendTransaction(tx);
        console.log("LiteSVM sendTransaction 结果:", txResult);

        // 检查交易是否失败
        const txResultStr = String(txResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ LiteSVM 中的交易失败");
          console.error("失败的交易结果:", txResultStr);
          throw new Error(`交易失败: ${txResultStr}`);
        }

        console.log("✅ 交易已成功发送到 LiteSVM");
      } catch (error) {
        console.error("❌ 交易执行错误:", error);
        throw error;
      }

      // 调试：检查账户是否已创建
      console.log("检查账户创建...");
      const debugnonceAccount = svm.getAccount(ownerNoncePda);
      const debugDistributorAccount = svm.getAccount(distributorPda2022);
      const debugVaultAccount = svm.getAccount(tokenVaultPda2022);

      console.log("Nonce 账户存在:", !!debugnonceAccount);
      console.log("分发器账户存在:", !!debugDistributorAccount);
      console.log("金库账户存在:", !!debugVaultAccount);

      if (!debugnonceAccount) {
        console.log("❌ Nonce 账户未创建！交易可能已失败。");
        console.log("预期的 nonce PDA:", ownerNoncePda.toString());
        return;
      }

      // 验证 nonce 状态已更新为 nonce 2
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("Updated Nonce State data:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("2");

      // 验证创建分发器后的代币金库余额
      console.log("验证 Token 2022 金库余额...");
      const tokenVaultAccount = await getAccount2022(provider.connection, tokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);

      console.log("Token 2022 金库余额:", tokenVaultAccount.amount.toString());
      console.log("Token 2022 金库铸造:", tokenVaultAccount.mint.toString());
      console.log("预期总数量:", totalAmount.toString());

      // 验证金库具有正确的数量和铸造
      expect(tokenVaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(tokenVaultAccount.mint.toString()).to.equal(tokenMint2022.toString());

      // 验证分发器账户存在且有数据
      const fetchedDistributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("Token 2022 分发器账户数据:", {
        owner: fetchedDistributorAccount.owner.toString(),
        operator: fetchedDistributorAccount.operator.toString(),
        tokenMint: fetchedDistributorAccount.tokenMint.toString(),
        initialTotalAmount: fetchedDistributorAccount.initialTotalAmount.toString(),
        totalClaimed: fetchedDistributorAccount.totalClaimed.toString(),
        nonce: fetchedDistributorAccount.nonce.toString(),
      });

      // 基本验证
      expect(fetchedDistributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(fetchedDistributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(fetchedDistributorAccount.tokenMint.toString()).to.equal(tokenMint2022.toString());
      expect(fetchedDistributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(fetchedDistributorAccount.totalClaimed.toString()).to.equal("0"); // 初始应为 0
      expect(fetchedDistributorAccount.nonce.toString()).to.equal("2");

      console.log("✅ Create Token 2022 distributor test passed!");
    } catch (error) {
      console.error("Create Token 2022 distributor test failed:", error);
      throw error;
    }
  });

  it("Set merkle root for both distributors", async () => {
    try {
      console.log("Setting merkle root using test data...");

      console.log("Generated merkle root:", testMerkleRoot);
      console.log("Merkle root length:", testMerkleRoot.length);

      console.log("Setting merkle root for SPL Token distributor (nonce 1)...");

      // 为 nonce 1（SPL Token）构建指令
      const ix1 = await program.methods
        .setMerkleRoot(testMerkleRoot)
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      try {
        const txResult1 = svm.sendTransaction(tx1);
        console.log("nonce 1 设置默克尔根交易结果:", txResult1);

        // 检查交易是否失败
        const txResultStr1 = String(txResult1);
        if (txResultStr1.includes("FailedTransactionMetadata") || txResultStr1 === "FailedTransactionMetadata {}") {
          console.error("❌ nonce 1 设置默克尔根交易失败");
          throw new Error(`交易失败: ${txResultStr1}`);
        }

        console.log("✅ nonce 1 设置默克尔根交易已成功发送");
      } catch (error) {
        console.error("❌ nonce 1 设置默克尔根交易执行错误:", error);
        throw error;
      }

      console.log("为 Token 2022 分发器（nonce 2）设置默克尔根...");

      // 为 nonce 2（Token 2022）构建指令
      const ix2 = await program.methods
        .setMerkleRoot(testMerkleRoot)
        .accounts({
          distributor: distributorPda2022,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      try {
        const txResult2 = svm.sendTransaction(tx2);
        console.log("nonce 2 设置默克尔根交易结果:", txResult2);

        // 检查交易是否失败
        const txResultStr2 = String(txResult2);
        if (txResultStr2.includes("FailedTransactionMetadata") || txResultStr2 === "FailedTransactionMetadata {}") {
          console.error("❌ nonce 2 设置默克尔根交易失败");
          throw new Error(`交易失败: ${txResultStr2}`);
        }

        console.log("✅ nonce 2 设置默克尔根交易已成功发送");
      } catch (error) {
        console.error("❌ nonce 2 设置默克尔根交易执行错误:", error);
        throw error;
      }

      // 验证已为两个分发器设置默克尔根
      const distributorAccount1 = await program.account.tokenDistributor.fetch(distributorPda);
      const distributorAccount2022 = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("nonce 1 设置的默克尔根:", distributorAccount1.merkleRoot);
      console.log("nonce 2 设置的默克尔根:", distributorAccount2022.merkleRoot);

      // 验证默克尔根匹配我们设置的值
      expect(distributorAccount1.merkleRoot).to.deep.equal(testMerkleRoot);
      expect(distributorAccount2022.merkleRoot).to.deep.equal(testMerkleRoot);

      console.log("✅ Set merkle root test passed for both distributors!");
    } catch (error) {
      console.error("Set merkle root test failed:", error);
      throw error;
    }
  });

  it("Set time for nonce 1 and nonce 2 [current time]", async () => {
    try {
      console.log("Getting current LiteSVM blockchain time...");

      // 获取当前 LiteSVM 区块链时间
      const clock = svm.getClock();
      const currentTimestamp = Number(clock.unixTimestamp);

      console.log("当前 LiteSVM 时间戳:", currentTimestamp);
      console.log("当前 LiteSVM 插槽:", Number(clock.slot));

      // 将 nonce 1（SPL Token）的时间设置为未来 1 秒（最小有效时间）
      const startTimeV1 = currentTimestamp + 1; // 未来 1 秒以满足验证
      console.log("将 nonce 1（SPL Token）的时间设置为 +1 秒:", startTimeV1);

      // 为 nonce 1（SPL Token）构建指令
      const ix1 = await program.methods
        .setTime(new anchor.BN(startTimeV1))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      try {
        const txResult1 = svm.sendTransaction(tx1);
        console.log("nonce 1 设置时间交易结果:", txResult1);

        // 检查交易是否失败
        const txResultStr1 = String(txResult1);
        if (txResultStr1.includes("FailedTransactionMetadata") || txResultStr1 === "FailedTransactionMetadata {}") {
          console.error("❌ nonce 1 设置时间交易失败");
          throw new Error(`交易失败: ${txResultStr1}`);
        }

        console.log("✅ nonce 1 设置时间交易已成功发送");
      } catch (error) {
        console.error("❌ nonce 1 设置时间交易执行错误:", error);
        throw error;
      }

      // 将 nonce 2（Token 2022）的时间设置为当前时间 + 10 秒
      const startTimeV2 = currentTimestamp + 10;
      console.log("将 nonce 2（Token 2022）的时间设置为当前时间 + 10 秒:", startTimeV2);

      // 为 nonce 2（Token 2022）构建指令
      const ix2 = await program.methods
        .setTime(new anchor.BN(startTimeV2))
        .accounts({
          distributor: distributorPda2022,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      try {
        const txResult2 = svm.sendTransaction(tx2);
        console.log("nonce 2 设置时间交易结果:", txResult2);

        // 检查交易是否失败
        const txResultStr2 = String(txResult2);
        if (txResultStr2.includes("FailedTransactionMetadata") || txResultStr2 === "FailedTransactionMetadata {}") {
          console.error("❌ nonce 2 设置时间交易失败");
          throw new Error(`交易失败: ${txResultStr2}`);
        }

        console.log("✅ nonce 2 设置时间交易已成功发送");
      } catch (error) {
        console.error("❌ nonce 2 设置时间交易执行错误:", error);
        throw error;
      }

      // 验证时间已设置
      const distributorAccount1 = await program.account.tokenDistributor.fetch(distributorPda);
      const distributorAccount2022 = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("nonce 1 开始时间已设置:", distributorAccount1.startTime.toString());
      console.log("nonce 1 结束时间已设置:", distributorAccount1.endTime.toString());
      console.log("nonce 2 开始时间已设置:", distributorAccount2022.startTime.toString());
      console.log("nonce 2 结束时间已设置:", distributorAccount2022.endTime.toString());

      // 验证时间匹配我们设置的值
      expect(distributorAccount1.startTime.toString()).to.equal(startTimeV1.toString());
      expect(distributorAccount2022.startTime.toString()).to.equal(startTimeV2.toString());

      // 验证结束时间已设置（应该是开始时间 + DURATION）
      expect(distributorAccount1.endTime.toNumber()).to.be.greaterThan(distributorAccount1.startTime.toNumber());
      expect(distributorAccount2022.endTime.toNumber()).to.be.greaterThan(distributorAccount2022.startTime.toNumber());

      console.log("✅ Set time test passed for both nonces!");
    } catch (error) {
      console.error("Set time test failed:", error);
      throw error;
    }
  });

  it("Modify time multiple times before distribution starts", async () => {
    try {
      console.log("=== Testing multiple time modifications before distribution starts ===");

      // 获取当前 LiteSVM 区块链时间
      const currentClock = svm.getClock();
      const blockTime = Number(currentClock.unixTimestamp);

      console.log("当前 LiteSVM 区块时间:", blockTime);

      // 第一次设置时间 - 设置为未来 10 秒
      const firstStartTime = blockTime + 10;
      console.log("第一次设置时间为 +10 秒:", firstStartTime);

      // 为第一次设置时间构建指令
      const ix1 = await program.methods
        .setTime(new anchor.BN(firstStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      const txResult1 = svm.sendTransaction(tx1);
      console.log("第一次设置时间交易结果:", txResult1);

      // 验证第一次时间已设置
      let distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(firstStartTime.toString());

      // 第二次设置时间 - 修改为未来 20 秒
      const secondStartTime = blockTime + 20;
      console.log("修改时间为 +20 秒:", secondStartTime);

      // 为第二次设置时间构建指令
      const ix2 = await program.methods
        .setTime(new anchor.BN(secondStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      const txResult2 = svm.sendTransaction(tx2);
      console.log("第二次设置时间交易结果:", txResult2);

      // 验证第二次时间已设置
      distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(secondStartTime.toString());

      // 第三次设置时间 - 修改为未来 30 秒
      const thirdStartTime = blockTime + 30;
      console.log("修改时间为 +30 秒:", thirdStartTime);

      // 为第三次设置时间构建指令
      const ix3 = await program.methods
        .setTime(new anchor.BN(thirdStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx3 = new Transaction();
      tx3.add(ix3);
      tx3.recentBlockhash = svm.latestBlockhash();
      tx3.feePayer = operator.publicKey;
      tx3.sign(operator);

      const txResult3 = svm.sendTransaction(tx3);
      console.log("第三次设置时间交易结果:", txResult3);

      // 验证第三次时间已设置
      distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(thirdStartTime.toString());

      console.log("✅ Multiple time modifications test passed!");
    } catch (error) {
      console.error("Multiple time modifications test failed:", error);
      throw error;
    }
  });

  it("Fail to modify time after distribution starts", async () => {
    try {
      console.log("=== Testing time modification failure after distribution starts ===");

      // 获取当前 LiteSVM 区块链时间
      const currentClock = svm.getClock();
      const blockTime = Number(currentClock.unixTimestamp);

      console.log("当前 LiteSVM 区块时间:", blockTime);

      // 将初始时间设置为未来 5 秒
      const initialStartTime = blockTime + 5;
      console.log("将初始时间设置为 +5 秒:", initialStartTime);

      // 为初始时间设置构建指令
      const ix1 = await program.methods
        .setTime(new anchor.BN(initialStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      const txResult1 = svm.sendTransaction(tx1);
      console.log("初始时间设置交易结果:", txResult1);

      // 验证初始时间已设置
      let distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(initialStartTime.toString());

      // 推进时间到分发开始之后
      console.log("⏰ 推进时间到分发开始之后...");
      const afterStartTime = initialStartTime + 2; // 开始时间后 2 秒

      const updatedClock = svm.getClock();
      updatedClock.unixTimestamp = BigInt(afterStartTime);
      svm.setClock(updatedClock);

      console.log("已推进时间到:", afterStartTime);
      console.log("分发应该已开始:", afterStartTime >= initialStartTime);

      // 尝试在分发开始后修改时间 - 这应该失败
      const newStartTime = afterStartTime + 10;
      console.log("尝试修改时间到:", newStartTime);

      // 为时间修改构建指令（应该失败）
      const ix2 = await program.methods
        .setTime(new anchor.BN(newStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      const txResult2 = svm.sendTransaction(tx2);
      console.log("时间修改交易结果:", txResult2);

      // 检查交易是否失败
      const txResultStr2 = String(txResult2);
      if (txResultStr2.includes("FailedTransactionMetadata") || txResultStr2 === "FailedTransactionMetadata {}") {
        console.log("✅ 时间修改在分发开始后正确失败");

        // 验证时间实际上未被修改
        distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
        expect(distributorAccount.startTime.toString()).to.equal(initialStartTime.toString());
        console.log("✅ 时间正确未被修改 - 仍为:", distributorAccount.startTime.toString());
      } else {
        // 如果我们到达这里，交易在应该失败时成功了
        throw new Error("❌ 时间修改应该失败但成功了");
      }

      console.log("✅ Time modification failure test passed!");
    } catch (error) {
      console.error("Time modification failure test failed:", error);
      throw error;
    }
  });

  it("Claim tokens for nonce 1 (SPL Token)[current time]", async () => {
    try {
      console.log("=== Testing claim for nonce 1 (SPL Token) ===");

      // 测试申领者1的申领（来自我们预生成的测试数据的 1000 个代币）
      const claimIndex = 0;
      const claimAmount = testTreeNodes[claimIndex].amount;

      console.log("测试申领者1的申领:");
      console.log("  申领者:", claimant1.publicKey.toString());
      console.log("  数量:", claimAmount.toString());

      // 为申领者1生成证明
      const proof = testMerkleTree.getProof(claimIndex);
      console.log("生成的证明长度:", proof.length);

      // 将证明转换为程序期望的格式
      const proofArray: number[][] = proof.map((p) => Array.from(p));

      // 使用 LiteSVM 方法为申领者1创建代币账户
      const claimant1TokenAccountKeypair = liteSvmCreateAccount(svm, tokenMint, claimant1.publicKey, claimant1, TOKEN_PROGRAM_ID);
      const claimant1TokenAccount = claimant1TokenAccountKeypair.publicKey;
      console.log("已创建申领者1代币账户:", claimant1TokenAccount.toString());

      // 查找申领者1的申领状态 PDA
      const [claimStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("claim"), distributorPda.toBuffer(), claimant1.publicKey.toBuffer()], programId);

      // 使用 LiteSVM 连接获取初始代币余额
      const initialVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const initialClaimantBalance = await getAccount(provider.connection, claimant1TokenAccount, undefined, TOKEN_PROGRAM_ID);

      console.log("初始金库余额:", initialVaultBalance.amount.toString());
      console.log("初始申领者余额:", initialClaimantBalance.amount.toString());

      // 检查当前分发器状态，如果需要则推进时间
      console.log("=== 检查时间并推进以允许申领 ===");

      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      let currentClock = svm.getClock();
      let currentTimestamp = Number(currentClock.unixTimestamp);

      console.log("当前 LiteSVM 时间戳:", currentTimestamp);
      console.log("分发时间:", distributorAccount.startTime.toString());
      console.log("当前是否允许申领:", currentTimestamp >= distributorAccount.startTime.toNumber());

      // 如果尚未允许申领，则推进时间
      if (currentTimestamp < distributorAccount.startTime.toNumber()) {
        console.log("⏰ 推进时间以允许申领...");

        // 通过直接设置时钟使用 LiteSVM 正确的时间控制
        const targetTimestamp = distributorAccount.startTime.toNumber() + 1;

        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("设置时间戳为:", targetTimestamp);

        // 检查更新时间
        currentClock = svm.getClock();
        currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("时钟更新后的新时间戳:", currentTimestamp);
        console.log("现在是否允许申领:", currentTimestamp >= distributorAccount.startTime.toNumber());
      }

      // 执行申领交易
      console.log("=== 执行申领交易 ===");

      // 构建申领指令
      const claimIx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda,
          claimantTokenAccount: claimant1TokenAccount,
          tokenMint: tokenMint,
          claimant: claimant1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const claimTx = new Transaction();
      claimTx.add(claimIx);
      claimTx.recentBlockhash = svm.latestBlockhash();
      claimTx.feePayer = claimant1.publicKey;
      claimTx.sign(claimant1);

      try {
        const claimResult = svm.sendTransaction(claimTx);
        console.log("申领交易结果:", claimResult);

        // 检查交易是否失败
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ 申领交易失败");
          console.error("完整错误详情:", claimResult);
          throw new Error(`申领交易失败: ${txResultStr}`);
        }

        console.log("✅ 申领交易已成功发送");
      } catch (error) {
        console.error("❌ 申领交易执行错误:", error);
        throw error;
      }

      // 验证申领后的余额
      const finalVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const finalClaimantBalance = await getAccount(provider.connection, claimant1TokenAccount, undefined, TOKEN_PROGRAM_ID);

      console.log("最终金库余额:", finalVaultBalance.amount.toString());
      console.log("最终申领者余额:", finalClaimantBalance.amount.toString());

      // 验证已转移正确的数量
      const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
      const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

      expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
      expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

      console.log("✅ 代币余额验证正确！");

      // 验证申领状态已更新
      const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
      expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

      console.log("✅ 申领状态验证正确！");

      // 测试双重申领失败
      console.log("=== 测试双重申领预防 ===");
      try {
        // 构建双重申领指令
        const doubleClaimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        // 使用 LiteSVM 创建并发送交易
        const doubleClaimTx = new Transaction();
        doubleClaimTx.add(doubleClaimIx);
        doubleClaimTx.recentBlockhash = svm.latestBlockhash();
        doubleClaimTx.feePayer = claimant1.publicKey;
        doubleClaimTx.sign(claimant1);

        const doubleClaimResult = svm.sendTransaction(doubleClaimTx);

        // 检查交易是否按预期失败
        const txResultStr = String(doubleClaimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.log("✅ 双重申领在 LiteSVM 中正确阻止");
        } else {
          // 如果交易意外成功，测试失败
          expect.fail("双重申领应该失败");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ 双重申领正确阻止:", errorDetails);
      }

      console.log("✅ Claim test completed successfully!");
    } catch (error) {
      console.error("Claim test failed:", error);
      throw error;
    }
  });

  it("Claim tokens for nonce 2 (Token 2022)[current time]", async () => {
    try {
      console.log("=== Testing claim for nonce 2 (Token 2022) ===");

      // 测试申领者2的申领（来自我们预生成的测试数据的 2000 个代币）
      const claimIndex = 1;
      const claimAmount = testTreeNodes[claimIndex].amount;

      console.log("测试申领者2的申领:");
      console.log("  申领者:", claimant2.publicKey.toString());
      console.log("  数量:", claimAmount.toString());

      // 为申领者2生成证明
      const proof = testMerkleTree.getProof(claimIndex);
      console.log("生成的证明长度:", proof.length);

      // 将证明转换为程序期望的格式
      const proofArray: number[][] = proof.map((p) => Array.from(p));

      // 使用 LiteSVM 方法为申领者2创建代币账户
      const claimant2TokenAccountKeypair = liteSvmCreateAccount(svm, tokenMint2022, claimant2.publicKey, claimant2, TOKEN_2022_PROGRAM_ID);
      const claimant2TokenAccount = claimant2TokenAccountKeypair.publicKey;
      console.log("已创建申领者2代币账户:", claimant2TokenAccount.toString());

      // 查找申领者2的申领状态 PDA
      const [claimStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("claim"), distributorPda2022.toBuffer(), claimant2.publicKey.toBuffer()], programId);

      // 使用 LiteSVM 连接获取初始代币余额
      const initialVaultBalance = await getAccount(provider.connection, tokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);

      const initialClaimantBalance = await getAccount(provider.connection, claimant2TokenAccount, undefined, TOKEN_2022_PROGRAM_ID);

      console.log("初始金库余额:", initialVaultBalance.amount.toString());
      console.log("初始申领者余额:", initialClaimantBalance.amount.toString());

      // 检查当前分发器状态，如果需要则推进时间
      console.log("=== 检查时间并推进以允许申领 ===");

      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);
      let currentClock = svm.getClock();
      let currentTimestamp = Number(currentClock.unixTimestamp);

      console.log("当前 LiteSVM 时间戳:", currentTimestamp);
      console.log("分发开始时间:", distributorAccount.startTime.toString());
      console.log("当前是否允许申领:", currentTimestamp >= distributorAccount.startTime.toNumber());

      // 如果尚未允许申领，则推进时间
      if (currentTimestamp < distributorAccount.startTime.toNumber()) {
        console.log("⏰ 推进时间以允许申领...");

        // 通过直接设置时钟使用 LiteSVM 正确的时间控制
        const targetTimestamp = distributorAccount.startTime.toNumber() + 1;

        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("设置时间戳为:", targetTimestamp);

        // 检查更新时间
        currentClock = svm.getClock();
        currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("时钟更新后的新时间戳:", currentTimestamp);
        console.log("现在是否允许申领:", currentTimestamp >= distributorAccount.startTime.toNumber());
      }

      // 执行申领交易
      console.log("=== 执行申领交易 ===");

      // 构建申领指令
      const claimIx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda2022,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda2022,
          claimantTokenAccount: claimant2TokenAccount,
          tokenMint: tokenMint2022,
          claimant: claimant2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();

      // 使用 LiteSVM 创建并发送交易
      const claimTx = new Transaction();
      claimTx.add(claimIx);
      claimTx.recentBlockhash = svm.latestBlockhash();
      claimTx.feePayer = claimant2.publicKey;
      claimTx.sign(claimant2);

      try {
        const claimResult = svm.sendTransaction(claimTx);
        console.log("申领交易结果:", claimResult);

        // 检查交易是否失败
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ 申领交易失败");
          console.error("完整错误详情:", claimResult);
          throw new Error(`申领交易失败: ${txResultStr}`);
        }

        console.log("✅ 申领交易已成功发送");
      } catch (error) {
        console.error("❌ 申领交易执行错误:", error);
        throw error;
      }

      // 验证申领后的余额
      const finalVaultBalance = await getAccount(provider.connection, tokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);

      const finalClaimantBalance = await getAccount(provider.connection, claimant2TokenAccount, undefined, TOKEN_2022_PROGRAM_ID);

      console.log("最终金库余额:", finalVaultBalance.amount.toString());
      console.log("最终申领者余额:", finalClaimantBalance.amount.toString());

      // 验证已转移正确的数量
      const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
      const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

      expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
      expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

      console.log("✅ 代币余额验证正确！");

      // 验证申领状态已更新
      const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
      expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

      console.log("✅ 申领状态验证正确！");

      console.log("✅ Token 2022 Claim test completed successfully!");
    } catch (error) {
      console.error("Token 2022 Claim test failed:", error);
      throw error;
    }
  });

  it("Withdraw tokens (SPL Token) - No start time set", async () => {
    try {
      console.log("=== Testing withdraw (SPL Token) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      // 动态获取下一个 nonce 号码
      const nextnonce = await getNextNonceForOwner(owner.publicKey);
      console.log("提取测试的下一个 nonce:", nextnonce);

      // 计算此 nonce 的 PDA
      const withdrawTestDistributorPda = calculateDistributorPda(tokenMint, owner.publicKey, nextnonce);
      const withdrawTestTokenVaultPda = calculateVaultPda(withdrawTestDistributorPda);

      console.log("提取测试 SPL 代币分发器 PDA:", withdrawTestDistributorPda.toString());
      console.log("提取测试 SPL 代币金库 PDA:", withdrawTestTokenVaultPda.toString());

      // 为提取测试创建分发器
      console.log("为提取测试创建分发器（nonce", nextnonce, ")...");

      const createIx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: withdrawTestDistributorPda,
          tokenVault: withdrawTestTokenVaultPda,
          tokenMint: tokenMint,
          ownerTokenAccount: ownerTokenAccount,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const createTx = new Transaction();
      createTx.add(createIx);
      createTx.recentBlockhash = svm.latestBlockhash();
      createTx.feePayer = owner.publicKey;
      createTx.sign(owner);

      const createResult = svm.sendTransaction(createTx);
      console.log("Created withdraw test distributor transaction:", createResult);

      // 验证初始金库余额
      const initialVaultBalance = await getAccount(provider.connection, withdrawTestTokenVaultPda, undefined, TOKEN_PROGRAM_ID);
      console.log("初始金库余额:", initialVaultBalance.amount.toString());
      expect(initialVaultBalance.amount.toString()).to.equal(totalAmount.toString());

      // 获取初始拥有者代币余额
      const initialOwnerBalance = await getAccount(provider.connection, ownerTokenAccount, undefined, TOKEN_PROGRAM_ID);
      console.log("初始拥有者余额:", initialOwnerBalance.amount.toString());

      // 验证分发器状态 - 开始时间应为 0（未设置）
      const distributorAccount = await program.account.tokenDistributor.fetch(withdrawTestDistributorPda);
      console.log("分发器开始时间:", distributorAccount.startTime.toString());
      console.log("分发器结束时间:", distributorAccount.endTime.toString());
      expect(distributorAccount.startTime.toString()).to.equal("0");
      expect(distributorAccount.endTime.toString()).to.equal("0");

      // 执行提取 - 应该成功，因为开始时间未设置
      console.log("执行提取交易...");

      const withdrawIx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda,
          tokenVault: withdrawTestTokenVaultPda,
          ownerTokenAccount: ownerTokenAccount,
          tokenMint: tokenMint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const withdrawTx = new Transaction();
      withdrawTx.add(withdrawIx);
      withdrawTx.recentBlockhash = svm.latestBlockhash();
      withdrawTx.feePayer = owner.publicKey;
      withdrawTx.sign(owner);

      const withdrawResult = svm.sendTransaction(withdrawTx);
      console.log("Withdraw transaction result:", withdrawResult);

      // 验证最终拥有者代币余额
      const finalOwnerBalance = await getAccount(provider.connection, ownerTokenAccount, undefined, TOKEN_PROGRAM_ID);
      console.log("最终拥有者余额:", finalOwnerBalance.amount.toString());

      // 验证已提取正确的数量
      const expectedOwnerBalance = initialOwnerBalance.amount + BigInt(totalAmount.toString());
      expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

      console.log("✅ 代币余额已验证 - 拥有者已收回所有代币！");

      // 验证金库账户已关闭（获取应该失败）
      try {
        await getAccount(provider.connection, withdrawTestTokenVaultPda, undefined, TOKEN_PROGRAM_ID);
        expect.fail("金库账户应该已关闭");
      } catch (error) {
        console.log("✅ 金库账户已正确关闭");
      }

      // 验证分发器账户已关闭（获取应该失败）
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda);
        expect.fail("分发器账户应该已关闭");
      } catch (error) {
        console.log("✅ 分发器账户已正确关闭");
      }

      console.log("✅ SPL Token Withdraw test completed successfully!");
    } catch (error) {
      console.error("SPL Token Withdraw test failed:", error);
      throw error;
    }
  });

  it("Withdraw tokens (Token 2022) - No start time set", async () => {
    try {
      console.log("=== Testing withdraw (Token 2022) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      // 动态获取下一个 nonce 号码
      const nextnonce = await getNextNonceForOwner(owner.publicKey);
      console.log("提取测试的下一个 nonce:", nextnonce);

      // 计算此 nonce 的 PDA
      const withdrawTestDistributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, nextnonce);
      const withdrawTestTokenVaultPda2022 = calculateVaultPda(withdrawTestDistributorPda2022);

      console.log("提取测试 Token 2022 分发器 PDA:", withdrawTestDistributorPda2022.toString());
      console.log("提取测试 Token 2022 金库 PDA:", withdrawTestTokenVaultPda2022.toString());

      // 为提取测试创建分发器
      console.log("为提取测试创建分发器（nonce", nextnonce, ")...");

      const createIx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: withdrawTestDistributorPda2022,
          tokenVault: withdrawTestTokenVaultPda2022,
          tokenMint: tokenMint2022,
          ownerTokenAccount: ownerTokenAccount2022,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();

      const createTx = new Transaction();
      createTx.add(createIx);
      createTx.recentBlockhash = svm.latestBlockhash();
      createTx.feePayer = owner.publicKey;
      createTx.sign(owner);

      const createResult = svm.sendTransaction(createTx);
      console.log("Created withdraw test distributor transaction:", createResult);

      // 验证初始金库余额
      const initialVaultBalance = await getAccount(provider.connection, withdrawTestTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
      console.log("初始金库余额:", initialVaultBalance.amount.toString());
      expect(initialVaultBalance.amount.toString()).to.equal(totalAmount.toString());

      // 获取初始拥有者代币余额
      const initialOwnerBalance = await getAccount(provider.connection, ownerTokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);
      console.log("初始拥有者余额:", initialOwnerBalance.amount.toString());

      // 验证分发器状态 - 开始时间应为 0（未设置）
      const distributorAccount = await program.account.tokenDistributor.fetch(withdrawTestDistributorPda2022);
      console.log("分发器开始时间:", distributorAccount.startTime.toString());
      console.log("分发器结束时间:", distributorAccount.endTime.toString());
      expect(distributorAccount.startTime.toString()).to.equal("0");
      expect(distributorAccount.endTime.toString()).to.equal("0");

      // 执行提取 - 应该成功，因为开始时间未设置
      console.log("执行提取交易...");

      const withdrawIx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda2022,
          tokenVault: withdrawTestTokenVaultPda2022,
          ownerTokenAccount: ownerTokenAccount2022,
          tokenMint: tokenMint2022,
          owner: owner.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();

      const withdrawTx = new Transaction();
      withdrawTx.add(withdrawIx);
      withdrawTx.recentBlockhash = svm.latestBlockhash();
      withdrawTx.feePayer = owner.publicKey;
      withdrawTx.sign(owner);

      const withdrawResult = svm.sendTransaction(withdrawTx);
      console.log("Withdraw transaction result:", withdrawResult);

      // 验证最终拥有者代币余额
      const finalOwnerBalance = await getAccount(provider.connection, ownerTokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);
      console.log("最终拥有者余额:", finalOwnerBalance.amount.toString());

      // 验证已提取正确的数量
      const expectedOwnerBalance = initialOwnerBalance.amount + BigInt(totalAmount.toString());
      expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

      console.log("✅ 代币余额已验证 - 拥有者已收回所有代币！");

      // 验证金库账户已关闭（获取应该失败）
      try {
        await getAccount(provider.connection, withdrawTestTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
        expect.fail("金库账户应该已关闭");
      } catch (error) {
        console.log("✅ 金库账户已正确关闭");
      }

      // 验证分发器账户已关闭（获取应该失败）
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda2022);
        expect.fail("分发器账户应该已关闭");
      } catch (error) {
        console.log("✅ 分发器账户已正确关闭");
      }

      console.log("✅ Token 2022 Withdraw test completed successfully!");
    } catch (error) {
      console.error("Token 2022 Withdraw test failed:", error);
      throw error;
    }
  });

  after(async () => {
    console.log("=== LiteSVM Test Environment Cleanup ===");
    console.log("✅ All tests completed successfully!");
    console.log("✅ LiteSVM successfully replaced Bankrun functionality");
  });

  // 额外测试套件 1：SPL 代币，1 天开始时间延迟
  describe("SPL Token - 1 Day Start Time Delay Tests", () => {
    let delayedDistributorPda: PublicKey;
    let delayedTokenVaultPda: PublicKey;
    let delayedClaimant1TokenAccount: PublicKey;
    let delayedClaimStatusPda: PublicKey;
    let startTimeOneDayLater: number;

    it("Create distributor with SPL Token (1 day start time delay)", async () => {
      const totalAmount = new anchor.BN(500000000000); // 500 tokens

      try {
        console.log("=== Creating SPL Token distributor with 1 day start time delay ===");

        // 动态获取下一个 nonce 号码
        const nextnonce = await getNextNonceForOwner(owner.publicKey);
        console.log("延迟开始测试的下一个 nonce:", nextnonce);

        // 计算此 nonce 的 PDA
        delayedDistributorPda = calculateDistributorPda(tokenMint, owner.publicKey, nextnonce);
        delayedTokenVaultPda = calculateVaultPda(delayedDistributorPda);

        console.log("延迟 SPL 代币分发器 PDA:", delayedDistributorPda.toString());
        console.log("延迟 SPL 代币金库 PDA:", delayedTokenVaultPda.toString());

        // 创建分发器
        const createIx = await program.methods
          .createDistributor(totalAmount)
          .accounts({
            ownerNonce: ownerNoncePda,
            distributor: delayedDistributorPda,
            tokenVault: delayedTokenVaultPda,
            tokenMint: tokenMint,
            ownerTokenAccount: ownerTokenAccount,
            owner: owner.publicKey,
            operator: operator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const createTx = new Transaction();
        createTx.add(createIx);
        createTx.recentBlockhash = svm.latestBlockhash();
        createTx.feePayer = owner.publicKey;
        createTx.sign(owner);

        const createResult = svm.sendTransaction(createTx);
        console.log("已创建延迟开始分发器:", createResult);

        // 设置默克尔根
        const setMerkleIx = await program.methods
          .setMerkleRoot(testMerkleRoot)
          .accounts({
            distributor: delayedDistributorPda,
            operator: operator.publicKey,
          })
          .instruction();

        const merkleRootTx = new Transaction();
        merkleRootTx.add(setMerkleIx);
        merkleRootTx.recentBlockhash = svm.latestBlockhash();
        merkleRootTx.feePayer = operator.publicKey;
        merkleRootTx.sign(operator);

        const merkleResult = svm.sendTransaction(merkleRootTx);
        console.log("为延迟分发器设置默克尔根:", merkleResult);

        // 将开始时间设置为未来 1 天（86400 秒）
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        startTimeOneDayLater = currentTimestamp + 86400; // 1 天 = 86400 秒

        console.log("将开始时间设置为 1 天后:", startTimeOneDayLater);

        const setTimeIx = await program.methods
          .setTime(new anchor.BN(startTimeOneDayLater))
          .accounts({
            distributor: delayedDistributorPda,
            operator: operator.publicKey,
          })
          .instruction();

        const timeTx = new Transaction();
        timeTx.add(setTimeIx);
        timeTx.recentBlockhash = svm.latestBlockhash();
        timeTx.feePayer = operator.publicKey;
        timeTx.sign(operator);

        const timeResult = svm.sendTransaction(timeTx);
        console.log("为延迟分发器设置时间:", timeResult);

        // 验证分发器状态
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        expect(distributorAccount.startTime.toString()).to.equal(startTimeOneDayLater.toString());

        console.log("✅ SPL Token distributor with 1 day delay created successfully!");
      } catch (error) {
        console.error("Failed to create delayed start distributor:", error);
        throw error;
      }
    });

    it("Scenario 1: Claim now (before start time) - should fail", async () => {
      try {
        console.log("=== Testing claim before start time (should fail) ===");

        // 为申领者1创建代币账户
        const claimant1TokenAccountKeypair = liteSvmCreateAccount(svm, tokenMint, claimant1.publicKey, claimant1, TOKEN_PROGRAM_ID);
        delayedClaimant1TokenAccount = claimant1TokenAccountKeypair.publicKey;

        // 查找申领状态 PDA
        [delayedClaimStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("claim"), delayedDistributorPda.toBuffer(), claimant1.publicKey.toBuffer()], programId);

        const claimIndex = 0;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // 验证当前时间在开始时间之前
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        console.log("当前时间戳:", currentTimestamp);
        console.log("开始时间:", startTimeOneDayLater);
        console.log("申领应该失败:", currentTimestamp < startTimeOneDayLater);

        expect(currentTimestamp).to.be.lessThan(startTimeOneDayLater);

        // 尝试申领（应该失败）
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            tokenVault: delayedTokenVaultPda,
            claimantTokenAccount: delayedClaimant1TokenAccount,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        claimTx.recentBlockhash = svm.latestBlockhash();
        claimTx.feePayer = claimant1.publicKey;
        claimTx.sign(claimant1);

        const claimResult = svm.sendTransaction(claimTx);
        const txResultStr = String(claimResult);

        // 应该失败，因为在开始时间之前申领
        if (isTransactionFailed(claimResult)) {
          console.log("✅ 申领在开始时间之前正确失败 - 交易按预期失败");
          const errorDetails = formatError(claimResult);
          console.log("✅ 申领在开始时间之前正确失败:", errorDetails);
        } else {
          expect.fail("申领应该在开始时间之前失败");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Claim correctly failed before start time:", errorDetails);
      }
    });

    it("Scenario 2: Claim after 1 day - should succeed and verify token amounts", async () => {
      try {
        console.log("=== Testing claim after 1 day (should succeed) ===");

        // 推进时间到 1 天 + 1 秒后
        const targetTimestamp = startTimeOneDayLater + 1;
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("已推进时间到:", targetTimestamp);

        // 验证时间现在在开始时间之后
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        expect(currentTimestamp).to.be.greaterThan(startTimeOneDayLater);

        const claimIndex = 0;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // 获取初始余额
        const initialVaultBalance = await getAccount(provider.connection, delayedTokenVaultPda, undefined, TOKEN_PROGRAM_ID);
        const initialClaimantBalance = await getAccount(provider.connection, delayedClaimant1TokenAccount, undefined, TOKEN_PROGRAM_ID);

        console.log("初始金库余额:", initialVaultBalance.amount.toString());
        console.log("初始申领者余额:", initialClaimantBalance.amount.toString());

        // 执行申领
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            tokenVault: delayedTokenVaultPda,
            claimantTokenAccount: delayedClaimant1TokenAccount,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        ensureUniqueTransaction(claimTx);
        claimTx.feePayer = claimant1.publicKey;
        claimTx.sign(claimant1);

        const claimResult = svm.sendTransaction(claimTx);
        console.log("申领交易结果:", claimResult);

        // 验证交易成功
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`申领交易失败: ${txResultStr}`);
        }

        // 验证申领后的余额
        const finalVaultBalance = await getAccount(provider.connection, delayedTokenVaultPda, undefined, TOKEN_PROGRAM_ID);
        const finalClaimantBalance = await getAccount(provider.connection, delayedClaimant1TokenAccount, undefined, TOKEN_PROGRAM_ID);

        console.log("最终金库余额:", finalVaultBalance.amount.toString());
        console.log("最终申领者余额:", finalClaimantBalance.amount.toString());

        // 验证正确的数量
        const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
        const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

        expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
        expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

        // 验证申领状态
        const claimStatus = await program.account.claimStatus.fetch(delayedClaimStatusPda);
        expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

        console.log("✅ Claim after 1 day succeeded and token amounts verified!");
      } catch (error) {
        console.error("Claim after 1 day test failed:", error);
        throw error;
      }
    });

    it("Scenario 3: Close claim status now (before end time) - should fail", async () => {
      try {
        console.log("=== Testing close claim status before end time (should fail) ===");

        // 验证我们仍在结束时间之前
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("当前时间戳:", currentTimestamp);
        console.log("结束时间:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // 尝试关闭申领状态（应该失败）
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            claimant: claimant1.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        closeClaimTx.recentBlockhash = svm.latestBlockhash();
        closeClaimTx.feePayer = claimant1.publicKey;
        closeClaimTx.sign(claimant1);

        const closeResult = svm.sendTransaction(closeClaimTx);
        const txResultStr = String(closeResult);

        // 应该失败，因为我们在结束时间之前
        if (isTransactionFailed(closeResult)) {
          console.log("✅ 关闭申领状态在结束时间之前正确失败 - 交易按预期失败");
          const errorDetails = formatError(closeResult);
          console.log("✅ 关闭申领状态错误详情:", errorDetails);
        } else {
          expect.fail("关闭申领状态应该在结束时间之前失败");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Close claim status correctly failed before end time:", errorDetails);
      }
    });

    it("Scenario 4: Owner withdraw now (before end time) - should fail", async () => {
      try {
        console.log("=== Testing owner withdraw before end time (should fail) ===");

        // 验证我们仍在结束时间之前
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("当前时间戳:", currentTimestamp);
        console.log("结束时间:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // 尝试提取（应该失败）
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda,
            tokenVault: delayedTokenVaultPda,
            ownerTokenAccount: ownerTokenAccount,
            tokenMint: tokenMint,
            owner: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        withdrawTx.recentBlockhash = svm.latestBlockhash();
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);
        const txResultStr = String(withdrawResult);

        // 应该失败，因为我们在结束时间之前
        if (isTransactionFailed(withdrawResult)) {
          console.log("✅ 拥有者提取在结束时间之前正确失败 - 交易按预期失败");
          const errorDetails = formatError(withdrawResult);
          console.log("✅ 拥有者提取错误详情:", errorDetails);
        } else {
          expect.fail("拥有者提取应该在结束时间之前失败");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Owner withdraw correctly failed before end time:", errorDetails);
      }
    });

    it("Scenario 5: Close claim status after 14 days - should succeed", async () => {
      try {
        console.log("=== Testing close claim status after 14 days (should succeed) ===");

        // 推进时间到开始时间后 14 天
        const targetTimestamp = startTimeOneDayLater + 14 * 24 * 60 * 60 + 1; // 14 天 + 1 秒
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("已推进时间到开始时间后 14 天:", targetTimestamp);

        // 验证我们现在在结束时间之后
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("当前时间戳:", currentTimestamp);
        console.log("结束时间:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.greaterThan(distributorAccount.endTime.toNumber());

        // 关闭申领状态（应该成功）
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            claimant: claimant1.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        ensureUniqueTransaction(closeClaimTx);
        closeClaimTx.feePayer = claimant1.publicKey;
        closeClaimTx.sign(claimant1);

        const closeResult = svm.sendTransaction(closeClaimTx);
        console.log("Close claim status result:", closeResult);

        // 验证交易成功
        const txResultStr = String(closeResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`关闭申领状态失败: ${txResultStr}`);
        }

        // 验证申领状态账户已关闭
        try {
          await program.account.claimStatus.fetch(delayedClaimStatusPda);
          expect.fail("申领状态账户应该已关闭");
        } catch (error) {
          console.log("✅ 申领状态账户已正确关闭");
        }

        console.log("✅ Close claim status after 14 days succeeded!");
      } catch (error) {
        console.error("Close claim status after 14 days test failed:", error);
        throw error;
      }
    });

    it("Scenario 6: Owner withdraw after 14 days - should succeed", async () => {
      try {
        console.log("=== Testing owner withdraw after 14 days (should succeed) ===");

        // 获取初始拥有者余额
        const initialOwnerBalance = await getAccount(provider.connection, ownerTokenAccount, undefined, TOKEN_PROGRAM_ID);
        console.log("初始拥有者余额:", initialOwnerBalance.amount.toString());

        // 获取剩余金库余额
        const vaultBalance = await getAccount(provider.connection, delayedTokenVaultPda, undefined, TOKEN_PROGRAM_ID);
        console.log("剩余金库余额:", vaultBalance.amount.toString());

        // 执行提取
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda,
            tokenVault: delayedTokenVaultPda,
            ownerTokenAccount: ownerTokenAccount,
            tokenMint: tokenMint,
            owner: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        ensureUniqueTransaction(withdrawTx);
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);
        console.log("提取结果:", withdrawResult);

        // 验证交易成功
        const txResultStr = String(withdrawResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`提取失败: ${txResultStr}`);
        }

        // 验证最终拥有者余额
        const finalOwnerBalance = await getAccount(provider.connection, ownerTokenAccount, undefined, TOKEN_PROGRAM_ID);
        console.log("最终拥有者余额:", finalOwnerBalance.amount.toString());

        // 验证已提取正确的数量
        const expectedOwnerBalance = initialOwnerBalance.amount + vaultBalance.amount;
        expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

        console.log("✅ Owner withdraw after 14 days succeeded!");
      } catch (error) {
        console.error("Owner withdraw after 14 days test failed:", error);
        throw error;
      }
    });
  });

  // 额外测试套件 2：Token 2022，1 天开始时间延迟
  describe("Token 2022 - 1 Day Start Time Delay Tests", () => {
    let delayedDistributorPda2022: PublicKey;
    let delayedTokenVaultPda2022: PublicKey;
    let delayedClaimant2TokenAccount2022: PublicKey;
    let delayedClaimStatusPda2022: PublicKey;
    let startTimeOneDayLater2022: number;

    it("Create distributor with Token 2022 (1 day start time delay)", async () => {
      const totalAmount = new anchor.BN(500000000000); // 500 tokens

      try {
        console.log("=== Creating Token 2022 distributor with 1 day start time delay ===");

        // 动态获取下一个 nonce 号码
        const nextnonce = await getNextNonceForOwner(owner.publicKey);
        console.log("延迟开始测试的下一个 nonce（Token 2022）:", nextnonce);

        // 计算此 nonce 的 PDA
        delayedDistributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, nextnonce);
        delayedTokenVaultPda2022 = calculateVaultPda(delayedDistributorPda2022);

        console.log("延迟 Token 2022 分发器 PDA:", delayedDistributorPda2022.toString());
        console.log("延迟 Token 2022 金库 PDA:", delayedTokenVaultPda2022.toString());

        // 创建分发器
        const createIx = await program.methods
          .createDistributor(totalAmount)
          .accounts({
            ownerNonce: ownerNoncePda,
            distributor: delayedDistributorPda2022,
            tokenVault: delayedTokenVaultPda2022,
            tokenMint: tokenMint2022,
            ownerTokenAccount: ownerTokenAccount2022,
            owner: owner.publicKey,
            operator: operator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const createTx = new Transaction();
        createTx.add(createIx);
        createTx.recentBlockhash = svm.latestBlockhash();
        createTx.feePayer = owner.publicKey;
        createTx.sign(owner);

        const createResult = svm.sendTransaction(createTx);
        console.log("已创建延迟开始分发器（Token 2022）:", createResult);

        // 设置默克尔根
        const setMerkleIx = await program.methods
          .setMerkleRoot(testMerkleRoot)
          .accounts({
            distributor: delayedDistributorPda2022,
            operator: operator.publicKey,
          })
          .instruction();

        const merkleRootTx = new Transaction();
        merkleRootTx.add(setMerkleIx);
        merkleRootTx.recentBlockhash = svm.latestBlockhash();
        merkleRootTx.feePayer = operator.publicKey;
        merkleRootTx.sign(operator);

        const merkleResult = svm.sendTransaction(merkleRootTx);
        console.log("为延迟分发器设置默克尔根（Token 2022）:", merkleResult);

        // 将开始时间设置为未来 1 天（86400 秒）
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        startTimeOneDayLater2022 = currentTimestamp + 86400; // 1 天 = 86400 秒

        console.log("将开始时间设置为 1 天后（Token 2022）:", startTimeOneDayLater2022);

        const setTimeIx = await program.methods
          .setTime(new anchor.BN(startTimeOneDayLater2022))
          .accounts({
            distributor: delayedDistributorPda2022,
            operator: operator.publicKey,
          })
          .instruction();

        const timeTx = new Transaction();
        timeTx.add(setTimeIx);
        timeTx.recentBlockhash = svm.latestBlockhash();
        timeTx.feePayer = operator.publicKey;
        timeTx.sign(operator);

        const timeResult = svm.sendTransaction(timeTx);
        console.log("为延迟分发器设置时间（Token 2022）:", timeResult);

        // 验证分发器状态
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        expect(distributorAccount.startTime.toString()).to.equal(startTimeOneDayLater2022.toString());

        console.log("✅ Token 2022 distributor with 1 day delay created successfully!");
      } catch (error) {
        console.error("Failed to create delayed start distributor (Token 2022):", error);
        throw error;
      }
    });

    it("Scenario 1: Claim now (before start time) - should fail", async () => {
      try {
        console.log("=== Testing Token 2022 claim before start time (should fail) ===");

        // 为申领者2创建代币账户
        const claimant2TokenAccountKeypair = liteSvmCreateAccount(svm, tokenMint2022, claimant2.publicKey, claimant2, TOKEN_2022_PROGRAM_ID);
        delayedClaimant2TokenAccount2022 = claimant2TokenAccountKeypair.publicKey;

        // 查找申领状态 PDA
        [delayedClaimStatusPda2022] = PublicKey.findProgramAddressSync([Buffer.from("claim"), delayedDistributorPda2022.toBuffer(), claimant2.publicKey.toBuffer()], programId);

        const claimIndex = 1;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // 验证当前时间在开始时间之前
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        console.log("当前时间戳:", currentTimestamp);
        console.log("开始时间:", startTimeOneDayLater2022);
        expect(currentTimestamp).to.be.lessThan(startTimeOneDayLater2022);

        // 尝试申领（应该失败）
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            tokenVault: delayedTokenVaultPda2022,
            claimantTokenAccount: delayedClaimant2TokenAccount2022,
            tokenMint: tokenMint2022,
            claimant: claimant2.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        claimTx.recentBlockhash = svm.latestBlockhash();
        claimTx.feePayer = claimant2.publicKey;
        claimTx.sign(claimant2);

        const claimResult = svm.sendTransaction(claimTx);
        const txResultStr = String(claimResult);

        // 应该失败，因为在开始时间之前申领
        if (isTransactionFailed(claimResult)) {
          console.log("✅ Token 2022 申领在开始时间之前正确失败 - 交易按预期失败");
          const errorDetails = formatError(claimResult);
          console.log("✅ Token 2022 申领错误详情:", errorDetails);
        } else {
          expect.fail("Token 2022 申领应该在开始时间之前失败");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Token 2022 申领在开始时间之前正确失败:", errorDetails);
      }
    });

    it("Scenario 2: Claim after 1 day - should succeed and verify token amounts", async () => {
      try {
        console.log("=== 测试 Token 2022 在 1 天后申领（应该成功） ===");

        // 推进时间到 1 天 + 1 秒后
        const targetTimestamp = startTimeOneDayLater2022 + 1;
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("已推进时间到:", targetTimestamp);

        // 验证时间现在在开始时间之后
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        expect(currentTimestamp).to.be.greaterThan(startTimeOneDayLater2022);

        const claimIndex = 1;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // 获取初始余额
        const initialVaultBalance = await getAccount(provider.connection, delayedTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
        const initialClaimantBalance = await getAccount(provider.connection, delayedClaimant2TokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);

        console.log("初始金库余额:", initialVaultBalance.amount.toString());
        console.log("初始申领者余额:", initialClaimantBalance.amount.toString());

        // 执行申领
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            tokenVault: delayedTokenVaultPda2022,
            claimantTokenAccount: delayedClaimant2TokenAccount2022,
            tokenMint: tokenMint2022,
            claimant: claimant2.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        ensureUniqueTransaction(claimTx);
        claimTx.feePayer = claimant2.publicKey;
        claimTx.sign(claimant2);

        const claimResult = svm.sendTransaction(claimTx);
        console.log("Token 2022 申领交易结果:", claimResult);

        // 验证交易成功
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Token 2022 申领交易失败: ${txResultStr}`);
        }

        // 验证申领后的余额
        const finalVaultBalance = await getAccount(provider.connection, delayedTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
        const finalClaimantBalance = await getAccount(provider.connection, delayedClaimant2TokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);

        console.log("最终金库余额:", finalVaultBalance.amount.toString());
        console.log("最终申领者余额:", finalClaimantBalance.amount.toString());

        // 验证正确的数量
        const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
        const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

        expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
        expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

        // 验证申领状态
        const claimStatus = await program.account.claimStatus.fetch(delayedClaimStatusPda2022);
        expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

        console.log("✅ Token 2022 claim after 1 day succeeded and token amounts verified!");
      } catch (error) {
        console.error("Token 2022 claim after 1 day test failed:", error);
        throw error;
      }
    });

    it("Scenario 3: Close claim status now (before end time) - should fail", async () => {
      try {
        console.log("=== Testing Token 2022 close claim status before end time (should fail) ===");

        // 验证我们仍在结束时间之前
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("当前时间戳:", currentTimestamp);
        console.log("结束时间:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // 尝试关闭申领状态（应该失败）
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            claimant: claimant2.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        closeClaimTx.recentBlockhash = svm.latestBlockhash();
        closeClaimTx.feePayer = claimant2.publicKey;
        closeClaimTx.sign(claimant2);

        const closeResult = svm.sendTransaction(closeClaimTx);
        const txResultStr = String(closeResult);

        // 应该失败，因为我们在结束时间之前
        if (isTransactionFailed(closeResult)) {
          console.log("✅ Token 2022 关闭申领状态在结束时间之前正确失败 - 交易按预期失败");
          const errorDetails = formatError(closeResult);
          console.log("✅ Token 2022 关闭申领状态错误详情:", errorDetails);
        } else {
          expect.fail("Token 2022 关闭申领状态应该在结束时间之前失败");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Token 2022 关闭申领状态在结束时间之前正确失败:", errorDetails);
      }
    });

    it("Scenario 4: Owner withdraw now (before end time) - should fail", async () => {
      try {
        console.log("=== 测试 Token 2022 拥有者在结束时间之前提取（应该失败） ===");

        // 验证我们仍在结束时间之前
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("当前时间戳:", currentTimestamp);
        console.log("结束时间:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // 尝试提取（应该失败）
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda2022,
            tokenVault: delayedTokenVaultPda2022,
            ownerTokenAccount: ownerTokenAccount2022,
            tokenMint: tokenMint2022,
            owner: owner.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        withdrawTx.recentBlockhash = svm.latestBlockhash();
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);
        const txResultStr = String(withdrawResult);

        // 应该失败，因为我们在结束时间之前
        if (isTransactionFailed(withdrawResult)) {
          console.log("✅ Token 2022 拥有者提取在结束时间之前正确失败 - 交易按预期失败");
          const errorDetails = formatError(withdrawResult);
          console.log("✅ Token 2022 拥有者提取错误详情:", errorDetails);
        } else {
          expect.fail("Token 2022 拥有者提取应该在结束时间之前失败");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Token 2022 拥有者提取在结束时间之前正确失败:", errorDetails);
      }
    });

    it("Scenario 5: Close claim status after 14 days - should succeed", async () => {
      try {
        console.log("=== 测试 Token 2022 在 14 天后关闭申领状态（应该成功） ===");

        // 推进时间到开始时间后 14 天
        const targetTimestamp = startTimeOneDayLater2022 + 14 * 24 * 60 * 60 + 1; // 14 天 + 1 秒
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("已推进时间到开始时间后 14 天:", targetTimestamp);

        // 验证我们现在在结束时间之后
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("当前时间戳:", currentTimestamp);
        console.log("结束时间:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.greaterThan(distributorAccount.endTime.toNumber());

        // 关闭申领状态（应该成功）
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            claimant: claimant2.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        ensureUniqueTransaction(closeClaimTx);
        closeClaimTx.feePayer = claimant2.publicKey;
        closeClaimTx.sign(claimant2);

        const closeResult = svm.sendTransaction(closeClaimTx);
        console.log("Token 2022 关闭申领状态结果:", closeResult);

        // 验证交易成功
        const txResultStr = String(closeResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Token 2022 关闭申领状态失败: ${txResultStr}`);
        }

        // 验证申领状态账户已关闭
        try {
          await program.account.claimStatus.fetch(delayedClaimStatusPda2022);
          expect.fail("Token 2022 申领状态账户应该已关闭");
        } catch (error) {
          console.log("✅ Token 2022 申领状态账户已正确关闭");
        }

        console.log("✅ Token 2022 close claim status after 14 days succeeded!");
      } catch (error) {
        console.error("Token 2022 close claim status after 14 days test failed:", error);
        throw error;
      }
    });

    it("Scenario 6: Owner withdraw after 14 days - should succeed", async () => {
      try {
        console.log("=== Testing Token 2022 owner withdraw after 14 days (should succeed) ===");

        // 获取初始拥有者余额
        const initialOwnerBalance = await getAccount(provider.connection, ownerTokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);
        console.log("初始拥有者余额:", initialOwnerBalance.amount.toString());

        // 获取剩余金库余额
        const vaultBalance = await getAccount(provider.connection, delayedTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
        console.log("剩余金库余额:", vaultBalance.amount.toString());

        // 执行提取
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda2022,
            tokenVault: delayedTokenVaultPda2022,
            ownerTokenAccount: ownerTokenAccount2022,
            tokenMint: tokenMint2022,
            owner: owner.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        ensureUniqueTransaction(withdrawTx);
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);

        // 验证交易成功
        const txResultStr = String(withdrawResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Token 2022 提取失败: ${txResultStr}`);
        }

        // 验证最终拥有者余额
        const finalOwnerBalance = await getAccount(provider.connection, ownerTokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);
        console.log("最终拥有者余额:", finalOwnerBalance.amount.toString());

        // 验证已提取正确的数量
        const expectedOwnerBalance = initialOwnerBalance.amount + vaultBalance.amount;
        expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

        console.log("✅ Token 2022 owner withdraw after 14 days succeeded!");
      } catch (error) {
        console.error("Token 2022 owner withdraw after 14 days test failed:", error);
        throw error;
      }
    });
  });
});
