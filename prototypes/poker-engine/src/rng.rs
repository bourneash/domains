//! Deterministic PRNG. Deterministic on purpose: benchmarks must be reproducible
//! across native and wasm so the two numbers are comparable.

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }

    #[inline(always)]
    pub fn next_u64(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in [0, n) via Lemire's multiply-shift. Bias is negligible for our n (< 64).
    #[inline(always)]
    pub fn below(&mut self, n: u32) -> u32 {
        (((self.next_u64() >> 32) as u64 * n as u64) >> 32) as u32
    }
}
