// Copyright (c) LightPool Labs
// Author: xiaoyu1998

//! Off-chain keepers for LightPool paper markets.
//!
//! Interact with chain only through `lightpool-clob-indexer` HTTP/WS (same pattern as
//! paper-bootstrap / strategy BFF): list state → sign action → `POST /api/tx/submit`.
//!
//! - **liqd**: snapshot + `paper.positions` / `oracle` WS; price ticks drive bust checks
//! - **harvest**: pay FIFO queue when LP has cash
//! - **push_fees**: distribute fee accruals / LP sweep into staking

pub mod config;
pub mod harvest;
pub mod indexer;
pub mod liqd;
pub mod push_fees;
pub mod ws;

pub use config::KeeperConfig;
