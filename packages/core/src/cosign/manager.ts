import type { PollarApiClient } from '../api/client';
import type { KeyManager } from '../keys/types';
import type { PollarLogger } from '../lib/logger';
import type {
  CosignCustody,
  CosignDevicesContent,
  CosignQuorumReport,
  CosignRelayContent,
  CosignRelayPath,
  CosignRequest,
  CosignVerification,
} from '../types';
import { PollarApiError } from '../types';
import { bytesToHex, compressedPublicKeyHex, encodeStamp, rawSignatureToDer } from './encoding';
import { checkCustodySwitchStep, type CustodySwitchStep } from './custody';
import { checkEvmRequest, polygonChainIdFor } from './evm';
import { checkSolanaRequest } from './solana';
import { stellarTransactionHashHex } from './stellar-hash';
import { isRecord, stringField } from '../api/error-fields';

/**
 * The user's half of a Turnkey wallet, headless: no UI, only promises and the
 * requests it resolves. The device key is a P-256 key of its own (namespace
 * `cosign`), registered in Turnkey as the user's root credential; every vote
 * is a Turnkey request this device stamps itself and sdk-api forwards
 * unchanged.
 *
 * The device proposes every activity. On a co-signed wallet Pollar's approver
 * votes second; on a self-custody wallet (a 1-of-1 sub-org) the proposal
 * completes by itself, through the same calls. {@link verify} reads the
 * unsigned payload the request carries (the Stellar hash recomputed from the
 * XDR, the Solana or EVM transaction decoded) and {@link approve} builds the
 * Turnkey request from those checked values alone, so a compromised sdk-api
 * cannot have the device sign a payload other than the one it shows.
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

const ACCOUNT_FIELDS = ['curve', 'pathFormat', 'path', 'addressFormat'] as const;

/**
 * The `{ walletId, accounts }` of a create_wallet_accounts request with only
 * the fields Turnkey derives from, so the device proposes exactly the
 * derivation it read and nothing sdk-api added beside it.
 */
function accountsOf(value: unknown): { walletId: string; accounts: Array<Record<string, string>> } | null {
  const walletId = stringField(value, 'walletId');
  const list = isRecord(value) ? value.accounts : undefined;
  if (walletId === undefined || !Array.isArray(list) || list.length === 0) return null;
  const accounts: Array<Record<string, string>> = [];
  for (const acc of list) {
    const entry: Record<string, string> = {};
    for (const key of ACCOUNT_FIELDS) {
      const field = stringField(acc, key);
      if (field === undefined) return null;
      entry[key] = field;
    }
    accounts.push(entry);
  }
  return { walletId, accounts };
}

function apiError(error: unknown, fallback: string): PollarApiError {
  const body = isRecord(error) ? error : {};
  return new PollarApiError(stringField(body, 'code') ?? fallback, body);
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

  /** Close the request as rejected; once proposed, Pollar votes against the activity. Final. */
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
  async relay(
    path: CosignRelayPath,
    body: Record<string, unknown>,
    options?: { requestId?: string },
  ): Promise<CosignRelayContent> {
    const json = JSON.stringify(body);
    const stamp = await this.stamp(json);
    const result = content(
      await this.deps.api.POST('/cosign/relay', {
        body: { path, body: json, stamp, ...(options?.requestId ? { requestId: options.requestId } : {}) },
      }),
      'SDK_COSIGN_UPSTREAM_ERROR',
    );
    if (result.request) this.deps.onRequest(result.request);
    return result;
  }

  /**
   * Ask sdk-api to rebuild the request right before the vote. A transaction
   * embeds state that ages while the user decides: a Solana blockhash lasts
   * about a minute, a Stellar sequence or sponsor signature a few minutes. The
   * rebuilt payload comes back under the same request id, and it is that payload
   * the device then verifies and proposes. A request the client composed itself
   * (`refreshable: false`) is returned as is.
   */
  async refresh(target: CosignRequest | string): Promise<CosignRequest> {
    const id = typeof target === 'string' ? target : target.id;
    const res = await this.deps.api.POST('/cosign/requests/{id}/refresh', { params: { path: { id } } });
    const request = content(res, 'SDK_COSIGN_REQUEST_NOT_FOUND').request;
    this.deps.onRequest(request);
    return request;
  }

  /**
   * Check a request before proposing it: the unsigned payload it carries is
   * read here, never its summary, and must be what the request says it is.
   * The report carries the Turnkey request built from the checked values, the
   * one {@link approve} submits. Anything else is a reason not to approve.
   */
  async verify(request: CosignRequest): Promise<CosignVerification> {
    const signed = (type: string, parameters: Record<string, unknown>) => ({
      type,
      timestampMs: String(Date.now()),
      organizationId: request.subOrgId,
      parameters,
    });

    if (request.kind === 'ACCOUNT') {
      const derivation = accountsOf(parseJson(request.unsignedPayload));
      if (!derivation) return { ok: false, reason: 'the account derivation payload is not readable' };
      const localHash = `${derivation.walletId}:${derivation.accounts.map((a) => ACCOUNT_FIELDS.map((k) => a[k]).join('|')).join(';')}`;
      return {
        ok: true,
        localHash,
        proposal: {
          path: '/public/v1/submit/create_wallet_accounts',
          body: signed('ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS', derivation),
        },
      };
    }

    if (request.network === 'STELLAR') {
      let localHash: string;
      try {
        localHash = await stellarTransactionHashHex(request.unsignedPayload, this.deps.networkPassphrase());
      } catch (err) {
        return { ok: false, reason: `could not hash the transaction: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (localHash !== request.payloadHash.toLowerCase()) {
        return { ok: false, reason: 'the transaction does not hash to what Pollar asks to sign', localHash };
      }
      return {
        ok: true,
        localHash,
        proposal: {
          path: '/public/v1/submit/sign_raw_payload',
          body: signed('ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2', {
            signWith: request.signWith,
            payload: localHash,
            encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
            // ed25519 signs the bytes as given.
            hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
          }),
        },
      };
    }

    if (request.network === 'SOLANA') {
      // The payload is read, not only compared: a CCTP burn or a transfer, and
      // the one the request says it is.
      const check = checkSolanaRequest(request.unsignedPayload, {
        ...(request.operation ? { operation: request.operation } : {}),
        details: request.details,
        signWith: request.signWith,
      });
      if (!check.ok) return { ok: false, reason: check.reason };
      const localHash = request.unsignedPayload.toLowerCase();
      return {
        ok: true,
        localHash,
        proposal: {
          path: '/public/v1/submit/sign_transaction',
          body: signed('ACTIVITY_TYPE_SIGN_TRANSACTION_V2', {
            signWith: request.signWith,
            unsignedTransaction: localHash,
            type: 'TRANSACTION_TYPE_SOLANA',
          }),
        },
      };
    }

    if (request.network === 'POLYGON') {
      // The payload is read here, not only compared: the call it makes must be
      // one the platform asks for, and the one the request says it is.
      const check = checkEvmRequest(request.unsignedPayload, request.details, polygonChainIdFor(this.deps.networkPassphrase()));
      if (!check.ok) return { ok: false, reason: check.reason };
      const localHash = request.unsignedPayload.replace(/^0x/i, '').toLowerCase();
      return {
        ok: true,
        localHash,
        proposal: {
          path: '/public/v1/submit/sign_transaction',
          body: signed('ACTIVITY_TYPE_SIGN_TRANSACTION_V2', {
            signWith: request.signWith,
            unsignedTransaction: localHash,
            type: 'TRANSACTION_TYPE_ETHEREUM',
          }),
        },
      };
    }

    return { ok: false, reason: `verification for ${request.network} is not implemented yet` };
  }

  /**
   * Vote yes by proposing the activity: the device submits the Turnkey request
   * {@link verify} built and Pollar's approver votes second. A failed
   * verification throws `SDK_COSIGN_VERIFICATION_FAILED` with the report, and
   * nothing is sent. Resolves with the request as it stands after both votes:
   * approved with the signature applied (and submitted, for intents that
   * submit), or still pending if Turnkey has not completed the activity yet.
   */
  async approve(target: CosignRequest | string): Promise<CosignRequest> {
    let request = typeof target === 'string' ? await this.get(target) : target;
    if (request.status !== 'PENDING') throw new PollarApiError('SDK_COSIGN_REQUEST_NOT_PENDING', { status: request.status });
    // Rebuild first, so the payload this device verifies and proposes is
    // seconds old; see {@link refresh} for what goes stale while the user decides.
    if (request.refreshable) request = await this.refresh(request);
    if (request.status !== 'PENDING') return request;
    // Already proposed (by this device or another of the user's): only the
    // approver's vote is outstanding, and sdk-api reads it back from Turnkey.
    if (request.activityId) return this.get(request.id, { sync: true });
    const verification = await this.verify(request);
    if (!verification.ok) throw new PollarApiError('SDK_COSIGN_VERIFICATION_FAILED', { verification });
    const res = await this.relay(verification.proposal.path, verification.proposal.body, { requestId: request.id });
    return res.request ?? (await this.get(request.id, { sync: true }));
  }

  /** Vote no. Final: a rejected request can never be approved. */
  async reject(target: CosignRequest | string): Promise<CosignRequest> {
    const request = typeof target === 'string' ? await this.get(target) : target;
    if (request.status !== 'PENDING') throw new PollarApiError('SDK_COSIGN_REQUEST_NOT_PENDING', { status: request.status });
    return this.cancel(request.id);
  }

  /**
   * Read the sub-organization back with the device key and report whether it
   * is the quorum the wallet's custody promises: two root users at threshold 2
   * (co-signed) or the user alone at threshold 1 (self-custody), with this
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

  /**
   * Move the user's wallet to `to`: co-signed (Pollar's approver votes on every
   * signature) or self-custody (only this device signs). Each step is a Turnkey
   * activity this device stamps after checking it keeps the wallet the user's
   * ({@link checkCustodySwitchStep}); sdk-api forwards it only when it is
   * exactly the next step, and Pollar votes only on lowering a 2-of-2 quorum.
   * A switch that stops halfway resumes where it is on the next call. Resolves
   * with the quorum as this device reads it once the switch is done.
   *
   * Throws {@link PollarApiError}: `SDK_COSIGN_CUSTODY_SWITCH_NOT_ALLOWED` for an
   * app that does not let its users choose, `SDK_COSIGN_CUSTODY_SWITCH_PENDING`
   * while a co-sign request waits, `SDK_COSIGN_VERIFICATION_FAILED` when a step
   * fails the device's check (nothing is stamped).
   */
  async switchCustody(to: CosignCustody): Promise<CosignQuorumReport> {
    let state = content(
      await this.deps.api.POST('/cosign/custody/next', { body: { to } }),
      'SDK_COSIGN_CUSTODY_SWITCH_NOT_ALLOWED',
    );
    for (let round = 0; round < 8; round++) {
      if (state.done) return this.inspectQuorum();
      if (!state.step) throw new PollarApiError('SDK_COSIGN_UPSTREAM_ERROR', { reason: 'no step and not done' });
      const step = state.step as CustodySwitchStep;
      const check = checkCustodySwitchStep(step, to, state.endUserId);
      if (!check.ok) throw new PollarApiError('SDK_COSIGN_VERIFICATION_FAILED', { verification: check, step });
      const body = JSON.stringify({
        type: step.type,
        timestampMs: String(Date.now()),
        organizationId: state.subOrgId,
        parameters: step.parameters,
      });
      const stamp = await this.stamp(body);
      const result = content(
        await this.deps.api.POST('/cosign/custody/step', { body: { to, path: state.step.path, body, stamp } }),
        'SDK_COSIGN_UPSTREAM_ERROR',
      );
      const activity = isRecord(result.body) && isRecord(result.body.activity) ? result.body.activity : undefined;
      if (stringField(activity, 'status') !== 'ACTIVITY_STATUS_COMPLETED') {
        throw new PollarApiError('SDK_COSIGN_UPSTREAM_ERROR', { status: result.status, body: result.body });
      }
      // The answer already carries where the switch stands after this step.
      state = result.next;
    }
    throw new PollarApiError('SDK_COSIGN_UPSTREAM_ERROR', { reason: 'the custody switch did not converge' });
  }

  private async readQuorum(): Promise<CosignQuorumReport> {
    const { subOrgId, custody } = await this.devices();
    if (!subOrgId || !custody) return { ok: false, reason: 'this user has no Turnkey wallet' };
    // What the sub-org must look like for this custody: the root users and the
    // threshold are what make the wallet the user's.
    const expected = custody === 'SELF_CUSTODY' ? { threshold: 1, rootUsers: 1 } : { threshold: 2, rootUsers: 2 };
    const res = await this.relay('/public/v1/query/get_organization', { organizationId: subOrgId });
    const data = isRecord(res.body) ? res.body.organizationData : undefined;
    if (!isRecord(data)) return { ok: false, reason: `Turnkey answered ${res.status} without organization data` };
    const quorum = isRecord(data.rootQuorum) ? data.rootQuorum : {};
    const threshold = typeof quorum.threshold === 'number' ? quorum.threshold : 0;
    const rootUsers = Array.isArray(quorum.userIds) ? quorum.userIds.length : 0;
    const devicePublicKey = (await this.publicKeyHex()).toLowerCase();
    const users: unknown[] = Array.isArray(data.users) ? data.users : [];
    const deviceRegistered = users.some((user) => {
      const keys: unknown[] = isRecord(user) && Array.isArray(user.apiKeys) ? user.apiKeys : [];
      return keys.some(
        (key) => (stringField(isRecord(key) ? key.credential : undefined, 'publicKey') ?? '').toLowerCase() === devicePublicKey,
      );
    });
    const ok = threshold === expected.threshold && rootUsers === expected.rootUsers && deviceRegistered;
    return ok
      ? { ok: true, custody, threshold, rootUsers, deviceRegistered }
      : {
          ok: false,
          reason: `the sub-organization is not the expected ${expected.threshold}-of-${expected.rootUsers} quorum`,
          custody,
          threshold,
          rootUsers,
          deviceRegistered,
        };
  }
}
