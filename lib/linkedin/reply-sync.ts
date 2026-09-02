import type { Page } from "playwright";
import { getDb } from "@/lib/db";
import {
  getSessionPage,
  markNeedsReauth,
  saveSessionState,
} from "@/lib/linkedin/session";

const DEFAULT_POLL_SECONDS = 60;
const CONVERSATION_PAGE_SIZE = 100;
const MAX_CONVERSATION_PAGES = 10;
const EVENT_PAGE_SIZE = 40;
const MAX_EVENT_PAGES = 3;
const LINKEDIN_ORIGIN = "https://www.linkedin.com";
const LOGIN_WALL = /linkedin\.com\/(?:login|authwall|checkpoint|uas\/)/i;
// These persisted-query hashes are fallbacks. The sync normally observes the
// hashes used by the currently loaded LinkedIn inbox so hash rotations do not
// require a deploy.
const FALLBACK_CONVERSATIONS_QUERY_ID =
  "messengerConversations.0d5e6781bbee71c3e51c8843c6519f48";
const FALLBACK_MESSAGES_QUERY_ID =
  "messengerMessages.5846eeb71c981f11e0134cb6626cc314";

type JsonRecord = Record<string, unknown>;

interface Candidate {
  id: string;
  linkedin_url: string | null;
  messaging_urn: string | null;
  message_sent_at: string;
}

interface VoyagerResponse {
  ok: boolean;
  status: number;
  authWall: boolean;
  payload: unknown | null;
  error: string | null;
}

interface Identity {
  tokens: Set<string>;
  vanities: Set<string>;
}

interface ConversationMatch {
  candidate: Candidate;
  prospectTokens: Set<string>;
  cachedMessagingUrn: string | null;
}

interface ConversationPage {
  conversation: JsonRecord;
  conversationUrn: string;
  index: Map<string, JsonRecord>;
}

const processState = globalThis as typeof globalThis & {
  __linkiReplySyncInFlight?: Set<string>;
};
const inFlight = processState.__linkiReplySyncInFlight ??= new Set<string>();

function pollIntervalMs(): number {
  const configured = Number(process.env.LINKEDIN_REPLY_POLL_SECONDS);
  const seconds = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_POLL_SECONDS;
  return seconds * 1000;
}

function accountJitterMs(accountId: string): number {
  let hash = 0;
  for (let i = 0; i < accountId.length; i++) {
    hash = (hash * 31 + accountId.charCodeAt(i)) >>> 0;
  }
  const windowMs = Math.min(15_000, Math.floor(pollIntervalMs() * 0.1));
  return windowMs > 0 ? hash % windowMs : 0;
}

/** Whether this authenticated account has due, relevant LinkedIn reply work. */
export function shouldSyncLinkedInReplies(accountId: string): boolean {
  if (inFlight.has(accountId)) return false;

  const db = getDb();
  const row = db.prepare(
    `SELECT a.inbox_synced_at,
            EXISTS (
              SELECT 1
              FROM runs r
              JOIN run_profiles rp ON rp.run_id = r.id
              JOIN targets t ON t.id = rp.target_id
              WHERE r.account_id = a.id
                AND r.status = 'running'
                AND t.message_sent_at IS NOT NULL
                AND t.last_replied_at IS NULL
            ) AS has_work
     FROM accounts a
     WHERE a.id = ? AND a.is_authenticated = 1`
  ).get(accountId) as
    | { inbox_synced_at: string | null; has_work: number }
    | undefined;

  if (!row?.has_work) return false;
  if (!row.inbox_synced_at) return true;

  const lastSyncMs = parseStoredDate(row.inbox_synced_at);
  if (lastSyncMs === null) return true;
  return Date.now() - lastSyncMs >= pollIntervalMs() + accountJitterMs(accountId);
}

/**
 * Detect new inbound messages for messaged prospects in this account's active
 * runs, stamp the target, and make a parked wait_for_reply step due now.
 */
export async function syncLinkedInReplies(accountId: string): Promise<number> {
  if (inFlight.has(accountId)) return 0;
  inFlight.add(accountId);

  const db = getDb();
  let page: Page | null = null;
  let encounteredAuthWall = false;
  let completed = false;

  try {
    const candidates = db.prepare(
      `SELECT DISTINCT t.id, t.linkedin_url, t.messaging_urn, t.message_sent_at
       FROM runs r
       JOIN run_profiles rp ON rp.run_id = r.id
       JOIN targets t ON t.id = rp.target_id
       WHERE r.account_id = ?
         AND r.status = 'running'
         AND t.message_sent_at IS NOT NULL
         AND t.last_replied_at IS NULL`
    ).all(accountId) as Candidate[];

    if (candidates.length === 0) return 0;

    page = await getSessionPage(accountId);
    const observedConversations = page.waitForResponse(
      (response) => isMessengerQuery(response.url(), "messengerConversations."),
      { timeout: 15_000 },
    ).catch(() => null);
    const observedMessages = page.waitForResponse(
      (response) => isMessengerQuery(response.url(), "messengerMessages."),
      { timeout: 15_000 },
    ).catch(() => null);
    await page.goto(`${LINKEDIN_ORIGIN}/messaging/`, {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    });
    await page.waitForTimeout(1_500 + Math.random() * 1_000);

    if (isLoginWall(page.url())) {
      encounteredAuthWall = true;
      return 0;
    }

    const [conversationResponse, messageResponse] = await Promise.all([
      observedConversations,
      observedMessages,
    ]);
    const observedConversationPayload = await responseJson(conversationResponse);
    const conversationsQueryId = queryIdFromUrl(conversationResponse?.url()) ??
      FALLBACK_CONVERSATIONS_QUERY_ID;
    const messagesQueryId = queryIdFromUrl(messageResponse?.url()) ??
      FALLBACK_MESSAGES_QUERY_ID;

    const meResponse = await voyagerGet(page, "/voyager/api/me");
    if (meResponse.authWall) {
      encounteredAuthWall = true;
      return 0;
    }
    if (!meResponse.ok || !meResponse.payload) {
      throw new Error(voyagerError("current-member lookup", meResponse));
    }

    const selfIdentity = emptyIdentity();
    collectIdentity(meData(meResponse.payload), buildRecordIndex(meResponse.payload), selfIdentity);
    if (selfIdentity.tokens.size === 0) {
      throw new Error("LinkedIn /voyager/api/me did not expose a stable member identity");
    }

    const candidateIdentity = new Map<string, { token: string | null; vanity: string | null }>();
    for (const candidate of candidates) {
      candidateIdentity.set(candidate.id, {
        token: stableProfileToken(candidate.messaging_urn),
        vanity: vanityFromUrl(candidate.linkedin_url),
      });
    }

    const conversations = new Map<string, ConversationPage>();
    const matches = new Map<string, ConversationMatch[]>();
    const matchedCandidates = new Set<string>();
    const earliestMessageMs = Math.min(
      ...candidates.map((candidate) => parseStoredDate(candidate.message_sent_at) ?? Date.now()),
    );

    for (let pageNumber = 0; pageNumber < MAX_CONVERSATION_PAGES; pageNumber++) {
      const start = pageNumber * CONVERSATION_PAGE_SIZE;
      let response: VoyagerResponse;
      let messengerGraphQl = false;

      if (pageNumber === 0) {
        const mailboxToken = selfIdentity.tokens.values().next().value;
        const mailboxUrn = mailboxToken ? `urn:li:fsd_profile:${mailboxToken}` : null;
        response = observedConversationPayload !== null
          ? successfulVoyagerResponse(observedConversationPayload)
          : mailboxUrn
            ? await voyagerGet(
              page,
              messengerGraphqlPath(conversationsQueryId, `mailboxUrn:${encodeRestliValue(mailboxUrn)}`),
            )
            : failedVoyagerResponse("Current member did not expose a mailbox URN");
        messengerGraphQl = response.ok;

        // Keep the legacy endpoint as a compatibility fallback for LinkedIn
        // deployments that have not moved their inbox to Messenger GraphQL.
        if (!response.ok) {
          response = await voyagerGet(
            page,
            `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=chronological&start=${start}&count=${CONVERSATION_PAGE_SIZE}`,
          );
          messengerGraphQl = false;
        }
      } else {
        response = await voyagerGet(
          page,
          `/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&q=chronological&start=${start}&count=${CONVERSATION_PAGE_SIZE}`,
        );
      }
      if (response.authWall) {
        encounteredAuthWall = true;
        return 0;
      }
      if (!response.ok || !response.payload) {
        throw new Error(voyagerError(`conversation page at start=${start}`, response));
      }

      const pageConversations = extractConversations(response.payload);
      for (const item of pageConversations) {
        conversations.set(item.conversationUrn, item);
        const participantIdentities = extractParticipantIdentities(item.conversation, item.index);
        const conversationMatches: ConversationMatch[] = [];

        for (const candidate of candidates) {
          if (matchedCandidates.has(candidate.id)) continue;
          const expected = candidateIdentity.get(candidate.id)!;
          const participant = participantIdentities.find((identity) =>
            (expected.token !== null && identity.tokens.has(expected.token)) ||
            (expected.vanity !== null && identity.vanities.has(expected.vanity))
          );
          if (!participant) continue;

          // A self-match means the stored target identity is unsafe. Never use it
          // to classify one of our own outbound messages as a prospect reply.
          const prospectTokens = new Set(
            [...participant.tokens].filter((token) => !selfIdentity.tokens.has(token)),
          );
          if (prospectTokens.size === 0) continue;

          const token = expected.token ?? prospectTokens.values().next().value ?? null;
          conversationMatches.push({
            candidate,
            prospectTokens,
            cachedMessagingUrn: token ? `urn:li:fsd_profile:${token}` : null,
          });
          matchedCandidates.add(candidate.id);
        }

        if (conversationMatches.length > 0) {
          matches.set(item.conversationUrn, conversationMatches);
        }
      }

      if (matchedCandidates.size === candidates.length) break;
      // Messenger GraphQL's initial sync is newest-first and cursor-based.
      // Any new reply moves its conversation into this first page, so do not
      // mix its sync-token pagination with the unrelated legacy start offset.
      if (messengerGraphQl) break;
      if (pageConversations.length < CONVERSATION_PAGE_SIZE) break;

      // The chronological endpoint is newest-first. Once an entire page is
      // older than every outbound message, no older conversation can contain a
      // reply to one of those messages.
      const activityTimes = pageConversations
        .map((item) => numericTimestamp(item.conversation.lastActivityAt))
        .filter((value): value is number => value !== null);
      if (
        activityTimes.length === pageConversations.length &&
        activityTimes.every((value) => value < earliestMessageMs)
      ) break;
    }

    let stamped = 0;
    for (const [conversationUrn, conversationMatches] of matches) {
      const conversation = conversations.get(conversationUrn)!;
      const eventPayloads = await fetchConversationEventPayloads(
        page,
        conversation,
        messagesQueryId,
      );
      if (eventPayloads.authWall) {
        encounteredAuthWall = true;
        return 0;
      }

      for (const match of conversationMatches) {
        const sentAtMs = parseStoredDate(match.candidate.message_sent_at);
        if (sentAtMs === null) continue;

        let newestInboundMs: number | null = null;
        for (const payload of eventPayloads.payloads) {
          const index = buildRecordIndex(payload);
          for (const event of extractEvents(payload, index)) {
            if (!isMessageEvent(event)) continue;
            const createdAt = numericTimestamp(event.createdAt ?? event.deliveredAt);
            if (createdAt === null || createdAt <= sentAtMs || createdAt > Date.now() + 300_000) continue;

            const sender = extractSenderIdentity(event, index);
            if (intersects(sender.tokens, selfIdentity.tokens)) continue;
            if (!intersects(sender.tokens, match.prospectTokens)) continue;
            if (newestInboundMs === null || createdAt > newestInboundMs) newestInboundMs = createdAt;
          }
        }

        if (newestInboundMs === null) continue;
        const repliedAt = new Date(newestInboundMs).toISOString();
        const transaction = db.transaction(() => {
          const update = db.prepare(
            `UPDATE targets
             SET last_replied_at = ?,
                 messaging_urn = COALESCE(messaging_urn, ?)
             WHERE id = ?
               AND message_sent_at IS NOT NULL
               AND last_replied_at IS NULL`
          ).run(repliedAt, match.cachedMessagingUrn, match.candidate.id);

          if (update.changes > 0) {
            db.prepare(
              `UPDATE run_profile_tracks AS rt
               SET next_step_at = datetime('now'), error_message = NULL
               WHERE rt.track = 'linkedin'
                 AND rt.state = 'in_progress'
                 AND EXISTS (
                   SELECT 1
                   FROM run_profiles rp
                   JOIN runs r ON r.id = rp.run_id
                   JOIN workflow_steps ws
                     ON ws.workflow_id = r.workflow_id
                    AND ws.track = 'linkedin'
                    AND ws.step_order = rt.current_step + 1
                   WHERE rp.id = rt.run_profile_id
                     AND rp.target_id = ?
                     AND r.account_id = ?
                     AND r.status = 'running'
                     AND ws.step_type = 'wait_for_reply'
                 )`
            ).run(match.candidate.id, accountId);
          }
          return update.changes;
        });

        if (transaction() > 0) stamped++;
      }
    }

    db.prepare("UPDATE accounts SET inbox_synced_at = datetime('now') WHERE id = ?").run(accountId);
    completed = true;
    return stamped;
  } finally {
    if (page) {
      try {
        if (isLoginWall(page.url())) encounteredAuthWall = true;
      } catch { /* the page has already gone away */ }
      try { await page.close(); } catch { /* best effort */ }

      if (encounteredAuthWall) {
        try { await markNeedsReauth(accountId); } catch { /* best effort */ }
      } else {
        try { await saveSessionState(accountId); } catch { /* best effort */ }
      }
    }
    if (!completed && encounteredAuthWall) {
      console.warn(`[reply-sync] LinkedIn session for account ${accountId} needs re-authentication`);
    }
    inFlight.delete(accountId);
  }
}

async function fetchConversationEventPayloads(
  page: Page,
  conversation: ConversationPage,
  messagesQueryId: string,
): Promise<{ payloads: unknown[]; authWall: boolean }> {
  const payloads: unknown[] = [];

  // Current LinkedIn inboxes (Sep 2026) use Messenger GraphQL. The newest
  // page is sufficient for reply detection because an inbound reply moves the
  // conversation to the top and the outbound message timestamp is our floor.
  const graphResponse = await voyagerGet(
    page,
    messengerGraphqlPath(
      messagesQueryId,
      `conversationUrn:${encodeRestliValue(conversation.conversationUrn)}`,
    ),
  );
  if (graphResponse.authWall) return { payloads: [], authWall: true };
  if (graphResponse.ok && graphResponse.payload) {
    return { payloads: [graphResponse.payload], authWall: false };
  }

  const terminalId = conversation.conversationUrn.split(":").pop();
  const resourceIds = [...new Set([
    terminalId ? encodeURIComponent(terminalId) : null,
    encodeURIComponent(conversation.conversationUrn),
  ].filter((value): value is string => value !== null))];
  let selectedResourceId: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_EVENT_PAGES; pageNumber++) {
    const start = pageNumber * EVENT_PAGE_SIZE;
    let response: VoyagerResponse | null = null;
    const activeResourceIds: string[] = selectedResourceId === null
      ? resourceIds
      : [selectedResourceId];
    for (const resourceId of activeResourceIds) {
      response = await voyagerGet(
        page,
        `/voyager/api/messaging/conversations/${resourceId}/events?keyVersion=LEGACY_INBOX&q=chronological&start=${start}&count=${EVENT_PAGE_SIZE}`,
      );
      if (response.authWall) return { payloads: [], authWall: true };
      if (response.ok) {
        selectedResourceId = resourceId;
        break;
      }
    }
    if (!response) throw new Error(`LinkedIn conversation ${conversation.conversationUrn} has no usable resource id`);
    if (response.authWall) return { payloads: [], authWall: true };

    if (!response.ok || !response.payload) {
      // Some LinkedIn deployments embed the newest events in the normalized
      // conversation response but do not expose the dedicated events route.
      // Use only events referenced by this exact conversation; never infer a
      // reply from names or generic inbox DOM.
      const embedded = extractConversationEvents(conversation.conversation, conversation.index);
      if (pageNumber === 0 && embedded.length > 0) {
        return { payloads: [embeddedPayload(embedded)], authWall: false };
      }
      throw new Error(voyagerError(`events for ${conversation.conversationUrn}`, response));
    }

    payloads.push(response.payload);
    const index = buildRecordIndex(response.payload);
    if (extractEvents(response.payload, index).length < EVENT_PAGE_SIZE) break;
  }
  return { payloads, authWall: false };
}

function messengerGraphqlPath(queryId: string, variables: string): string {
  return "/voyager/api/voyagerMessagingGraphQL/graphql" +
    `?queryId=${encodeURIComponent(queryId)}&variables=(${variables})`;
}

// Rest.li's GraphQL variable grammar requires RFC 3986 encoding. JavaScript's
// encodeURIComponent deliberately leaves parentheses unescaped, which turns a
// conversation URN containing its own `(owner,thread)` tuple into invalid
// nested variable syntax and LinkedIn answers with HTTP 400.
function encodeRestliValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function isMessengerQuery(url: string, prefix: string): boolean {
  if (!url.includes("/voyager/api/voyagerMessagingGraphQL/graphql")) return false;
  return queryIdFromUrl(url)?.startsWith(prefix) ?? false;
}

function queryIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).searchParams.get("queryId"); } catch { return null; }
}

async function responseJson(
  response: { ok(): boolean; json(): Promise<unknown> } | null,
): Promise<unknown | null> {
  if (!response?.ok()) return null;
  try { return await response.json(); } catch { return null; }
}

function successfulVoyagerResponse(payload: unknown): VoyagerResponse {
  return { ok: true, status: 200, authWall: false, payload, error: null };
}

function failedVoyagerResponse(error: string): VoyagerResponse {
  return { ok: false, status: 0, authWall: false, payload: null, error };
}

async function voyagerGet(page: Page, path: string): Promise<VoyagerResponse> {
  return page.evaluate(async ({ path, origin }) => {
    const cookies = document.cookie.split("; ").reduce((result: Record<string, string>, cookie) => {
      const separator = cookie.indexOf("=");
      if (separator > 0) result[cookie.slice(0, separator)] = cookie.slice(separator + 1);
      return result;
    }, {});
    const csrf = (cookies.JSESSIONID || "").replace(/"/g, "");

    try {
      const response = await fetch(new URL(path, origin).toString(), {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/vnd.linkedin.normalized+json+2.1",
          "csrf-token": csrf,
          "x-li-lang": "en_US",
          "x-restli-protocol-version": "2.0.0",
        },
      });
      const authWall = response.status === 401 ||
        /linkedin\.com\/(?:login|authwall|checkpoint|uas\/)/i.test(response.url);
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("json")) {
        return {
          ok: false,
          status: response.status,
          authWall,
          payload: null,
          error: (await response.text()).slice(0, 300),
        };
      }
      return {
        ok: true,
        status: response.status,
        authWall,
        payload: await response.json(),
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        authWall: false,
        payload: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, { path, origin: LINKEDIN_ORIGIN }) as Promise<VoyagerResponse>;
}

function extractConversations(payload: unknown): ConversationPage[] {
  const index = buildRecordIndex(payload);
  const data = asRecord(asRecord(payload)?.data);
  const elementValues = arrayValue(data?.["*elements"] ?? data?.elements);
  const records: JsonRecord[] = elementValues
    .map((value) => resolveRecord(value, index))
    .filter((value): value is JsonRecord => value !== null);

  if (records.length === 0) {
    records.push(...findRecords(payload, isConversation));
  }

  const result: ConversationPage[] = [];
  const seen = new Set<string>();
  for (const conversation of records) {
    if (!isConversation(conversation)) continue;
    const urn = stringValue(conversation.entityUrn) ?? stringValue(conversation.backendUrn);
    if (!urn || seen.has(urn)) continue;
    seen.add(urn);
    result.push({ conversation, conversationUrn: urn, index });
  }
  return result;
}

function extractParticipantIdentities(conversation: JsonRecord, index: Map<string, JsonRecord>): Identity[] {
  const values = arrayValue(
    conversation["*participants"] ??
    conversation.participants ??
    conversation.conversationParticipants,
  );
  return values.map((value) => {
    const identity = emptyIdentity();
    collectIdentity(value, index, identity);
    return identity;
  });
}

function extractConversationEvents(conversation: JsonRecord, index: Map<string, JsonRecord>): JsonRecord[] {
  const values = arrayValue(conversation["*events"] ?? conversation.events);
  return values
    .map((value) => resolveRecord(value, index))
    .filter((value): value is JsonRecord => value !== null && isEvent(value));
}

function extractEvents(payload: unknown, index: Map<string, JsonRecord>): JsonRecord[] {
  const data = asRecord(asRecord(payload)?.data);
  const values = arrayValue(data?.["*elements"] ?? data?.elements);
  const referenced = values
    .map((value) => resolveRecord(value, index))
    .filter((value): value is JsonRecord => value !== null && isEvent(value));
  if (referenced.length > 0) return referenced;
  return findRecords(payload, isEvent);
}

function extractSenderIdentity(event: JsonRecord, index: Map<string, JsonRecord>): Identity {
  const identity = emptyIdentity();
  const sender = event["*from"] ?? event.from ?? event["*sender"] ?? event.sender ?? event["*actor"] ?? event.actor;
  collectIdentity(sender, index, identity);
  return identity;
}

function collectIdentity(
  value: unknown,
  index: Map<string, JsonRecord>,
  identity: Identity,
  visited = new Set<string>(),
  depth = 0,
): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const token = stableProfileToken(value);
    if (token) identity.tokens.add(token);
    if (!visited.has(value) && index.has(value)) {
      visited.add(value);
      collectIdentity(index.get(value), index, identity, visited, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIdentity(item, index, identity, visited, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;

  const publicIdentifier = stringValue(record.publicIdentifier);
  if (publicIdentifier) identity.vanities.add(normalizeVanity(publicIdentifier));

  for (const [key, child] of Object.entries(record)) {
    if (
      key === "entityUrn" || key === "memberUrn" || key === "profileUrn" ||
      key === "miniProfile" || key === "*miniProfile" || key === "profile" ||
      key === "*profile" || key === "participant" || key === "*participant"
    ) {
      collectIdentity(child, index, identity, visited, depth + 1);
    }
  }
}

function buildRecordIndex(payload: unknown): Map<string, JsonRecord> {
  const index = new Map<string, JsonRecord>();
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const values = [
    ...arrayValue(root?.included),
    ...arrayValue(data?.elements),
    ...findRecords(payload, (record) => typeof record.entityUrn === "string"),
  ];
  for (const value of values) {
    const record = asRecord(value);
    if (!record) continue;
    const urn = stringValue(record.entityUrn);
    if (urn) index.set(urn, record);
  }
  return index;
}

function resolveRecord(value: unknown, index: Map<string, JsonRecord>): JsonRecord | null {
  if (typeof value === "string") return index.get(value) ?? null;
  return asRecord(value);
}

function embeddedPayload(events: JsonRecord[]): JsonRecord {
  return { data: { elements: events }, included: events };
}

function meData(payload: unknown): unknown {
  return asRecord(payload)?.data ?? payload;
}

function isConversation(record: JsonRecord): boolean {
  const type = recordType(record);
  const urn = stringValue(record.entityUrn)?.toLowerCase() ?? "";
  return type.endsWith(".conversation") || urn.includes("conversation");
}

function isEvent(record: JsonRecord): boolean {
  const type = recordType(record);
  return type.endsWith(".event") || type.endsWith(".message") ||
    record.eventContent !== undefined;
}

function isMessageEvent(event: JsonRecord): boolean {
  if (recordType(event).endsWith(".message")) return true;
  const content = asRecord(event.eventContent);
  const contentType = stringValue(content?.$type)?.toLowerCase() ?? "";
  if (contentType.includes("messageevent")) return true;
  if (!content) return false;
  return content.attributedBody !== undefined || content.body !== undefined ||
    content.attachments !== undefined || content.renderContent !== undefined;
}

function recordType(record: JsonRecord): string {
  return (stringValue(record.$type) ?? stringValue(record._type) ?? "").toLowerCase();
}

function findRecords(
  value: unknown,
  predicate: (record: JsonRecord) => boolean,
  result: JsonRecord[] = [],
  seen = new Set<object>(),
): JsonRecord[] {
  if (Array.isArray(value)) {
    if (seen.has(value)) return result;
    seen.add(value);
    for (const child of value) findRecords(child, predicate, result, seen);
    return result;
  }

  const record = asRecord(value);
  if (!record || seen.has(record)) return result;
  seen.add(record);
  if (predicate(record)) result.push(record);
  for (const child of Object.values(record)) {
    findRecords(child, predicate, result, seen);
  }
  return result;
}

function stableProfileToken(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.match(/ACo[A-Za-z0-9_-]+/)?.[0] ?? null;
}

function vanityFromUrl(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!match) return null;
  try { return normalizeVanity(decodeURIComponent(match[1])); } catch { return normalizeVanity(match[1]); }
}

function normalizeVanity(value: string): string {
  return value.trim().toLowerCase();
}

function parseStoredDate(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function numericTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function emptyIdentity(): Identity {
  return { tokens: new Set<string>(), vanities: new Set<string>() };
}

function isLoginWall(url: string): boolean {
  return LOGIN_WALL.test(url);
}

function voyagerError(action: string, response: VoyagerResponse): string {
  const detail = response.error ? `: ${response.error.replace(/\s+/g, " ").trim()}` : "";
  return `LinkedIn ${action} failed (HTTP ${response.status || "network"})${detail}`;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
