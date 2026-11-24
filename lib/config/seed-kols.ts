// Curated KOL & Whale Watchlist extracted from Fhbh1D mainnet execution telemetry.
// Tier-1 SOL KOLs are enabled by default (12 wallets, staying well within Solana RPC WS subscription limits);
// secondary rotating whales & SPL/BONK traders are pre-seeded and toggleable in /watchlist.
import type { Kol } from '../types';

const emptyStats = () => ({ wins: 0, losses: 0, realizedSol: 0, lastSeenSlot: null });

export const DEFAULT_KOLS: Kol[] = [
  // (A) Tier-1 & Active Native SOL KOL / Whale Wallets (enabled by default, -0.02 SOL guard)
  { id: 'kol_cented', label: 'Cented', pubkey: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 1.5, maxCurveReserveSol: 34, enabled: true, stats: emptyStats() },
  { id: 'kol_decu', label: 'Decu', pubkey: '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 1.5, maxCurveReserveSol: 34, enabled: true, stats: emptyStats() },
  { id: 'kol_theo', label: 'Theo', pubkey: 'Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 1.5, maxCurveReserveSol: 34, enabled: true, stats: emptyStats() },
  { id: 'kol_megawhale', label: 'Mega-Whale (4.5k SOL)', pubkey: '6DQAGJT7VZPVBsuG4kn3AvpyHCEi7B2RFFvMZdbqQqqP', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 1.5, maxCurveReserveSol: 34, enabled: true, stats: emptyStats() },
  { id: 'kol_whale5', label: 'Whale #5 (170 SOL)', pubkey: 'n62QUDHwXWCnZyArC9KsP3PqeBzf7WwAMqRLtwUgR7z', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.5, maxCurveReserveSol: 32, enabled: true, stats: emptyStats() },
  { id: 'kol_awakewhale', label: 'awakewhale85103', pubkey: '3P6etC8pn8ofp9uVE12kEqwd79KaWBNwHCYNTn4cn4Hp', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.5, maxCurveReserveSol: 32, enabled: true, stats: emptyStats() },
  { id: 'kol_whale7', label: 'Whale #7 (70 SOL)', pubkey: '5SvCHLjqNHujsxLdQLFUVU5wMKD3rSZZminJ6i1uf9in', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.5, maxCurveReserveSol: 32, enabled: true, stats: emptyStats() },
  { id: 'kol_trader8', label: 'Trader #8', pubkey: '6yVb4pxNwDfr6rovwNnBg3SyKSvDcHGD4WdFPN1JJBqm', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: true, stats: emptyStats() },
  { id: 'kol_trader9', label: 'Trader #9', pubkey: '4aqbmsGquWED6EmFk6qHAiTYgpkJG83U3Rb9tsduPwYA', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: true, stats: emptyStats() },
  { id: 'kol_trader10', label: 'Trader #10', pubkey: '9FFuJsPFvdj2QHuFi2LTBcMvjJgMUsyNZrg6g7EQ3Jz9', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: true, stats: emptyStats() },
  { id: 'kol_trader11', label: 'Trader #11', pubkey: 'G4L2DgwDwVQAj5sWaUSSiixuPT7J1KRhEYB7uGTvfhey', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: true, stats: emptyStats() },
  { id: 'kol_risk100x', label: 'Risk100x', pubkey: 'BHREKFkPQgAtDs8Vb1UfLkUpjG6ScidTjHaCWFuG2AtX', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: true, stats: emptyStats() },

  // (B) Secondary / Rotating Native SOL Wallets (pre-seeded, toggle ON in /watchlist when using paid RPC/ShredStream)
  { id: 'kol_rot13', label: 'Rotating #13', pubkey: 'AvaLiiULyejM37VHka5zj3wLb2MTqdw1PNs9zG9fjWxd', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot14', label: 'Rotating #14', pubkey: 'Hh5UZ7w1f3iPAusQKFHumeMdoHfY4EnpP6Pqa91eRUZN', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot15', label: 'Rotating #15', pubkey: 'Ght2Cwt77ujDJhjGZEqeUAnAvjmzi2wtVWT7pBhg6geG', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot16', label: 'Rotating #16', pubkey: 'FzkTYgm57FmtJEtKoDN7MxCnM7bpBiUwnoxhx6ixvuSd', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot17', label: 'Rotating #17', pubkey: 'DYRKgs9yR2RMdQZSwmvbew9NjZ7vKdNUs5uRAAfH2UX5', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot18', label: 'Rotating #18', pubkey: '88UFDM23qLHKUxtVE2n8nqtBDVpBR9qzawh84xm3cDAi', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot19', label: 'Rotating #19', pubkey: '4vd22XuAmBxfb7ypHKWUjPk9FLvkMh3kiEs5wzpJkfdD', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot20', label: 'Rotating #20', pubkey: '4TiMpVGK5u6hwVxTSen1FpSP8GWMeavg9hcophoHNAmY', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot21', label: 'Rotating #21', pubkey: '2saR5ZEhkkziTYwYAYDQ4bHnuZiXWzRMsWF587zFiykz', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_rot22', label: 'Rotating #22', pubkey: '2L2busDttPccaPEqfXfJN5N6kYaQKQLDf9eHGsFpKiP8', quote: 'SOL', triggerMargin: 0.02, buySizeSol: 0.3, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },

  // (C) Top SPL / Quote-Asset Traders (USDC / WSOL / BONK)
  { id: 'kol_spl_usdc1', label: 'USDC Trader #1', pubkey: '9z332Pxs4xaz7CdE4sYPEHu9a9qrxcUTkbvMXVo1q1Q8', quote: 'USDC', triggerMargin: 5, buySizeSol: 0.25, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_spl_usdc2', label: 'USDC Trader #2', pubkey: 'DrJ6SnDXkEsPeGdmSs93v5rwWumv5QMvAGSZjAyWSd5o', quote: 'USDC', triggerMargin: 5, buySizeSol: 0.25, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_spl_wsol3', label: 'WSOL/BONK Trader #3', pubkey: '9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan', quote: 'WSOL', triggerMargin: 0.02, buySizeSol: 0.25, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_spl_bonk10', label: 'BONK LaunchLab #10', pubkey: 'AESwXGAo8eUfyJzbSVNAddo4PykdQrrLaDGcCdzWrLj3', quote: 'BONK', triggerMargin: 100000, buySizeSol: 0.25, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
  { id: 'kol_spl_bonk11', label: 'BONK LaunchLab #11', pubkey: '3fKF8cbyWKU56fpFkrQ1E6zJoAh4mqArdsPoUE6ycTKL', quote: 'BONK', triggerMargin: 100000, buySizeSol: 0.25, maxCurveReserveSol: 28, enabled: false, stats: emptyStats() },
];
