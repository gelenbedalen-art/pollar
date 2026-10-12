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
}

const SCHEME = 'SIGNATURE_SCHEME_TK_API_P256';

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

  /** Requests still waiting for this user's vote. */
  async pending(): Promise<CosignRequest[]> {
    const { requests } = content(await this.deps.api.GET('/cosign/requests'), 'SDK_COSIGN_REQUEST_NOT_FOUND');
    for (const r of requests) this.deps.onRequest(r);
    return requests;
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

  /** What Turnkey says the activity will sign, read with the device's own key. */
  async readActivityPayload(request: CosignRequest): Promise<string | null> {
    const res = await this.relay('/public/v1/query/get_activity', {
      organizationId: request.subOrgId,
      activityId: request.activityId,
    });
    const activity = (res.body as { activity?: { intent?: { signRawPayloadIntentV2?: { payload?: string } } } } | null)
      ?.activity;
    const payload = activity?.intent?.signRawPayloadIntentV2?.payload;
    return typeof payload === 'string' ? payload.toLowerCase() : null;
  }

  /**
   * Check a request before voting on it: the hash of the unsigned transaction
   * it carries must equal both the hash sdk-api claims and the payload Turnkey
   * holds for the activity. Anything else is a reason not to approve.
   */
  async verify(request: CosignRequest): Promise<CosignVerification> {
    if (request.network !== 'STELLAR') {
      return { ok: false, reason: `verification for ${request.network} is not implemented yet` };
    }
    let localHash: string;
    try {
      localHash = await stellarTransactionHashHex(request.unsignedPayload, this.deps.networkPassphrase());
    } catch (err) {
      return { ok: false, reason: `could not hash the transaction: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (localHash !== request.payloadHash.toLowerCase()) {
      return { ok: false, reason: 'the transaction does not hash to what Pollar asked Turnkey to sign', localHash };
    }
    let turnkeyPayload: string | null;
    try {
      turnkeyPayload = await this.readActivityPayload(request);
    } catch (err) {
      return {
        ok: false,
        reason: `could not read the activity from Turnkey: ${err instanceof Error ? err.message : String(err)}`,
        localHash,
      };
    }
    if (turnkeyPayload !== localHash) {
      return { ok: false, reason: 'Turnkey holds a different payload for this activity', localHash, turnkeyPayload };
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
    const request = typeof target === 'string' ? await this.get(target) : target;
    if (request.status !== 'PENDING') throw new PollarApiError('SDK_COSIGN_REQUEST_NOT_PENDING', { status: request.status });
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
  async inspectQuorum(): Promise<CosignQuorumReport> {
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
