use anchor_lang::solana_program::hash::hashv;

/// 默克尔证明验证
/// 修改自 https://github.com/saber-hq/merkle-distributor/blob/ac937d1901033ecb7fa3b0db22f7b39569c8e052/programs/merkle-distributor/src/merkle_proof.rs#L8
/// 此函数处理默克尔树（哈希树）的验证。
/// 直接移植自 https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v3.4.0/contracts/cryptography/MerkleProof.sol
/// 如果 `leaf` 可以被证明是 `root` 定义的默克尔树的一部分，则返回 true。
/// 为此，必须提供 `proof`，包含从叶子到树根的分支上的兄弟哈希。
/// 假设每对叶子和每对原像都已排序。
pub fn verify(proof: Vec<[u8; 32]>, root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed_hash = leaf;
    for proof_element in proof.into_iter() {
        if computed_hash <= proof_element {
            // 哈希（当前计算的哈希 + 证明的当前元素）
            computed_hash = hashv(&[&computed_hash, &proof_element]).to_bytes();
        } else {
            // 哈希（证明的当前元素 + 当前计算的哈希）
            computed_hash = hashv(&[&proof_element, &computed_hash]).to_bytes();
        }
    }
    // 检查计算的哈希（根）是否等于提供的根
    computed_hash == root
}
