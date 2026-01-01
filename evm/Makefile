# include .env file and export its env vars
# (-include to ignore error if it does not exist)
-include .env

# 加--via-ir：优化代码更高效并且减少编译文件大小
build:
	forge build --via-ir --sizes

# 执行所有测试用例
test:
	forge test -vvv --via-ir --gas-report

# 执行特定测试用例,vvv最多5个v越多报错显示调用栈越详细
ts:
	forge test --match-path tests/PendleV2Adapter.t.sol  --match-test test_Locked -vvv 

# 部署 DeFiRouter + AaveV3Adapter
deploy-aave-v3:
	forge clean && \
	forge build && \
	forge script scripts/DeployAaveV3.s.sol:DeployAaveV3 \
	    --rpc-url $(ETH_MAINNET_RPC) \
		--ffi \
		--slow \
	    --broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY)

upgrade-aave-v3:
	forge clean && \
	forge build && \
	forge script scripts/UpgradeSample.s.sol:UpgradeSample \
	    --rpc-url $(ETH_MAINNET_RPC) \
		--ffi \
		--slow \
	    --broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY)

run-deploy-ethena:
	forge clean && \
	forge build && \
	forge script scripts/DeployEthena.s.sol:DeployEthena \
	    --rpc-url $(ETH_MAINNET_RPC) \
		--ffi \
		--slow \
	    --broadcast \
		--verify \
		--etherscan-api-key $(ETHERSCAN_API_KEY)

# YT池利息和奖励
onchain-call:
	cast call \
      0x0D572721d36f672a5391a9907a063904a9252efC \
      "redeemDueInterestAndRewards(address,bool,bool)(uint256,uint256[])" \
      0xDb4EFc647A72Ed5Fb03C20143b85657DaFB6a039 \
      true \
      true \
      --rpc-url $(ETH_MAINNET_RPC)

# 流动池奖励代币地址
onchain-call1:
	cast call \
      0x307c15f808914df5a5dbe17e5608f84953ffa023 \
      "getRewardTokens()(address[])" \
      --rpc-url $(ETH_MAINNET_RPC)  \
      true \
      true \
      --rpc-url $(ETH_MAINNET_RPC)

# 流动池奖励代币对应数量
onchain-call2:
	cast call \
      0x307c15f808914df5a5dbe17e5608f84953ffa023 \
      "redeemRewards(address)(uint256[])" \
      0x6910c590d8503a1f3ef5ea9b64a5d7c7f3b5feda \
      --rpc-url $(ETH_MAINNET_RPC)

onchain-call3:
	cast call \
      0x6D520a943a4Da0784917a2e71defe95248A1DaA1 \
      "claimRewards(address)(uint256[])" \
      0xbe8Dac0A6446A2e7d31F96d0218DcDDfbce65bF4 \
      --rpc-url $(ETH_MAINNET_RPC)

onchain-call4:
	cast call \
      0x3eaf6c8425b40c554099beed4dcb9f4601942fcb \
      "totalSupply()(uint256)" \
      --rpc-url $(ETH_MAINNET_RPC)

# 格式化代码
fmt:
	forge fmt

# Hardhat编译合约
hardhat-compile:
	npx hardhat compile

hdeploy:
	npx hardhat run --build-profile default scripts/deployAndVerify.ts --network blastSepolia
