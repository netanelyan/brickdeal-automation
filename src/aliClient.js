import crypto from 'node:crypto';

const REST_URL = 'https://api-sg.aliexpress.com/sync';
const REQUEST_TIMEOUT_MS = 15_000;

// Thin, dependency-free client for the AliExpress affiliate API.
// Signing scheme (verified against the current SG endpoint):
//   sort params by key, concat as `${key}${value}`, HMAC-SHA256 keyed by
//   the app secret, hex, uppercased.
export class AliClient {
  constructor({ appKey, appSecret, trackingId, appSignature = '' }) {
    if (!appKey || !appSecret || !trackingId) {
      throw new Error(
        'Missing credentials. Set ALI_APP_KEY, ALI_APP_SECRET and ALI_TRACKING_ID in your .env file.'
      );
    }
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.trackingId = trackingId;
    this.appSignature = appSignature; // optional label, not a secret
  }

  #sign(params) {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join('');
    return crypto.createHmac('sha256', this.appSecret).update(sorted).digest('hex').toUpperCase();
  }

  async call(businessParams) {
    const params = {
      app_key: this.appKey,
      timestamp: Date.now().toString(), // ms epoch for the /sync endpoint
      sign_method: 'sha256',
      ...businessParams,
    };
    // Sign over the RAW values, then send url-encoded.
    params.sign = this.#sign(params);
    const url = `${REST_URL}?${new URLSearchParams(params).toString()}`;

    // No timeout here previously — a hung request just hung, indistinguishable
    // from every other failure once it eventually threw or never resolved.
    // Callers (engine.js) need to tell "AliExpress is slow/unreachable right
    // now" apart from "AliExpress said no to this specific product".
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { method: 'GET', signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error(`AliExpress request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        err.code = 'TIMEOUT';
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`AliExpress HTTP ${res.status}`);
    const json = await res.json();

    // Surface gateway-level errors (bad sign, throttling, permissions, etc.)
    const err = json?.error_response;
    if (err) {
      if (String(err.code).includes('ApiCallLimit')) {
        await new Promise((r) => setTimeout(r, 2000));
        return this.call(businessParams);
      }
      throw new Error(`AliExpress API error ${err.code}: ${err.sub_msg || err.msg || 'unknown'}`);
    }
    return json;
  }

  productDetail(ids, { targetCurrency = 'USD', targetLanguage = 'EN', country = 'US', fields = '' } = {}) {
    return this.call({
      method: 'aliexpress.affiliate.productdetail.get',
      app_signature: this.appSignature,
      tracking_id: this.trackingId,
      product_ids: ids.join(','),
      target_currency: targetCurrency,
      target_language: targetLanguage,
      country,
      fields,
    });
  }

  generateLinks(urls, { promotionLinkType = '0' } = {}) {
    return this.call({
      method: 'aliexpress.affiliate.link.generate',
      app_signature: this.appSignature,
      tracking_id: this.trackingId,
      promotion_link_type: promotionLinkType,
      source_values: urls.join(','),
    });
  }

  // For later: auto-discovering brick deals instead of only reposting.
  hotProducts(options = {}) {
    return this.call({
      method: 'aliexpress.affiliate.hotproduct.query',
      app_signature: this.appSignature,
      tracking_id: this.trackingId,
      target_currency: 'USD',
      target_language: 'EN',
      ship_to_country: 'US',
      page_no: '1',
      page_size: '20',
      ...Object.fromEntries(Object.entries(options).map(([k, v]) => [k, String(v)])),
    });
  }
}
