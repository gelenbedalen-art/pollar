import type { PollarApiClient } from '../api/client';
import type { KeyManager } from '../keys/types';
import type { PollarLogger } from '../lib/logger';
import type {
  CosignDevicesContent,
  CosignQuorumReport,
  CosignRelayContent,
  CosignRelayPath,
  CosignRequest,
  CosignVerification,
} from '../types';
import { PollarApiError } from '../types';
import { bytesToHex, compressedPublicKeyHex, encodeStamp, rawSignatureToDer } from './encoding';
import { stellarTransactionHashHex } from './stellar-hash';

/**
 * The user's half of a Turnkey co-signed wallet, headless: no UI, only
 * promises and the requests it resolves. The device key is a P-256 key of its
 * own (namespace `cosign`), registered in Turnkey as the user's root
 * credential; every vote is a Turnkey request this device stamps itself and
 * sdk-api forwards unchanged.
 *
 * Before voting, {@link verify} recomputes the Stellar transaction hash from
 * the unsigned XDR the request carries and compares it with what Turnkey says
 * it was asked to sign, read straight from Turnkey through the relay. A
 * compromised sdk-api can therefore not have the device approve a payload
 * other than the one it shows.
 */

export interface CosignManagerDeps {
  api: PollarApiClient;
  keyManager: KeyManager;
  logger: PollarLogger;
  networkPassphrase: () => string;
  /** Every request the manager learns about or resolves, for the client's store. */
  onRequest: (request: CosignRequest) => void;
  /**
   * Whether a request Pollar opened on its own may be approved here without a
   * prompt. The client answers from its confirmation policy and the setup
   * recognizer; absent, nothing is approved without the user.
   */
  autoApprove?: (request: CosignRequest) => boolean;
  /** Tell the store a request is being settled by the client itself, so no prompt opens for it. */
  markAutoHandled?: (id: string, handled: boolean) => void;
}

const SCHEME = 'SIGNATURE_SCHEME_TK_API_P256';

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The `{ walletId, accounts }` of a create_wallet_accounts request in one
 * canonical string: the fields Turnkey derives from, in a fixed order, so the
 * payload sdk-api sent and the intent Turnkey holds compare as strings.
 */
function canonicalAccounts(value: unknown): string | null {
  const v = value as { walletId?: unknown; accounts?: unknown } | null;
  if (!v || typeof v.walletId !== 'string' || !Array.isArray(v.accounts)) return null;
  const accounts = v.accounts.map((a) => {
    const acc = (a ?? {}) as Record<string, unknown>;
    return [acc.curve, acc.pathFormat, acc.path, acc.addressFormat].map((x) => (typeof x === 'string' ? x : '')).join('|');
  });
  return `${v.walletId}:${accounts.join(';')}`;
}

type Intent = Record<string, unknown> | null;

/** The payload Turnkey holds for the activity, in the form {@link CosignManager.verify} compares. */
function turnkeyPayloadOf(request: CosignRequest, intent: Intent): string | null {
  if (!intent) return null;
  if (request.kind === 'ACCOUNT') return canonicalAccounts(intent.createWalletAccountsIntent);
  if (request.network === 'STELLAR') {
    const payload = (intent.signRawPayloadIntentV2 as { payload?: unknown } | undefined)?.payload;
    return typeof payload === 'string' ? payload.toLowerCase() : null;
  }
  const tx = (intent.signTransactionIntentV2 as { unsignedTransaction?: unknown } | undefined)?.unsignedTransaction;
  return typeof tx === 'string' ? tx.toLowerCase() : null;
}

/** The account Turnkey would sign with, as the intent names it. */
function signWithOf(request: CosignRequest, intent: Intent): string | null {
  const source = request.network === 'STELLAR' ? intent?.signRawPayloadIntentV2 : intent?.signTransactionIntentV2;
  const signWith = (source as { signWith?: unknown } | undefined)?.signWith;
  return typeof signWith === 'string' ? signWith : null;
}

function apiError(error: unknown, fallback: string): PollarApiError {
  const body = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  return new PollarApiError(typeof body.code === 'string' ? body.code : fallback, body);
}

function content<T>(res: { data?: { content?: T }; error?: unknown }, fallback: string): T {
  if (res.error || res.data?.content === undefined) throw apiError(res.error, fallback);
  return res.data.content;
}

export class CosignManager {
  private readonly deps: CosignManagerDeps;
  private _publicKeyHex: string | null = null;

  constructor(deps: CosignManagerDeps) {
    this.deps = deps;
  }

  /** The device key's public half as Turnkey registers it: SEC1 compressed, hex. */
  async publicKeyHex(): Promise<string> {
    if (this._publicKeyHex) return this._publicKeyHex;
    const km = this.deps.keyManager;
    await km.init();
    // A key that did not persist would be a credential the next launch cannot
    // use; the login still proceeds, the warning is for the integrator.
    try {
      if ((await km.ensurePersisted?.()) === false) {
        this.deps.logger.warn(
          '[PollarClient] The co-signing device key could not be persisted; approvals will work until the page is reloaded.',
        );
      }
    } catch (err) {
      this.deps.logger.warn('[PollarClient] Co-signing device key persistence check failed', err);
    }
    this._publicKeyHex = compressedPublicKeyHex(await km.getPublicJwk());
    return this._publicKeyHex;
  }

  /** The `X-Stamp` value for a request body this device signs. */
  async stamp(body: string): Promise<string> {
    const publicKey = await this.publicKeyHex();
    const raw = await this.deps.keyManager.sign(new TextEncoder().encode(body));
    return encodeStamp({ publicKey, scheme: SCHEME, signature: bytesToHex(rawSignatureToDer(raw)) });
  }

  /**
   * The requests waiting for the user. Requests Pollar opened on its own that
   * the device recognizes as setup of this wallet (its account creation, a
   * trustline, an account on a new chain) are approved here without a prompt
   * when the client's policy allows it, as a custodial wallet performs them
   * silently; a completed one may open the next (trustlines come one at a
   * time), so the list is read again until nothing is left to settle. What
   * remains needs a decision and is what the store shows.
   */
  async pending(): Promise<CosignRequest[]> {
    // One read at a time. The provider and a modal both ask on mount (twice
    // each under React's strict mode), and two concurrent reads would each
    // vote on the same setup request; the later refresh then hands the store
    // a pending copy of a request the first vote already completed.
    if (!this._pendingRead) {
      this._pendingRead = this.readPending().finally(() => {
        this._pendingRead = null;
      });
    }
    return this._pendingRead;
  }

  private _pendingRead: Promise<CosignRequest[]> | null = null;

  private async readPending(): Promise<CosignRequest[]> {
    let remaining: CosignRequest[] = [];
    for (let round = 0; round < 6; round++) {
      const { requests } = content(await this.deps.api.GET('/cosign/requests'), 'SDK_COSIGN_REQUEST_NOT_FOUND');
      const auto = requests.filter((r) => r.status === 'PENDING' && this.deps.autoApprove?.(r) === true);
      remaining = requests.filter((r) => !auto.includes(r));
      for (const r of remaining) this.deps.onRequest(r);
      if (auto.length === 0) break;
      for (const r of auto) {
        this.deps.markAutoHandled?.(r.id, true);
        try {
          await this.approve(r);
        } catch (err) {
          // Verification failed or Turnkey did not answer: the request stays
          // pending and is shown, with its reason, instead of being voted on.
          this.deps.logger.warn('[PollarClient] a setup request could not be approved automatically', err);
          this.deps.markAutoHandled?.(r.id, false);
          remaining.push(r);
          this.deps.onRequest(r);
        } finally {
          this.deps.markAutoHandled?.(r.id, false);
        }
      }
    }
    return remaining;
  }

  /** One request; `sync` asks sdk-api to re-read the activity from Turnkey first. */
  async get(id: string, options?: { sync?: boolean }): Promise<CosignRequest> {
    const { request } = content(
      await this.deps.api.GET('/cosign/requests/{id}', {
        params: { path: { id }, query: options?.sync ? { sync: '1' } : {} },
      }),
      'SDK_COSIGN_REQUEST_NOT_FOUND',
    );
    this.deps.onRequest(request);
    return request;
  }

  /** Withdraw Pollar's vote: the activity is rejected in Turnkey. Final. */
  async cancel(id: string): Promise<CosignRequest> {
    const { request } = content(
      await this.deps.api.POST('/cosign/requests/{id}/cancel', { params: { path: { id } } }),
      'SDK_COSIGN_REQUEST_NOT_FOUND',
    );
    this.deps.onRequest(request);
    return request;
  }

  async devices(): Promise<CosignDevicesContent> {
    return content(await this.deps.api.GET('/cosign/devices'), 'SDK_COSIGN_DEVICE_NOT_ENROLLED');
  }

  /**
   * Stamp a Turnkey request with the device key and hand it to sdk-api to
   * forward. The body is serialized once here; the stamp covers those exact
   * bytes, so nothing between the device and Turnkey can change them.
   */
  async relay(path: CosignRelayPath, body: Record<string, unknown>): Promise<CosignRelayContent> {
    const json = JSON.stringify(body);
    const stamp = await this.stamp(json);
    const result = content(
      await this.deps.api.POST('/cosign/relay', { body: { path, body: json, stamp } }),
      'SDK_COSIGN_UPSTREAM_ERROR',
    );
    if (result.request) this.deps.onRequest(result.request);
    return result;
  }

  /** The activity's intent as Turnkey holds it, read with the device's own key. */
  async readActivityIntent(request: CosignRequest): Promise<Record<string, unknown> | null> {
    const res = await this.relay('/public/v1/query/get_activity', {
      organizationId: request.subOrgId,
      activityId: request.activityId,
    });
    const activity = (res.body as { activity?: { intent?: Record<string, unknown> } } | null)?.activity;
    return activity?.intent ?? null;
  }

  /** What Turnkey says the activity will sign, read with the device's own key. */
  async readActivityPayload(request: CosignRequest): Promise<string | null> {
    return turnkeyPayloadOf(request, await this.readActivityIntent(request));
  }

  /**
   * Ask sdk-api to rebuild the request right before the vote. A transaction
   * embeds state that ages while the user decides: a Solana blockhash lasts
   * about a minute, a Stellar sequence or sponsor signature a few minutes. The
   * rebuilt payload comes back under the same request id with a new Turnkey
   * activity, and it is that payload the device then verifies and approves. A
   * request the client composed itself (`refreshable: false`) is returned as is.
   */
  async refresh(target: CosignRequest | string): Promise<CosignRequest> {
    const id = typeof target === 'string' ? target : target.id;
    const res = await this.deps.api.POST('/cosign/requests/{id}/refresh', { params: { path: { id } } });
    const request = content(res, 'SDK_COSIGN_REQUEST_NOT_FOUND').request;
    this.deps.onRequest(request);
    return request;
  }

  /**
   * Check a request before voting on it: the hash of the unsigned transaction
   * it carries must equal both the hash sdk-api claims and the payload Turnkey
   * holds for the activity. Anything else is a reason not to approve.
   */
  async verify(request: CosignRequest): Promise<CosignVerification> {
    // What the device expects Turnkey to hold, computed from the payload sdk-api
    // sent, never from its summary. Stellar: the transaction hash, recomputed
    // from the XDR. Solana: the serialized unsigned transaction itself, which
    // sign_transaction records byte for byte. ACCOUNT: the wallet id and the
    // account parameters of the derivation, in canonical JSON.
    let localHash: string;
    if (request.kind === 'ACCOUNT') {
      const expected = canonicalAccounts(parseJson(request.unsignedPayload));
      if (!expected) return { ok: false, reason: 'the account derivation payload is not readable' };
      localHash = expected;
    } else if (request.network === 'STELLAR') {
      try {
        localHash = await stellarTransactionHashHex(request.unsignedPayload, this.deps.networkPassphrase());
      } catch (err) {
        return { ok: false, reason: `could not hash the transaction: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (localHash !== request.payloadHash.toLowerCase()) {
        return { ok: false, reason: 'the transaction does not hash to what Pollar asked Turnkey to sign', localHash };
      }
    } else if (request.network === 'SOLANA') {
      localHash = request.unsignedPayload.toLowerCase();
    } else {
      return { ok: false, reason: `verification for ${request.network} is not implemented yet` };
    }

    let intent: Record<string, unknown> | null;
    try {
      intent = await this.readActivityIntent(request);
    } catch (err) {
      return {
        ok: false,
        reason: `could not read the activity from Turnkey: ${err instanceof Error ? err.message : String(err)}`,
        localHash,
      };
    }
    const turnkeyPayload = turnkeyPayloadOf(request, intent);
    if (turnkeyPayload !== localHash) {
      return { ok: false, reason: 'Turnkey holds a different payload for this activity', localHash, turnkeyPayload };
    }
    if (request.kind !== 'ACCOUNT' && signWithOf(request, intent) !== request.signWith) {
      return {
        ok: false,
        reason: 'Turnkey would sign with a different account than the request names',
        localHash,
        turnkeyPayload,
      };
    }
    return { ok: true, localHash, turnkeyPayload };
  }

  /**
   * Vote yes. Verifies first unless told not to; a failed verification throws
   * `SDK_COSIGN_VERIFICATION_FAILED` with the report, and nothing is sent.
   * Resolves with the request as it stands after the vote: approved with the
   * signature applied (and submitted, for intents that submit), or still
   * pending if Turnkey has not completed the activity yet.
   */
  async approve(target: CosignRequest | string, options?: { verify?: boolean }): Promise<CosignRequest> {
    let request = typeof target === 'string' ? await this.get(target) : target;
    if (request.status !== 'PENDING') throw new PollarApiError('SDK_COSIGN_REQUEST_NOT_PENDING', { status: request.status });
    // Rebuild first, so the payload this device verifies and votes on is seconds
    // old; see {@link refresh} for what goes stale while the user decides.
    if (request.refreshable) request = await this.refresh(request);
    if (request.status !== 'PENDING') return request;
    if (options?.verify !== false) {
      const verification = await this.verify(request);
      if (!verification.ok) throw new PollarApiError('SDK_COSIGN_VERIFICATION_FAILED', { verification });
    }
    const res = await this.relay('/public/v1/submit/approve_activity', {
      type: 'ACTIVITY_TYPE_APPROVE_ACTIVITY',
      timestampMs: String(Date.now()),
      organizationId: request.subOrgId,
      parameters: { fingerprint: request.fingerprint },
    });
    return res.request ?? (await this.get(request.id, { sync: true }));
  }

  /** Vote no. Final: a rejected activity can never be approved. */
  async reject(target: CosignRequest | string): Promise<CosignRequest> {
    const request = typeof target === 'string' ? await this.get(target) : target;
    if (request.status !== 'PENDING') throw new PollarApiError('SDK_COSIGN_REQUEST_NOT_PENDING', { status: request.status });
    const res = await this.relay('/public/v1/submit/reject_activity', {
      type: 'ACTIVITY_TYPE_REJECT_ACTIVITY',
      timestampMs: String(Date.now()),
      organizationId: request.subOrgId,
      parameters: { fingerprint: request.fingerprint },
    });
    return res.request ?? (await this.get(request.id, { sync: true }));
  }

  /**
   * Read the sub-organization back with the device key and report whether it
   * is the quorum the design promises: two root users, threshold 2, and this
   * device among the user's credentials. Run once after the wallet is created,
   * before the first deposit.
   */
  async inspectQuorum(options?: { report?: boolean }): Promise<CosignQuorumReport> {
    const report = await this.readQuorum();
    // Recorded server-side as VERIFIED or BROKEN so the admin panel and the
    // reconcile see what the device saw; the server never overrides the device.
    if (options?.report !== false && !('reason' in report && report.threshold === undefined)) {
      await this.deps.api
        .POST('/cosign/quorum/verify', {
          body: {
            ok: report.ok,
            threshold: report.threshold ?? 0,
            rootUsers: report.rootUsers ?? 0,
            deviceRegistered: report.deviceRegistered ?? false,
            ...(report.ok ? {} : { reason: report.reason }),
          },
        })
        .catch((err: unknown) => this.deps.logger.warn('[PollarClient] could not record the quorum verification', err));
    }
    return report;
  }

  /**
   * Revoke one of the user's enrolled devices: the device's own vote removes
   * that API key from the user's Turnkey user (P1 lets it act alone), and
   * sdk-api records the revocation when Turnkey confirms it. Revoking the key
   * this device signs with locks this device out, so it is refused unless the
   * caller says so.
   */
  async revokeDevice(deviceId: string, options?: { force?: boolean }): Promise<CosignDevicesContent> {
    const current = await this.devices();
    const device = current.devices.find((d) => d.id === deviceId);
    if (!device) throw new PollarApiError('SDK_COSIGN_DEVICE_NOT_ENROLLED', { deviceId });
    if (!device.tkApiKeyId || !current.subOrgId || !current.endUserId) {
      throw new PollarApiError('SDK_COSIGN_DEVICE_NOT_ENROLLED', { deviceId, reason: 'no Turnkey api key id recorded' });
    }
    if (device.publicKey.toLowerCase() === (await this.publicKeyHex()).toLowerCase() && !options?.force) {
      throw new PollarApiError('SDK_COSIGN_DEVICE_NOT_ENROLLED', {
        deviceId,
        reason: 'this is the current device; pass force',
      });
    }
    const res = await this.relay('/public/v1/submit/delete_api_keys', {
      type: 'ACTIVITY_TYPE_DELETE_API_KEYS',
      timestampMs: String(Date.now()),
      organizationId: current.subOrgId,
      parameters: { userId: current.endUserId, apiKeyIds: [device.tkApiKeyId] },
    });
    if (res.status !== 200) throw new PollarApiError('SDK_COSIGN_UPSTREAM_ERROR', { status: res.status, body: res.body });
    return this.devices();
  }

  private async readQuorum(): Promise<CosignQuorumReport> {
    const { subOrgId } = await this.devices();
    if (!subOrgId) return { ok: false, reason: 'this user has no co-signed wallet' };
    const res = await this.relay('/public/v1/query/get_organization', { organizationId: subOrgId });
    const data = (
      res.body as {
        organizationData?: {
          rootQuorum?: { threshold?: number; userIds?: string[] };
          users?: Array<{ userId: string; apiKeys?: Array<{ credential?: { publicKey?: string } }> }>;
        };
      } | null
    )?.organizationData;
    if (!data) return { ok: false, reason: `Turnkey answered ${res.status} without organization data` };
    const threshold = data.rootQuorum?.threshold ?? 0;
    const rootUsers = data.rootQuorum?.userIds?.length ?? 0;
    const devicePublicKey = await this.publicKeyHex();
    const deviceRegistered = (data.users ?? []).some((u) =>
      (u.apiKeys ?? []).some((k) => (k.credential?.publicKey ?? '').toLowerCase() === devicePublicKey.toLowerCase()),
    );
    const ok = threshold === 2 && rootUsers === 2 && deviceRegistered;
    return ok
      ? { ok: true, threshold, rootUsers, deviceRegistered }
      : { ok: false, reason: 'the sub-organization is not the expected 2-of-2 quorum', threshold, rootUsers, deviceRegistered };
  }
}
