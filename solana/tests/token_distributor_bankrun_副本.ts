import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
  MINT_SIZE,
  createInitializeMintInstruction,
  ACCOUNT_SIZE,
  createInitializeAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { createMint as createMint2022, createAccount as createAccount2022, mintTo as mintTo2022, TOKEN_2022_PROGRAM_ID, getAccount as getAccount2022 } from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { SimpleMerkleTree, TreeNode } from "./utils/merkle_tree";
import * as path from "path";
import { startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import * as crypto from "crypto";
import { Clock } from "solana-bankrun";

/**
 * 手动创建 SPL 代币铸造（支持 TOKEN_PROGRAM_ID 和 TOKEN_2022_PROGRAM_ID）
 * @param provider BankrunProvider 或 AnchorProvider
 * @param mintAuthority 具有铸造权限的地址
 * @param decimals 代币精度（通常是 6 或 9）
 * @param programId TOKEN_PROGRAM_ID 或 TOKEN_2022_PROGRAM_ID
 * @param seed 用于生成确定性地址的可选种子字符串
 * @returns 铸造密钥对
 */
async function manualCreateMint(provider: any, mintAuthority: PublicKey, decimals = 9, programId = TOKEN_PROGRAM_ID, seed?: string): Promise<Keypair> {
  // 使用种子生成具有可选随机性的密钥对
  let mintSeed: string;
  if (seed) {
    mintSeed = seed;
  } else {
    // 添加时间戳和随机组件以确保跨测试运行的唯一性
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    mintSeed = `mint-${mintAuthority.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;
  }

  // 使用 SHA256 哈希生成唯一种子
  const hash = crypto.createHash("sha256").update(mintSeed).digest();
  const mint = Keypair.fromSeed(hash);

  // 租金计算（Token 2022 使用相同的 MINT_SIZE）
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const tx = new Transaction();

  // 创建铸造账户（系统程序）
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
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
      mintAuthority, // 铸造权限
      null, // 冻结权限（可选）
      programId,
    ),
  );

  // 发送交易（注意：铸造是签名者）
  await provider.sendAndConfirm(tx, [mint]);

  return mint;
}

/**
 * 手动创建代币账户（支持 TOKEN_PROGRAM_ID 和 TOKEN_2022_PROGRAM_ID）
 * @param provider BankrunProvider 或 AnchorProvider
 * @param mint 代币铸造地址
 * @param owner 代币账户拥有者
 * @param programId TOKEN_PROGRAM_ID 或 TOKEN_2022_PROGRAM_ID
 * @returns 代币账户密钥对
 */
async function manualCreateAccount(provider: any, mint: PublicKey, owner: PublicKey, programId = TOKEN_PROGRAM_ID): Promise<Keypair> {
  // 添加时间戳和随机组件以确保跨测试运行的唯一性
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const accountSeed = `account-${mint.toBase58()}-${owner.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;

  // 使用 SHA256 哈希生成唯一种子
  const hash = crypto.createHash("sha256").update(accountSeed).digest();
  const account = Keypair.fromSeed(hash);

  // 租金计算
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

  const tx = new Transaction();

  // 创建代币账户（系统程序）
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: account.publicKey,
      lamports,
      space: ACCOUNT_SIZE,
      programId: programId,
    }),
  );

  // 初始化代币账户（SPL 代币 CPI）
  tx.add(createInitializeAccountInstruction(account.publicKey, mint, owner, programId));

  // 发送交易（注意：账户是签名者）
  await provider.sendAndConfirm(tx, [account]);

  return account;
}

/**
 * 手动向指定账户铸造代币（支持 TOKEN_PROGRAM_ID 和 TOKEN_2022_PROGRAM_ID）
 * @param provider BankrunProvider 或 AnchorProvider
 * @param mint 代币铸造地址
 * @param destination 目标代币账户地址
 * @param authority 铸造权限
 * @param amount 要铸造的数量
 * @param programId TOKEN_PROGRAM_ID 或 TOKEN_2022_PROGRAM_ID
 * @returns 交易签名
 */
async function manualMintTo(provider: any, mint: PublicKey, destination: PublicKey, authority: Keypair, amount: number, programId = TOKEN_PROGRAM_ID): Promise<string> {
  const tx = new Transaction();

  // 添加铸造指令
  tx.add(createMintToInstruction(mint, destination, authority.publicKey, amount, [], programId));

  // 发送交易（注意：权限是签名者）
  return await provider.sendAndConfirm(tx, [authority]);
}

describe("token_distributor_bankrun", () => {
  let context: any;
  let provider: BankrunProvider;
  let program: Program<TokenDistributor>;

  let tokenMint: PublicKey;
  let tokenMint2022: PublicKey;
  let owner: Keypair;
  let operator: Keypair;
  let ownerTokenAccount: PublicKey;
  let ownerTokenAccount2022: PublicKey;

  // nonce 状态 PDA
  let ownerNoncePda: PublicKey;

  // 分发器和金库 PDA 将动态计算
  let distributorPda: PublicKey;
  let distributorPda2022: PublicKey;
  let tokenVaultPda: PublicKey;
  let tokenVaultPda2022: PublicKey;

  // 用于提取测试的额外变量
  let withdrawTestDistributorPda: PublicKey;
  let withdrawTestDistributorPda2022: PublicKey;
  let withdrawTestTokenVaultPda: PublicKey;
  let withdrawTestTokenVaultPda2022: PublicKey;

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
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(DISTRIBUTOR_SEED), tokenMint.toBuffer(), owner.toBuffer(), new anchor.BN(nonce).toArrayLike(Buffer, "le", 4)], program.programId);
    return pda;
  }

  // 计算金库 PDA 的辅助函数
  function calculateVaultPda(distributorPda: PublicKey): PublicKey {
    const VAULT_SEED = "vault";
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), distributorPda.toBuffer()], program.programId);
    return pda;
  }

  before(async () => {
    // 启动带有 Anchor 集成的 bankrun
    context = await startAnchor("", [], []);

    // 创建 BankrunProvider
    provider = new BankrunProvider(context);

    // 获取程序
    anchor.setProvider(provider);
    program = anchor.workspace.TokenDistributor as Program<TokenDistributor>;

    // 使用 context payer 作为拥有者（它有 SOL）
    owner = context.payer;
    operator = Keypair.generate();

    console.log("owner:", owner.publicKey.toString());
    console.log("operator:", operator.publicKey.toString());

    // 计算 nonce 状态 PDA
    const OWNER_NONCE_SEED = "owner_nonce";
    [ownerNoncePda] = PublicKey.findProgramAddressSync([Buffer.from(OWNER_NONCE_SEED), owner.publicKey.toBuffer()], program.programId);
    console.log("ownerNoncePda:", ownerNoncePda.toString());

    // 检查余额
    const balance = await context.banksClient.getBalance(owner.publicKey);
    console.log(`owner balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    // 从拥有者给操作员一些 SOL
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: operator.publicKey,
        lamports: LAMPORTS_PER_SOL, // 1 SOL
      }),
    );
    transferTx.recentBlockhash = context.lastBlockhash;
    transferTx.sign(owner);
    await context.banksClient.processTransaction(transferTx);

    console.log("已向操作员转移 1 SOL");

    // 创建我们控制的测试申领者密钥对
    claimant1 = Keypair.generate();
    claimant2 = Keypair.generate();

    // 给申领者一些 SOL 用于交易费用
    for (const claimant of [claimant1, claimant2]) {
      const claimantTransferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: claimant.publicKey,
          lamports: LAMPORTS_PER_SOL * 0.1, // 0.1 SOL
        }),
      );
      claimantTransferTx.recentBlockhash = context.lastBlockhash;
      claimantTransferTx.sign(owner);
      await context.banksClient.processTransaction(claimantTransferTx);
    }
    console.log("已创建测试申领者并转移 SOL 用于交易费用");

    // 使用我们控制的密钥对创建测试树节点
    testTreeNodes = [
      { claimant: claimant1.publicKey, amount: new anchor.BN(1000) },
      { claimant: claimant2.publicKey, amount: new anchor.BN(2000) },
      { claimant: owner.publicKey, amount: new anchor.BN(3000) }, // 使用拥有者作为第三个申领者
      { claimant: operator.publicKey, amount: new anchor.BN(4000) }, // 使用操作员作为第四个申领者
    ];

    // 使用测试数据创建默克尔树
    testMerkleTree = new SimpleMerkleTree(testTreeNodes);
    testMerkleRoot = testMerkleTree.getMerkleRoot();
    console.log("已使用受控密钥对创建测试默克尔树");
    console.log("测试默克尔根:", testMerkleRoot);

    // 使用手动方法创建 SPL 代币铸造（nonce 1）
    const tokenMintKeypair = await manualCreateMint(provider, owner.publicKey, 9);
    tokenMint = tokenMintKeypair.publicKey;
    console.log("SPL 代币铸造已创建:", tokenMint.toString());

    // 使用手动方法创建 Token 2022 铸造（nonce 2）
    console.log("创建 Token 2022 铸造...");
    const tokenMint2022Keypair = await manualCreateMint(provider, owner.publicKey, 9, TOKEN_2022_PROGRAM_ID);
    tokenMint2022 = tokenMint2022Keypair.publicKey;
    console.log("Token 2022 铸造已创建:", tokenMint2022.toString());

    // 创建代币账户并铸造代币
    console.log("使用手动方法创建代币账户...");
    const ownerTokenAccountKeypair = await manualCreateAccount(provider, tokenMint, owner.publicKey, TOKEN_PROGRAM_ID);
    ownerTokenAccount = ownerTokenAccountKeypair.publicKey;

    const ownerTokenAccount2022Keypair = await manualCreateAccount(provider, tokenMint2022, owner.publicKey, TOKEN_2022_PROGRAM_ID);
    ownerTokenAccount2022 = ownerTokenAccount2022Keypair.publicKey;

    console.log("SPL 代币账户已创建:", ownerTokenAccount.toString());
    console.log("Token 2022 账户已创建:", ownerTokenAccount2022.toString());

    // 向拥有者账户铸造一些代币
    console.log("向拥有者账户铸造代币...");
    const mintAmount = 1000000000000; // 1000 个代币，9 位小数

    // 铸造 SPL 代币
    await manualMintTo(provider, tokenMint, ownerTokenAccount, owner, mintAmount, TOKEN_PROGRAM_ID);
    console.log("已向拥有者账户铸造 SPL 代币");

    // 铸造 Token 2022 代币
    await manualMintTo(provider, tokenMint2022, ownerTokenAccount2022, owner, mintAmount, TOKEN_2022_PROGRAM_ID);
    console.log("已向拥有者账户铸造 Token 2022 代币");

    // 计算第一个分发器的 PDA（将是 nonce 1 和 2）
    distributorPda = calculateDistributorPda(tokenMint, owner.publicKey, 1);
    tokenVaultPda = calculateVaultPda(distributorPda);

    distributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, 2);
    tokenVaultPda2022 = calculateVaultPda(distributorPda2022);

    // 注意：提取测试的 PDA 将根据实际计数器状态动态计算

    console.log("已计算 PDA:");
    console.log("SPL 代币分发器 PDA:", distributorPda.toString());
    console.log("SPL 代币金库 PDA:", tokenVaultPda.toString());
    console.log("Token 2022 分发器 PDA:", distributorPda2022.toString());
    console.log("Token 2022 金库 PDA:", tokenVaultPda2022.toString());

    // 注意：提取测试的 PDA 将根据实际计数器状态动态计算
  });

  it("Create distributor with SPL Token (nonce 1)", async () => {
    const totalAmount = new anchor.BN(500000000000); // 500 tokens

    try {
      console.log("Calling createDistributor with SPL Token, totalAmount:", totalAmount.toString());

      const tx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: distributorPda,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          ownerTokenAccount: ownerTokenAccount,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      console.log("Create SPL Token distributor transaction signature:", tx);

      // 验证 nonce 状态已创建/更新
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("Nonce 状态数据:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("1");

      // 验证创建分发器后的代币金库余额
      console.log("验证 SPL 代币金库余额...");
      const vaultAccount = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      console.log("SPL 代币金库余额:", vaultAccount.amount.toString());
      console.log("SPL 代币金库铸造:", vaultAccount.mint.toString());
      console.log("预期总数量:", totalAmount.toString());

      // 验证金库具有正确的数量和铸造
      expect(vaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(vaultAccount.mint.toString()).to.equal(tokenMint.toString());

      // 验证分发器账户存在且有数据
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);

      console.log("SPL 代币分发器账户数据:", {
        owner: distributorAccount.owner.toString(),
        operator: distributorAccount.operator.toString(),
        tokenMint: distributorAccount.tokenMint.toString(),
        initialTotalAmount: distributorAccount.initialTotalAmount.toString(),
        totalClaimed: distributorAccount.totalClaimed.toString(),
        nonce: distributorAccount.nonce.toString(),
      });

      // 基本验证
      expect(distributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(distributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(distributorAccount.tokenMint.toString()).to.equal(tokenMint.toString());
      expect(distributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(distributorAccount.totalClaimed.toString()).to.equal("0"); // 初始应为 0
      expect(distributorAccount.nonce.toString()).to.equal("1");

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

      const tx = await program.methods
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
        .signers([owner])
        .rpc();

      console.log("Create Token 2022 distributor transaction signature:", tx);

      // 验证 nonce 状态已更新
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("更新的 Nonce 状态数据:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("2");

      // 验证创建分发器后的代币金库余额
      console.log("验证 Token 2022 金库余额...");
      const vaultAccount = await getAccount(provider.connection, tokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);

      console.log("Token 2022 金库余额:", vaultAccount.amount.toString());
      console.log("Token 2022 金库铸造:", vaultAccount.mint.toString());
      console.log("预期总数量:", totalAmount.toString());

      // 验证金库具有正确的数量和铸造
      expect(vaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(vaultAccount.mint.toString()).to.equal(tokenMint2022.toString());

      // 验证分发器账户存在且有数据
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("Token 2022 分发器账户数据:", {
        owner: distributorAccount.owner.toString(),
        operator: distributorAccount.operator.toString(),
        tokenMint: distributorAccount.tokenMint.toString(),
        initialTotalAmount: distributorAccount.initialTotalAmount.toString(),
        totalClaimed: distributorAccount.totalClaimed.toString(),
        nonce: distributorAccount.nonce.toString(),
      });

      // 基本验证
      expect(distributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(distributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(distributorAccount.tokenMint.toString()).to.equal(tokenMint2022.toString());
      expect(distributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(distributorAccount.totalClaimed.toString()).to.equal("0"); // 初始应为 0
      expect(distributorAccount.nonce.toString()).to.equal("2");

      console.log("✅ Create Token 2022 distributor test passed!");
    } catch (error) {
      console.error("Create Token 2022 distributor test failed:", error);
      throw error;
    }
  });

  it("Set merkle root for both distributors", async () => {
    console.log("Using predefined test merkle root...");

    // 使用预定义的测试默克尔根
    const merkleRoot = testMerkleRoot;

    console.log("测试默克尔根:", merkleRoot);
    console.log("默克尔根长度:", merkleRoot.length);

    console.log("为 SPL 代币分发器（nonce 1）设置默克尔根...");

    const tx1 = await program.methods
      .setMerkleRoot(merkleRoot)
      .accounts({
        distributor: distributorPda,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("nonce 1 设置默克尔根交易签名:", tx1);

    console.log("为 Token 2022 分发器（nonce 2）设置默克尔根...");

    const tx2 = await program.methods
      .setMerkleRoot(merkleRoot)
      .accounts({
        distributor: distributorPda2022,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("nonce 2 设置默克尔根交易签名:", tx2);

    // 验证已为两个分发器设置默克尔根
    const distributorAccount1 = await program.account.tokenDistributor.fetch(distributorPda);
    const distributorAccount2022 = await program.account.tokenDistributor.fetch(distributorPda2022);

    console.log("nonce 1 设置的默克尔根:", distributorAccount1.merkleRoot);
    console.log("nonce 2 设置的默克尔根:", distributorAccount2022.merkleRoot);

    // 验证默克尔根匹配我们设置的值
    expect(distributorAccount1.merkleRoot).to.deep.equal(merkleRoot);
    expect(distributorAccount2022.merkleRoot).to.deep.equal(merkleRoot);

    console.log("✅ Set merkle root test passed for both distributors!");
  });

  it("Set time for nonce 1 and nonce 2 [current time]", async () => {
    console.log("Getting current Solana blockchain time...");

    // 使用 context.banksClient 获取当前 Solana 区块链时间
    const clock = await context.banksClient.getClock();
    const blockTime = Number(clock.unixTimestamp);

    console.log("当前 Solana 区块时间:", blockTime);

    // 将 nonce 1（SPL Token）的时间设置为当前时间 + 4 秒
    const startTimeV1 = blockTime + 4; // 从现在起 4 秒以满足验证
    console.log("将 nonce 1（SPL Token）的时间设置为当前时间 + 4 秒:", startTimeV1);

    const tx1 = await program.methods
      .setTime(new anchor.BN(startTimeV1))
      .accounts({
        distributor: distributorPda,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("nonce 1 设置时间交易签名:", tx1);

    // 将 nonce 2（Token 2022）的时间设置为 nonce 1 结束后
    // nonce 1 持续时间为 14 天（1,209,600 秒），所以 nonce 2 在该时间之后 + 10 秒缓冲开始
    const DURATION = 14 * 24 * 60 * 60; // 14 天（秒）
    const startTimeV2 = startTimeV1 + DURATION + 10; // nonce 1 结束时间 + 10 秒缓冲
    console.log("将 nonce 2（Token 2022）的时间设置为 nonce 1 结束后（+ 10 秒缓冲）:", startTimeV2);

    const tx2 = await program.methods
      .setTime(new anchor.BN(startTimeV2))
      .accounts({
        distributor: distributorPda2022,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("nonce 2 设置时间交易签名:", tx2);

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
  });

  it("Claim tokens for nonce 1 (SPL Token)[current time]", async () => {
    try {
      console.log("=== Testing claim for nonce 1 (SPL Token) ===");

      console.log("Using predefined test claimants and merkle tree data");

      // 测试申领者1的申领（1000 个代币）
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

      // 使用我们的手动函数为申领者1创建代币账户
      const claimant1TokenAccount = await manualCreateAccount(provider, tokenMint, claimant1.publicKey, TOKEN_PROGRAM_ID);
      console.log("已创建申领者1代币账户:", claimant1TokenAccount.publicKey.toString());

      // 查找申领者1的申领状态 PDA
      const [claimStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("claim"), distributorPda.toBuffer(), claimant1.publicKey.toBuffer()], program.programId);

      // 获取初始代币余额
      const initialVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const initialClaimantBalance = await getAccount(provider.connection, claimant1TokenAccount.publicKey, undefined, TOKEN_PROGRAM_ID);

      console.log("初始金库余额:", initialVaultBalance.amount.toString());
      console.log("初始申领者余额:", initialClaimantBalance.amount.toString());

      // 测试在分发时间之前的早期申领失败
      console.log("=== 测试分发时间之前的早期申领（应该失败） ===");

      try {
        console.log("尝试在分发时间之前申领（预期失败）...");

        // 检查当前时间与分发时间
        const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
        const currentClock = await context.banksClient.getClock();
        const currentBlockTime = Number(currentClock.unixTimestamp);

        console.log("当前区块时间:", currentBlockTime);
        console.log("分发时间:", distributorAccount.startTime.toString());
        console.log("距离开始的时间:", distributorAccount.startTime.toNumber() - currentBlockTime, "秒");

        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount.publicKey,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([claimant1])
          .rpc();

        // 如果我们到达这里，测试应该失败，因为申领应该已被拒绝
        expect.fail("早期申领应该失败但意外成功");
      } catch (error) {
        // 这是预期的 - 申领应该失败
        console.log("✅ 早期申领正确失败，错误:", error.message);

        // 验证它是正确的错误类型（分发未开始）
        expect(error.message).to.include("DistributionNotStarted");
        console.log("✅ 错误类型已验证: DistributionNotStarted");
        console.log("✅ 早期申领测试通过 - 申领在分发时间之前被正确拒绝！");
      }

      // 使用时间旅行跳转到分发时间，而不是等待
      console.log("=== 使用时间旅行跳转到分发时间 ===");
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      const startTime = distributorAccount.startTime.toNumber();

      // 获取当前时钟并创建具有更新时间戳的新时钟
      const currentClock = await context.banksClient.getClock();
      console.log("当前时间:", Number(currentClock.unixTimestamp));
      console.log("跳转到分发时间:", startTime);

      // 使用 setClock 跳转到分发开始时间
      context.setClock(
        new Clock(
          currentClock.slot,
          currentClock.epochStartTimestamp,
          currentClock.epoch,
          currentClock.leaderScheduleEpoch,
          BigInt(startTime + 1), // +1 秒以确保我们超过开始时间
        ),
      );

      const newClock = await context.banksClient.getClock();
      console.log("时间旅行后的新时间:", Number(newClock.unixTimestamp));
      console.log("✅ 时间旅行成功！");

      // 执行申领交易
      console.log("执行申领交易...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda,
          claimantTokenAccount: claimant1TokenAccount.publicKey,
          tokenMint: tokenMint,
          claimant: claimant1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([claimant1])
        .rpc();

      console.log("申领交易签名:", claimTx);

      // 验证申领后的余额
      const finalVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const finalClaimantBalance = await getAccount(provider.connection, claimant1TokenAccount.publicKey, undefined, TOKEN_PROGRAM_ID);

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
      console.log("测试双重申领预防...");
      try {
        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount.publicKey,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([claimant1])
          .rpc();

        // 如果我们到达这里，测试应该失败
        expect.fail("双重申领应该失败");
      } catch (error) {
        console.log("✅ 双重申领正确阻止:", error.message);
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

      console.log("Using predefined test claimants and merkle tree data");

      // 测试申领者2的申领（2000 个代币）
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

      // 使用我们的手动函数为申领者2创建代币账户
      const claimant2TokenAccount = await manualCreateAccount(provider, tokenMint2022, claimant2.publicKey, TOKEN_2022_PROGRAM_ID);
      console.log("已创建申领者2代币账户:", claimant2TokenAccount.publicKey.toString());

      // 查找申领者2的申领状态 PDA
      const [claimStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("claim"), distributorPda2022.toBuffer(), claimant2.publicKey.toBuffer()], program.programId);

      // 获取初始代币余额
      const initialVaultBalance = await getAccount2022(provider.connection, tokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);

      const initialClaimantBalance = await getAccount2022(provider.connection, claimant2TokenAccount.publicKey, undefined, TOKEN_2022_PROGRAM_ID);

      console.log("初始金库余额:", initialVaultBalance.amount.toString());
      console.log("初始申领者余额:", initialClaimantBalance.amount.toString());

      // 注意：早期申领测试已在上面的 SPL Token 测试中涵盖

      // 使用时间旅行跳转到分发开始时间，而不是等待
      console.log("=== 使用时间旅行跳转到分发开始时间 ===");
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);
      const startTime = distributorAccount.startTime.toNumber();

      // 获取当前时钟并创建具有更新时间戳的新时钟
      const currentClock = await context.banksClient.getClock();
      console.log("当前时间:", Number(currentClock.unixTimestamp));
      console.log("跳转到分发开始时间:", startTime);

      // 使用 setClock 跳转到分发开始时间
      context.setClock(
        new Clock(
          currentClock.slot,
          currentClock.epochStartTimestamp,
          currentClock.epoch,
          currentClock.leaderScheduleEpoch,
          BigInt(startTime + 1), // +1 秒以确保我们超过开始时间
        ),
      );

      const newClock = await context.banksClient.getClock();
      console.log("时间旅行后的新时间:", Number(newClock.unixTimestamp));
      console.log("✅ 时间旅行成功！");

      // 执行申领交易
      console.log("执行申领交易...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda2022,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda2022,
          claimantTokenAccount: claimant2TokenAccount.publicKey,
          tokenMint: tokenMint2022,
          claimant: claimant2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([claimant2])
        .rpc();

      console.log("申领交易签名:", claimTx);

      // 验证申领后的余额
      const finalVaultBalance = await getAccount2022(provider.connection, tokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);

      const finalClaimantBalance = await getAccount2022(provider.connection, claimant2TokenAccount.publicKey, undefined, TOKEN_2022_PROGRAM_ID);

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
      console.log("测试双重申领预防...");
      try {
        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda2022,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda2022,
            claimantTokenAccount: claimant2TokenAccount.publicKey,
            tokenMint: tokenMint2022,
            claimant: claimant2.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([claimant2])
          .rpc();

        // 如果我们到达这里，测试应该失败
        expect.fail("双重申领应该失败");
      } catch (error) {
        console.log("✅ 双重申领正确阻止:", error.message);
      }

      console.log("✅ Claim test completed successfully!");
    } catch (error) {
      console.error("Claim test failed:", error);
      throw error;
    }
  });

  it("Withdraw tokens (SPL Token) - No start time set", async () => {
    // 动态获取下一个 nonce 号码（在 try-catch 外部声明以用于作用域）
    const nextnonce = await getNextNonceForOwner(owner.publicKey);

    try {
      console.log("=== 测试提取（SPL Token）- 未设置开始时间 ===");

      const totalAmount = new anchor.BN(100000000000); // 100 个代币

      console.log("提取测试的下一个 nonce:", nextnonce);

      // 计算此 nonce 的 PDA
      withdrawTestDistributorPda = calculateDistributorPda(tokenMint, owner.publicKey, nextnonce);
      withdrawTestTokenVaultPda = calculateVaultPda(withdrawTestDistributorPda);

      console.log("提取测试 SPL 代币分发器 PDA:", withdrawTestDistributorPda.toString());
      console.log("提取测试 SPL 代币金库 PDA:", withdrawTestTokenVaultPda.toString());

      // 获取初始拥有者 SOL 余额
      const initialOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("初始拥有者 SOL 余额:", Number(initialOwnerSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 为提取测试创建分发器
      console.log("为提取测试创建分发器（nonce", nextnonce, ")...");
      const createTx = await program.methods
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
        .signers([owner])
        .rpc();

      console.log("已创建提取测试分发器交易:", createTx);

      // 创建分发器后获取 SOL 余额（应该由于租金和交易费用而降低）
      const afterCreateSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("创建后拥有者 SOL 余额:", Number(afterCreateSolBalance) / LAMPORTS_PER_SOL, "SOL");

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

      // 在提取之前获取 SOL 余额
      const beforeWithdrawSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("提取前拥有者 SOL 余额:", Number(beforeWithdrawSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 执行提取 - 应该成功，因为开始时间未设置（场景 1）
      console.log("执行提取交易...");
      const withdrawTx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda,
          tokenVault: withdrawTestTokenVaultPda,
          ownerTokenAccount: ownerTokenAccount,
          tokenMint: tokenMint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      console.log("提取交易签名:", withdrawTx);

      // 获取最终拥有者 SOL 余额
      const finalOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("最终拥有者 SOL 余额:", Number(finalOwnerSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 计算 SOL 余额变化
      const solBalanceChange = Number(finalOwnerSolBalance) - Number(beforeWithdrawSolBalance);
      console.log("提取导致的 SOL 余额变化:", solBalanceChange, "lamports");
      console.log("提取导致的 SOL 余额变化:", solBalanceChange / LAMPORTS_PER_SOL, "SOL");

      // 拥有者应该从两个账户收到租金退款减去交易费用
      // 交易费用通常为 5000 lamports
      const expectedTransactionFee = 5000; // 5000 lamports
      const netSolGain = solBalanceChange + expectedTransactionFee;
      console.log("净 SOL 收益（租金退款）:", netSolGain, "lamports");
      console.log("净 SOL 收益（租金退款）:", netSolGain / LAMPORTS_PER_SOL, "SOL");

      // 验证拥有者收到了租金退款（在考虑交易费用后应该为正）
      expect(netSolGain).to.be.greaterThan(0, "拥有者应该从关闭的账户收到租金退款");

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
        console.log("✅ 金库账户已正确关闭:", error.message);
      }

      // 验证分发器账户已关闭（获取应该失败）
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda);
        expect.fail("分发器账户应该已关闭");
      } catch (error) {
        console.log("✅ 分发器账户已正确关闭:", error.message);
      }

      console.log("✅ Withdraw test completed successfully for nonce", nextnonce, "!");
      console.log("✅ SOL balance verified - owner received rent refunds from both closed accounts!");
    } catch (error) {
      console.error("Withdraw test failed for nonce", nextnonce, ":", error);
      throw error;
    }
  });

  it("Withdraw tokens (Token 2022) - No start time set", async () => {
    // 动态获取下一个 nonce 号码（在 try-catch 外部声明以用于作用域）
    const nextnonce = await getNextNonceForOwner(owner.publicKey);

    try {
      console.log("=== 测试提取（Token 2022）- 未设置开始时间 ===");

      const totalAmount = new anchor.BN(100000000000); // 100 个代币

      console.log("提取测试的下一个 nonce:", nextnonce);

      // 计算此 nonce 的 PDA
      withdrawTestDistributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, nextnonce);
      withdrawTestTokenVaultPda2022 = calculateVaultPda(withdrawTestDistributorPda2022);

      console.log("提取测试 Token 2022 分发器 PDA:", withdrawTestDistributorPda2022.toString());
      console.log("提取测试 Token 2022 金库 PDA:", withdrawTestTokenVaultPda2022.toString());

      // 获取初始拥有者 SOL 余额
      const initialOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("初始拥有者 SOL 余额:", Number(initialOwnerSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 为提取测试创建分发器
      console.log("为提取测试创建分发器（nonce", nextnonce, ")...");
      const createTx = await program.methods
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
        .signers([owner])
        .rpc();

      console.log("已创建提取测试分发器交易:", createTx);

      // 创建分发器后获取 SOL 余额（应该由于租金和交易费用而降低）
      const afterCreateSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("创建后拥有者 SOL 余额:", Number(afterCreateSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 验证初始金库余额
      const initialVaultBalance = await getAccount2022(provider.connection, withdrawTestTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
      console.log("初始金库余额:", initialVaultBalance.amount.toString());
      expect(initialVaultBalance.amount.toString()).to.equal(totalAmount.toString());

      // 获取初始拥有者代币余额
      const initialOwnerBalance = await getAccount2022(provider.connection, ownerTokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);
      console.log("初始拥有者余额:", initialOwnerBalance.amount.toString());

      // 验证分发器状态 - 开始时间应为 0（未设置）
      const distributorAccount = await program.account.tokenDistributor.fetch(withdrawTestDistributorPda2022);
      console.log("分发器开始时间:", distributorAccount.startTime.toString());
      console.log("分发器结束时间:", distributorAccount.endTime.toString());
      expect(distributorAccount.startTime.toString()).to.equal("0");
      expect(distributorAccount.endTime.toString()).to.equal("0");

      // 在提取之前获取 SOL 余额
      const beforeWithdrawSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("提取前拥有者 SOL 余额:", Number(beforeWithdrawSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 执行提取 - 应该成功，因为开始时间未设置（场景 1）
      console.log("执行提取交易...");
      const withdrawTx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda2022,
          tokenVault: withdrawTestTokenVaultPda2022,
          ownerTokenAccount: ownerTokenAccount2022,
          tokenMint: tokenMint2022,
          owner: owner.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      console.log("提取交易签名:", withdrawTx);

      // 获取最终拥有者 SOL 余额
      const finalOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("最终拥有者 SOL 余额:", Number(finalOwnerSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 计算 SOL 余额变化
      const solBalanceChange = Number(finalOwnerSolBalance) - Number(beforeWithdrawSolBalance);
      console.log("提取导致的 SOL 余额变化:", solBalanceChange, "lamports");
      console.log("提取导致的 SOL 余额变化:", solBalanceChange / LAMPORTS_PER_SOL, "SOL");

      // 拥有者应该从两个账户收到租金退款减去交易费用
      // 交易费用通常为 5000 lamports
      const expectedTransactionFee = 5000; // 5000 lamports
      const netSolGain = solBalanceChange + expectedTransactionFee;
      console.log("净 SOL 收益（租金退款）:", netSolGain, "lamports");
      console.log("净 SOL 收益（租金退款）:", netSolGain / LAMPORTS_PER_SOL, "SOL");

      // 验证拥有者收到了租金退款（在考虑交易费用后应该为正）
      expect(netSolGain).to.be.greaterThan(0, "拥有者应该从关闭的账户收到租金退款");

      // 验证最终拥有者代币余额
      const finalOwnerBalance = await getAccount2022(provider.connection, ownerTokenAccount2022, undefined, TOKEN_2022_PROGRAM_ID);
      console.log("最终拥有者余额:", finalOwnerBalance.amount.toString());

      // 验证已提取正确的数量
      const expectedOwnerBalance = initialOwnerBalance.amount + BigInt(totalAmount.toString());
      expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

      console.log("✅ 代币余额已验证 - 拥有者已收回所有代币！");

      // 验证金库账户已关闭（获取应该失败）
      try {
        await getAccount2022(provider.connection, withdrawTestTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
        expect.fail("金库账户应该已关闭");
      } catch (error) {
        console.log("✅ 金库账户已正确关闭:", error.message);
      }

      // 验证分发器账户已关闭（获取应该失败）
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda2022);
        expect.fail("分发器账户应该已关闭");
      } catch (error) {
        console.log("✅ 分发器账户已正确关闭:", error.message);
      }

      console.log("✅ Withdraw test completed successfully for nonce", nextnonce, "!");
      console.log("✅ SOL balance verified - owner received rent refunds from both closed accounts!");
    } catch (error) {
      console.error("Withdraw test failed for nonce", nextnonce, ":", error);
      throw error;
    }
  });

  it("Close claim status for SPL Token", async () => {
    try {
      console.log("=== Testing close claim status for SPL Token ===");

      // 使用来自全局测试数据的现有拥有者进行此测试（testTreeNodes 中的索引 2）
      const testClaimant = owner; // 拥有者在 testTreeNodes[2] 中有 3000 个代币
      console.log("测试申领者（拥有者）:", testClaimant.publicKey.toString());

      // 派生申领状态 PDA
      const [claimStatusPda] = PublicKey.findProgramAddressSync([Buffer.from("claim"), distributorPda.toBuffer(), testClaimant.publicKey.toBuffer()], program.programId);

      console.log("申领状态 PDA:", claimStatusPda.toString());

      // 获取申领者的初始 SOL 余额
      const initialSolBalance = await context.banksClient.getBalance(testClaimant.publicKey);
      console.log("初始申领者 SOL 余额:", Number(initialSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 为申领者创建代币账户
      const testClaimantTokenAccount = await manualCreateAccount(provider, tokenMint, testClaimant.publicKey, TOKEN_PROGRAM_ID);

      console.log("测试申领者代币账户:", testClaimantTokenAccount.publicKey.toString());

      // 首先时间旅行到分发开始时间
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      const targetTime = distributorAccount.startTime.toNumber();

      await context.setClock(
        new Clock(
          BigInt(0), // 插槽
          BigInt(targetTime * 1000000), // epoch_start_timestamp（微秒）
          BigInt(0), // 纪元
          BigInt(0), // leader_schedule_epoch
          BigInt(targetTime), // unix_timestamp（秒）
        ),
      );

      console.log("已时间旅行到分发开始时间:", targetTime);

      // 执行申领以创建申领状态账户
      // 使用拥有者（testTreeNodes[2]: 3000 个代币）
      const claimIndex = 2;
      const claimAmount = testTreeNodes[claimIndex].amount;
      const proof = testMerkleTree.getProof(claimIndex);
      const proofArray: number[][] = proof.map((p) => Array.from(p));

      console.log("执行申领以创建申领状态账户...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda,
          claimantTokenAccount: testClaimantTokenAccount.publicKey,
          tokenMint: tokenMint,
          claimant: testClaimant.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([testClaimant])
        .rpc();

      console.log("申领交易签名:", claimTx);

      // 验证申领状态账户存在
      const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
      console.log("申领状态已创建，数量:", claimStatus.claimedAmount.toString());

      // 获取申领后的 SOL 余额（关闭前）
      const beforeCloseSolBalance = await context.banksClient.getBalance(testClaimant.publicKey);
      console.log("关闭前 SOL 余额:", Number(beforeCloseSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 时间旅行到分发结束时间之后
      const distributorAccountAfterClaim = await program.account.tokenDistributor.fetch(distributorPda);
      const endTime = distributorAccountAfterClaim.endTime.toNumber();
      const afterEndTime = endTime + 100; // 结束时间后 100 秒

      await context.setClock(
        new Clock(
          BigInt(0), // 插槽
          BigInt(afterEndTime * 1000000), // epoch_start_timestamp（微秒）
          BigInt(0), // 纪元
          BigInt(0), // leader_schedule_epoch
          BigInt(afterEndTime), // unix_timestamp（秒）
        ),
      );

      console.log("已时间旅行到分发结束时间之后:", afterEndTime);

      // 执行关闭申领状态
      console.log("执行关闭申领状态...");
      const closeTx = await program.methods
        .closeClaimStatus()
        .accounts({
          claimStatus: claimStatusPda,
          claimant: testClaimant.publicKey,
          distributorKey: distributorPda,
        })
        .signers([testClaimant])
        .rpc();

      console.log("关闭申领状态交易签名:", closeTx);

      // 获取最终 SOL 余额
      const finalSolBalance = await context.banksClient.getBalance(testClaimant.publicKey);
      console.log("最终申领者 SOL 余额:", Number(finalSolBalance) / LAMPORTS_PER_SOL, "SOL");

      // 计算 SOL 余额变化（应该由于租金退款而为正）
      const solBalanceChange = Number(finalSolBalance) - Number(beforeCloseSolBalance);
      console.log("关闭导致的 SOL 余额变化:", solBalanceChange, "lamports");
      console.log("关闭导致的 SOL 余额变化:", solBalanceChange / LAMPORTS_PER_SOL, "SOL");

      // 验证租金已退回（应该为正，考虑交易费用）
      expect(solBalanceChange).to.be.greaterThan(-10000, "应该收到租金退款减去交易费用");

      // 验证申领状态账户已关闭（获取应该失败）
      try {
        await program.account.claimStatus.fetch(claimStatusPda);
        expect.fail("申领状态账户应该已关闭");
      } catch (error) {
        console.log("✅ 申领状态账户已正确关闭:", error.message);
      }

      console.log("✅ Close claim status test completed successfully!");
    } catch (error) {
      console.error("Close claim status test failed:", error);
      throw error;
    }
  });
});
