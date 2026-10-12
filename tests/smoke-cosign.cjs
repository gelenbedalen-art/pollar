// @pollar smoke test: Turnkey co-signed wallets from the client's side.
//
// Run with `node tests/smoke-cosign.cjs` after the build. Mocks `fetch`,
// `window` and `localStorage`, so no network is needed. Covers: the device key
// lives apart from the DPoP key and survives a logout; the X-Stamp a device
// produces verifies as a DER ECDSA signature; the Stellar transaction hash is
// recomputed from the envelope without a parser (unsigned and sponsor-signed);
// a 202 SDK_COSIGN_PENDING becomes a cosign_pending outcome and an
// awaiting_cosign tx state; approve verifies against Turnkey, relays the vote
// and moves the tx state to the submit outcome; a relay stamped by an
// unexpected key, or a payload Turnkey disagrees with, is refused.

const path = require('node:path');
const crypto = require('node:crypto');

globalThis.window = {
  location: { origin: 'https://x.test', href: 'https://x.test/' },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const sdk = require(path.resolve(__dirname, '../packages/core/dist/index.js'));
const rn = require(path.resolve(__dirname, '../packages/core/dist/index.rn.js'));

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) {
    pass++;
    console.log(`  OK    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`, extra ?? '');
  }
}

// A testnet payment from SOURCE, as `@stellar/stellar-sdk` builds it, with and
// without the sponsor's signature, and the hash the account signs.
const SOURCE = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const UNSIGNED_XDR =
  'AAAAAgAAAADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLAAAAGQAAAAAAAAwOgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAD9FyQ4WqDHW2T7eM1gL6HZkf3r92sTxY7XAurINen2GAAAAAAAAAAAAOThwAAAAAAAAAAA';
const ONE_SIG_XDR =
  'AAAAAgAAAADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLAAAAGQAAAAAAAAwOgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAD9FyQ4WqDHW2T7eM1gL6HZkf3r92sTxY7XAurINen2GAAAAAAAAAAAAOThwAAAAAAAAAABNen2GAAAAED7r9F6PCr/GYCllw0ozw6NFfLDR6ppk+EdM/kcVomZvly6pX4RjkQvkfZj2kwIqFk+19LQ53n9ptmo/yk6ojAH';
const HASH = 'e4cc94b9663d79110f5478a7c19703d6507f5d8b08cfe6c11f0e698524151355';
const TESTNET = 'Test SDF Network ; September 2015';

function request(overrides = {}) {
  return {
    id: 'req-1',
    kind: 'TX',
    network: 'STELLAR',
    status: 'PENDING',
    subOrgId: 'sub-org-1',
    activityId: 'act-1',
    fingerprint: 'fp-1',
    signWith: SOURCE,
    unsignedPayload: UNSIGNED_XDR,
    payloadHash: HASH,
    intent: 'sign_and_send',
    refreshable: false,
    operation: 'payment',
    summary: 'Send 1.5 XLM',
    details: { amount: '1.5', destination: 'GD6RO...' },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  };
}

(async () => {
  // 1. Pure helpers.
  check('stellarTransactionHashHex: unsigned envelope', (await sdk.stellarTransactionHashHex(UNSIGNED_XDR, TESTNET)) === HASH);
  check(
    'stellarTransactionHashHex: envelope with one signature',
    (await sdk.stellarTransactionHashHex(ONE_SIG_XDR, TESTNET)) === HASH,
  );
  check(
    'stellarTransactionHashHex: another network gives another hash',
    (await sdk.stellarTransactionHashHex(UNSIGNED_XDR, 'Public Global Stellar Network ; September 2015')) !== HASH,
  );

  // 2. Device key: its own namespace, survives the DPoP reset of a logout.
  const storage = rn.createMemoryAdapter();
  const dpop = new rn.NobleKeyManager(storage, 'pk_smoke_cosign');
  const device = new rn.NobleKeyManager(storage, 'pk_smoke_cosign', { namespace: 'cosign' });
  await dpop.init();
  await device.init();
  const deviceJwk = await device.getPublicJwk();
  check('device key differs from the DPoP key', (await dpop.getThumbprint()) !== (await device.getThumbprint()));
  await dpop.reset();
  const deviceAgain = new rn.NobleKeyManager(storage, 'pk_smoke_cosign', { namespace: 'cosign' });
  await deviceAgain.init();
  check('device key survives the DPoP reset', (await deviceAgain.getThumbprint()) === (await device.getThumbprint()));

  // 3. Stamp: compressed public key + DER signature that node verifies.
  const publicKeyHex = sdk.compressedPublicKeyHex(deviceJwk);
  check('compressed public key is 33 bytes with a 02/03 prefix', /^0[23][0-9a-f]{64}$/.test(publicKeyHex));
  const body = JSON.stringify({
    organizationId: 'sub-org-1',
    type: 'ACTIVITY_TYPE_APPROVE_ACTIVITY',
    parameters: { fingerprint: 'fp-1' },
  });
  const raw = await device.sign(new TextEncoder().encode(body));
  const der = sdk.rawSignatureToDer(raw);
  const keyObject = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: deviceJwk.x, y: deviceJwk.y }, format: 'jwk' });
  check(
    'raw r||s converts to a DER signature node verifies',
    crypto.verify('sha256', Buffer.from(body), { key: keyObject, dsaEncoding: 'der' }, Buffer.from(der)),
  );
  const stamp = JSON.parse(
    Buffer.from(
      sdk.encodeStamp({
        publicKey: publicKeyHex,
        scheme: 'SIGNATURE_SCHEME_TK_API_P256',
        signature: Buffer.from(der).toString('hex'),
      }),
      'base64url',
    ).toString(),
  );
  check(
    'encodeStamp is base64url JSON with publicKey, scheme and signature',
    stamp.publicKey === publicKeyHex && stamp.scheme === 'SIGNATURE_SCHEME_TK_API_P256' && typeof stamp.signature === 'string',
  );

  // 4. The client against a mocked sdk-api.
  const apiKey = 'pk_smoke_cosign_client';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  const apiKeyHash = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const clientStorage = sdk.createMemoryAdapter();
  await clientStorage.set(
    `pollar:${apiKeyHash}:session`,
    JSON.stringify({
      clientSessionId: 'cs',
      userId: 'u',
      status: 'CONSUMED',
      token: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Math.floor(Date.now() / 1000) + 600 },
      user: { ready: true },
      wallet: { type: 'internal', provider: 'email', address: SOURCE, chain: 'STELLAR', provisioning: 'READY' },
      wallets: [{ type: 'internal', provider: 'email', address: SOURCE, chain: 'STELLAR' }],
      data: {
        mail: 'u@x.test',
        first_name: '',
        last_name: '',
        avatar: '',
        providers: { email: { address: 'u@x.test' }, google: null, github: null, wallet: null },
      },
    }),
  );

  const calls = [];
  let relayStampPublicKey = null;
  let turnkeyPayload = HASH;
  // What Turnkey "holds" for the other kinds the device verifies.
  const SOLANA_FROM = 'HUwbU1P7nxJvACyYMYChUCUZ1tCQqCyjWeT27gPYYSaU';
  const SOLANA_UNSIGNED = 'ab'.repeat(40);
  let turnkeySolanaTx = SOLANA_UNSIGNED;
  const ACCOUNT_PAYLOAD = {
    walletId: 'wallet-tk',
    accounts: [
      {
        curve: 'CURVE_ED25519',
        pathFormat: 'PATH_FORMAT_BIP32',
        path: "m/44'/501'/0'/0'",
        addressFormat: 'ADDRESS_FORMAT_SOLANA',
        name: 'SOLANA',
      },
    ],
  };
  let turnkeyAccounts = ACCOUNT_PAYLOAD;
  let refreshCalls = 0;
  let refreshedRequest = null;
  let approvedRequest = request({
    status: 'APPROVED',
    signedXdr: ONE_SIG_XDR,
    submit: { hash: 'abc123', status: 'SUCCESS' },
    resolvedAt: new Date().toISOString(),
  });

  globalThis.fetch = async (req) => {
    const url = new URL(req.url);
    const method = req.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/v2/auth/session/resume')
      return json(200, {
        success: true,
        code: 'SDK_SESSION_RESUMED',
        content: {
          mail: 'u@x.test',
          first_name: '',
          last_name: '',
          avatar: '',
          providers: { email: { address: 'u@x.test' }, google: null, github: null, wallet: null },
        },
      });
    if (url.pathname === '/v2/tx/sign') {
      return json(202, {
        success: true,
        code: 'SDK_COSIGN_PENDING',
        content: { pendingSignature: { kind: 'cosign', request: request({ intent: 'sign' }) } },
      });
    }
    if (url.pathname === '/v2/tx/sign-and-send') {
      return json(202, {
        success: true,
        code: 'SDK_COSIGN_PENDING',
        content: { pendingSignature: { kind: 'cosign', request: request() } },
      });
    }
    if (url.pathname === '/v2/cosign/requests')
      return json(200, { success: true, code: 'SDK_COSIGN_REQUEST', content: { requests: [request()] } });
    if (url.pathname === '/v2/cosign/requests/req-1/refresh') {
      refreshCalls++;
      return json(200, { success: true, code: 'SDK_COSIGN_REQUEST', content: { request: refreshedRequest ?? request() } });
    }
    if (url.pathname === '/v2/cosign/relay') {
      const body = JSON.parse(await req.text());
      const stampJson = JSON.parse(Buffer.from(body.stamp, 'base64url').toString());
      relayStampPublicKey = stampJson.publicKey;
      const inner = JSON.parse(body.body);
      if (body.path === '/public/v1/query/get_activity') {
        const intent =
          inner.activityId === 'act-sol'
            ? {
                signTransactionIntentV2: {
                  signWith: SOLANA_FROM,
                  unsignedTransaction: turnkeySolanaTx,
                  type: 'TRANSACTION_TYPE_SOLANA',
                },
              }
            : inner.activityId === 'act-acc'
              ? { createWalletAccountsIntent: turnkeyAccounts }
              : { signRawPayloadIntentV2: { signWith: SOURCE, payload: turnkeyPayload } };
        return json(200, {
          success: true,
          code: 'SDK_COSIGN_REQUEST',
          content: { status: 200, body: { activity: { id: inner.activityId, intent } } },
        });
      }
      if (body.path === '/public/v1/submit/approve_activity') {
        return json(200, {
          success: true,
          code: 'SDK_COSIGN_APPROVED',
          content: { status: 200, body: {}, request: approvedRequest },
        });
      }
      return json(400, { success: false, code: 'VALIDATION_ERROR' });
    }
    return json(404, { success: false, code: 'NOT_FOUND', path: url.pathname });
  };

  const client = new sdk.PollarClient({
    apiKey,
    storage: clientStorage,
    baseUrl: 'https://x.test',
    stellarNetwork: 'testnet',
    logLevel: 'silent',
  });
  await client.ready();
  check('session restored with a wallet', client.getWallet()?.address === SOURCE);

  const txStates = [];
  client.onTransactionStateChange((s) => txStates.push(s.step));
  const cosignStates = [];
  client.onCosignStateChange((s) => cosignStates.push(s.pending.length));

  const signOutcome = await client.signTx(UNSIGNED_XDR);
  check(
    'signTx answers cosign_pending with the request',
    signOutcome.status === 'cosign_pending' && signOutcome.request.id === 'req-1',
  );
  check('tx state is awaiting_cosign', txStates.includes('awaiting_cosign'));
  check('cosign store lists the pending request', client.getCosignState().pending.length === 1);

  const sendOutcome = await client.signAndSubmitTx(UNSIGNED_XDR);
  check('signAndSubmitTx answers cosign_pending too', sendOutcome.status === 'cosign_pending');

  const verification = await client.cosign.verify(request());
  check(
    'verify: local hash equals Pollar hash and Turnkey payload',
    verification.ok === true && verification.localHash === HASH,
    verification,
  );
  check(
    'verify read the activity through the relay',
    calls.some((c) => c === 'POST /v2/cosign/relay'),
  );
  const deviceKeyHex = await client.cosign.publicKeyHex();
  check('relay stamped with the device key', relayStampPublicKey === deviceKeyHex);

  const tampered = await client.cosign.verify(request({ payloadHash: '00'.repeat(32) }));
  check('verify refuses a request whose hash does not match the transaction', tampered.ok === false);
  turnkeyPayload = 'ff'.repeat(32);
  const turnkeyDisagrees = await client.cosign.verify(request());
  check(
    'verify refuses when Turnkey holds a different payload',
    turnkeyDisagrees.ok === false && /Turnkey/.test(turnkeyDisagrees.reason),
  );
  turnkeyPayload = HASH;

  let threw = null;
  try {
    await client.cosign.approve(request({ payloadHash: '00'.repeat(32) }));
  } catch (err) {
    threw = err;
  }
  check(
    'approve throws SDK_COSIGN_VERIFICATION_FAILED instead of voting on a mismatch',
    threw && threw.code === 'SDK_COSIGN_VERIFICATION_FAILED',
  );
  check('no approve_activity was relayed for the mismatch', !calls.includes('approve'));

  const approved = await client.cosign.approve(request());
  check(
    'approve relays the vote and returns the resolved request',
    approved.status === 'APPROVED' && approved.submit?.hash === 'abc123',
  );
  check('tx state reached success from the approved submit', txStates[txStates.length - 1] === 'success');
  check(
    'cosign store dropped the resolved request',
    client.getCosignState().pending.length === 0 && client.getCosignState().lastResolved?.id === 'req-1',
  );

  // Refresh: a request Pollar composed is rebuilt right before the vote; one the
  // client composed is not.
  check('approve did not refresh a request the client composed', refreshCalls === 0);
  refreshedRequest = request({ refreshable: true, activityId: 'act-2', fingerprint: 'fp-2' });
  await client.signAndSubmitTx(UNSIGNED_XDR);
  const approvedAfterRefresh = await client.cosign.approve(request({ refreshable: true }));
  check('approve refreshes a refreshable request first', refreshCalls === 1);
  check('approve then verified and voted on the refreshed activity', approvedAfterRefresh.status === 'APPROVED');
  refreshedRequest = null;

  // Solana: the device compares the serialized unsigned transaction with the intent.
  const solanaRequest = request({
    id: 'req-sol',
    network: 'SOLANA',
    activityId: 'act-sol',
    fingerprint: 'fp-sol',
    signWith: SOLANA_FROM,
    unsignedPayload: SOLANA_UNSIGNED,
    payloadHash: crypto.createHash('sha256').update(SOLANA_UNSIGNED).digest('hex'),
    refreshable: true,
  });
  const solanaOk = await client.cosign.verify(solanaRequest);
  check(
    'verify accepts a Solana request whose unsigned transaction Turnkey holds byte for byte',
    solanaOk.ok === true,
    solanaOk,
  );
  turnkeySolanaTx = 'cd'.repeat(40);
  const solanaBad = await client.cosign.verify(solanaRequest);
  check('verify refuses a Solana request when Turnkey holds another transaction', solanaBad.ok === false);
  turnkeySolanaTx = SOLANA_UNSIGNED;
  const solanaWrongSigner = await client.cosign.verify({
    ...solanaRequest,
    signWith: 'SomeoneElse111111111111111111111111111111111',
  });
  check('verify refuses a Solana request Turnkey would sign with another account', solanaWrongSigner.ok === false);

  // ACCOUNT: the device compares wallet id and derivation parameters.
  const accountRequest = request({
    id: 'req-acc',
    kind: 'ACCOUNT',
    network: 'SOLANA',
    intent: 'add_accounts',
    activityId: 'act-acc',
    fingerprint: 'fp-acc',
    signWith: 'wallet-tk',
    unsignedPayload: JSON.stringify(ACCOUNT_PAYLOAD),
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(ACCOUNT_PAYLOAD)).digest('hex'),
    refreshable: true,
  });
  const accountOk = await client.cosign.verify(accountRequest);
  check('verify accepts an account derivation whose parameters match the intent', accountOk.ok === true, accountOk);
  turnkeyAccounts = { ...ACCOUNT_PAYLOAD, accounts: [{ ...ACCOUNT_PAYLOAD.accounts[0], path: "m/44'/501'/1'/0'" }] };
  const accountBad = await client.cosign.verify(accountRequest);
  check('verify refuses an account derivation with a different path', accountBad.ok === false);
  turnkeyAccounts = ACCOUNT_PAYLOAD;

  // A rejected vote ends the tx with an error state.
  approvedRequest = request({ status: 'REJECTED', failureReason: 'user said no', resolvedAt: new Date().toISOString() });
  await client.signAndSubmitTx(UNSIGNED_XDR);
  await client.cosign.approve(request(), { verify: false });
  check('a rejected request moves the tx state to error', txStates[txStates.length - 1] === 'error');

  client.destroy();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
