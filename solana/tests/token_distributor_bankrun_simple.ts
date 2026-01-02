import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { startAnchor, Clock, ProgramTestContext } from "solana-bankrun";

describe("bankrun 时间控制演示", () => {
  let context: ProgramTestContext;

  before(async () => {
    // 启动 bankrun 上下文
    context = await startAnchor("./", [], []);
    console.log("Bankrun 上下文启动成功");
  });

  it("基本时钟控制演示", async () => {
    try {
      console.log("=== 基本时钟控制演示 ===");

      // 获取初始时钟
      const initialClock = await context.banksClient.getClock();
      console.log("初始时间:", Number(initialClock.unixTimestamp));

      // 将时间推进 100 秒
      const newClock = new Clock(
        initialClock.slot,
        initialClock.epochStartTimestamp,
        initialClock.epoch,
        initialClock.leaderScheduleEpoch,
        BigInt(Number(initialClock.unixTimestamp) + 100),
      );

      await context.setClock(newClock);

      // 验证时间已推进
      const updatedClock = await context.banksClient.getClock();
      console.log("更新时间:", Number(updatedClock.unixTimestamp));
      console.log("时间差:", Number(updatedClock.unixTimestamp) - Number(initialClock.unixTimestamp), "秒");

      expect(Number(updatedClock.unixTimestamp)).to.equal(Number(initialClock.unixTimestamp) + 100);

      console.log("✅ 基本时钟控制测试通过！");
    } catch (error) {
      console.error("基本时钟控制测试失败:", error);
      throw error;
    }
  });

  it("演示 setTimeout 替换", async () => {
    try {
      console.log("=== 演示 setTimeout 替换 ===");

      // 获取当前时钟
      const currentClock = await context.banksClient.getClock();
      console.log("当前时间:", Number(currentClock.unixTimestamp));

      // 旧方式（已注释以避免实际等待）：
      // console.log("🕐 旧方式: await new Promise(resolve => setTimeout(resolve, 12000));");
      // await new Promise(resolve => setTimeout(resolve, 12000)); // 等待 12 秒

      // 新方式：立即推进时间
      console.log("🕐 旧方式将是: await new Promise(resolve => setTimeout(resolve, 12000));");
      console.log("⚡ 新方式：使用 bankrun 立即推进时间！");

      const startTime = Date.now();

      // 将时钟推进 12 秒
      const newClock = new Clock(
        currentClock.slot,
        currentClock.epochStartTimestamp,
        currentClock.epoch,
        currentClock.leaderScheduleEpoch,
        BigInt(Number(currentClock.unixTimestamp) + 12),
      );

      await context.setClock(newClock);

      const endTime = Date.now();
      const actualTimeSpent = endTime - startTime;

      // 验证时间已推进
      const updatedClock = await context.banksClient.getClock();
      const blockchainTimeAdvanced = Number(updatedClock.unixTimestamp) - Number(currentClock.unixTimestamp);

      console.log(`✅ 区块链时间推进: ${blockchainTimeAdvanced} 秒`);
      console.log(`✅ 实际花费时间: ${actualTimeSpent}ms（而不是 12000ms）`);
      console.log(`🚀 速度提升: ${Math.round(12000 / actualTimeSpent)}x 更快！`);

      expect(blockchainTimeAdvanced).to.equal(12);
      expect(actualTimeSpent).to.be.lessThan(1000); // 应该远少于 1 秒

      console.log("✅ setTimeout 替换演示完成！");
    } catch (error) {
      console.error("setTimeout 替换测试失败:", error);
      throw error;
    }
  });
});
