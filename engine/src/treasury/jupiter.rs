//! Jupiter V6 quote & swap client preferring low-CU AMMs (e.g. ZeroFi) for WSOL -> USDC sweeps.

use serde::{Deserialize, Serialize};

pub const WSOL_MINT_STR: &str = "So11111111111111111111111111111111111111112";
pub const USDC_MINT_STR: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const DEFAULT_JUPITER_V6_URL: &str = "https://quote-api.jup.ag/v6";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JupiterQuoteResponse {
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    pub slippage_bps: u16,
    #[serde(default)]
    pub route_plan: Vec<serde_json::Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JupiterSwapResponse {
    pub swap_transaction: String,
    #[serde(default)]
    pub last_valid_block_height: u64,
}

#[derive(Clone)]
pub struct JupiterV6Client {
    base_url: String,
    preferred_dexes: Vec<String>,
    http: reqwest::Client,
}

impl JupiterV6Client {
    pub fn new(base_url: impl Into<String>, preferred_dexes: Vec<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            preferred_dexes,
            http: reqwest::Client::new(),
        }
    }

    /// Builds the Jupiter V6 `/quote` URL, optionally restricting to low-CU AMMs (e.g. `ZeroFi`).
    pub fn build_quote_url(&self, amount_lamports: u64, slippage_bps: u16, use_preferred: bool) -> String {
        let mut url = format!(
            "{}/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}&onlyDirectRoutes=true",
            self.base_url, WSOL_MINT_STR, USDC_MINT_STR, amount_lamports, slippage_bps
        );
        if use_preferred && !self.preferred_dexes.is_empty() {
            url.push_str("&dexes=");
            url.push_str(&self.preferred_dexes.join(","));
        }
        url
    }

    /// Fetches a WSOL -> USDC quote, preferring low-CU AMMs (ZeroFi) with automatic fallback to open routing.
    pub async fn quote_wsol_to_usdc(
        &self,
        amount_lamports: u64,
        slippage_bps: u16,
    ) -> Result<(JupiterQuoteResponse, String), reqwest::Error> {
        if !self.preferred_dexes.is_empty() {
            let preferred_url = self.build_quote_url(amount_lamports, slippage_bps, true);
            if let Ok(resp) = self.http.get(&preferred_url).send().await {
                if let Ok(ok) = resp.error_for_status() {
                    if let Ok(quote) = ok.json::<JupiterQuoteResponse>().await {
                        let label = format!("Jupiter v6 → {}", self.preferred_dexes.join("/"));
                        return Ok((quote, label));
                    }
                }
            }
        }

        let fallback_url = self.build_quote_url(amount_lamports, slippage_bps, false);
        let quote: JupiterQuoteResponse = self
            .http
            .get(&fallback_url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok((quote, "Jupiter v6 → Best Route".to_string()))
    }

    /// Requests a serialized low-fee swap transaction from Jupiter V6 `/swap` (`wrapAndUnwrapSol = false`).
    pub async fn build_swap_tx(
        &self,
        quote: &JupiterQuoteResponse,
        user_pubkey: &str,
        max_priority_fee_lamports: u64,
    ) -> Result<JupiterSwapResponse, reqwest::Error> {
        let url = format!("{}/swap", self.base_url);
        let body = serde_json::json!({
            "quoteResponse": quote,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": false,
            "dynamicComputeUnitLimit": true,
            "prioritizationFeeLamports": max_priority_fee_lamports,
        });
        self.http
            .post(&url)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
    }
}
