import { randomBytes, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import {
  getSessionPage,
  markNeedsReauth,
  saveSessionState,
} from "@/lib/linkedin/session";

const LINKEDIN_MESSAGING_URL = "https://www.linkedin.com/messaging/";
const LINKEDIN_ME_URL = "https://www.linkedin.com/voyager/api/me";
const LINKEDIN_MESSAGES_URL =
  "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage";
const AUTH_WALL_PATH = /\/(?:login|authwall|checkpoint|uas)(?:\/|$)/i;
const PROFILE_URN = /^urn:li:(?:fsd_profile|fs_miniProfile):([A-Za-z0-9_-]+)$/i;
const CONVERSATION_URN = /^urn:li:(?:msg_conversation|fs_conversation):\S+$/i;
const MAX_GROUP_RECIPIENTS = 49; // LinkedIn's 50-member limit includes the sender.

interface VoyagerResponse {
  status: number;
  statusText: string;
  url: string;
  contentType: string;
  body: string;
}

interface VoyagerRequest {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
}

/** Resolve the authenticated account to the profile URN used by Messenger. */
export async function resolveCurrentMemberUrn(accountId: string): Promise<string> {
  assertAccountId(accountId);

  return withLinkedInSession(accountId, "resolve the current LinkedIn member", async (page, csrf) => {
    return fetchCurrentMemberUrn(page, csrf);
  });
}

/**
 * Create one LinkedIn group conversation with its real first message and return
 * the server-assigned URN. LinkedIn requires creation and the first message to
 * happen in the same createMessage mutation.
 */
export async function createLinkedInGroup(
  accountId: string,
  input: { participantUrns: string[]; title: string; initialMessage: string },
): Promise<{ conversationUrn: string }> {
  assertAccountId(accountId);
  if (!input || !Array.isArray(input.participantUrns)) {
    throw new Error("LinkedIn group participants must be an array of member URNs");
  }

  const title = requireNonEmptyString(input.title, "LinkedIn group title");
  const initialMessage = requireNonEmptyString(
    input.initialMessage,
    "LinkedIn initial group message",
  );
  const requestedParticipants = deduplicateMemberUrns(input.participantUrns);

  return withLinkedInSession(accountId, "create the LinkedIn group", async (page, csrf) => {
    const mailboxUrn = await fetchCurrentMemberUrn(page, csrf);
    const participantUrns = requestedParticipants.filter((urn) => urn !== mailboxUrn);

    if (participantUrns.length < 2) {
      throw new Error(
        "A LinkedIn group requires at least two distinct participant member URNs besides the sender",
      );
    }
    if (participantUrns.length > MAX_GROUP_RECIPIENTS) {
      throw new Error(
        `A LinkedIn group supports at most ${MAX_GROUP_RECIPIENTS} recipients besides the sender`,
      );
    }

    // LinkedIn has no empty-thread action. Supplying the intended introducer
    // message here makes group creation and that first message one atomic write.
    const response = await voyagerRequest(page, csrf, {
      url: LINKEDIN_MESSAGES_URL,
      method: "POST",
      body: {
        message: {
          body: { attributes: [], text: initialMessage },
          renderContentUnions: [],
          originToken: randomUUID(),
        },
        mailboxUrn,
        trackingId: createTrackingId(),
        dedupeByClientGeneratedToken: false,
        hostRecipientUrns: participantUrns,
        conversationTitle: title,
      },
    });
    assertVoyagerSuccess(response, "create the LinkedIn group");

    const conversationUrn = findConversationUrn(response.body);
    if (!conversationUrn) {
      throw new Error(
        "LinkedIn created the group but did not return a conversation URN; verify the Voyager response shape with a live account before retrying",
      );
    }
    return { conversationUrn };
  });
}

/** Send one plain-text message to an existing LinkedIn conversation. */
export async function sendLinkedInConversationMessage(
  accountId: string,
  conversationUrn: string,
  text: string,
): Promise<void> {
  assertAccountId(accountId);
  const normalizedConversationUrn = normalizeConversationUrn(conversationUrn);
  const normalizedText = requireNonEmptyString(text, "LinkedIn message text");

  await withLinkedInSession(accountId, "send the LinkedIn conversation message", async (page, csrf) => {
    const mailboxUrn = await fetchCurrentMemberUrn(page, csrf);
    const response = await voyagerRequest(page, csrf, {
      url: LINKEDIN_MESSAGES_URL,
      method: "POST",
      body: {
        message: {
          body: { attributes: [], text: normalizedText },
          renderContentUnions: [],
          conversationUrn: normalizedConversationUrn,
          originToken: randomUUID(),
        },
        mailboxUrn,
        trackingId: createTrackingId(),
        dedupeByClientGeneratedToken: false,
      },
    });
    assertVoyagerSuccess(response, "send the LinkedIn conversation message");
  });
}

async function withLinkedInSession<T>(
  accountId: string,
  operation: string,
  action: (page: Page, csrf: string) => Promise<T>,
): Promise<T> {
  const page = await getSessionPage(accountId);
  let sessionValidated = false;
  let needsReauth = false;

  try {
    await page.goto(LINKEDIN_MESSAGING_URL, {
      waitUntil: "domcontentloaded",
      timeout: 35_000,
    });

    if (isAuthWallUrl(page.url())) {
      needsReauth = true;
      throw reauthError(accountId, operation, page.url());
    }

    const cookies = await page.context().cookies("https://www.linkedin.com");
    const csrf = (cookies.find((cookie) => cookie.name === "JSESSIONID")?.value ?? "").replace(
      /"/g,
      "",
    );
    if (!csrf) {
      needsReauth = true;
      throw new Error(
        `Cannot ${operation}: LinkedIn session for account ${accountId} has no JSESSIONID cookie; re-authenticate the account`,
      );
    }

    sessionValidated = true;
    try {
      return await action(page, csrf);
    } catch (error) {
      if (error instanceof LinkedInAuthenticationError || isAuthWallUrl(page.url())) {
        needsReauth = true;
      }
      throw error;
    }
  } finally {
    try {
      if (isAuthWallUrl(page.url())) needsReauth = true;
    } catch {
      // A crashed page is not proof that the stored account session is invalid.
    }

    try {
      await page.close();
    } catch {
      // The session helper's queue safety valve will eventually release the slot.
    }

    if (needsReauth) {
      try {
        await markNeedsReauth(accountId);
      } catch {
        // Preserve the original, actionable transport error.
      }
    } else if (sessionValidated) {
      try {
        await saveSessionState(accountId);
      } catch {
        // A successful LinkedIn action must not be reported as failed merely
        // because refreshing the already-persisted cookie snapshot failed.
      }
    }
  }
}

async function fetchCurrentMemberUrn(page: Page, csrf: string): Promise<string> {
  const response = await voyagerRequest(page, csrf, {
    url: LINKEDIN_ME_URL,
    method: "GET",
  });
  assertVoyagerSuccess(response, "resolve the current LinkedIn member");

  let json: unknown;
  try {
    json = JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("LinkedIn /voyager/api/me returned an invalid JSON response");
  }

  for (const candidate of collectProfileUrnCandidates(json)) {
    try {
      return normalizeMemberUrn(candidate);
    } catch {
      // Some /me response fields are non-profile URNs; keep looking.
    }
  }

  throw new Error(
    "LinkedIn /voyager/api/me did not contain the current member profile URN; verify the response shape with a live account",
  );
}

async function voyagerRequest(
  page: Page,
  csrf: string,
  request: VoyagerRequest,
): Promise<VoyagerResponse> {
  const response = await page.evaluate(
    async ({ csrf, request }): Promise<VoyagerResponse> => {
      try {
        const result = await fetch(request.url, {
          method: request.method,
          credentials: "include",
          headers: {
            accept: "application/vnd.linkedin.normalized+json+2.1",
            "content-type": "text/plain;charset=UTF-8",
            "csrf-token": csrf,
            "x-li-lang": "en_US",
            "x-restli-protocol-version": "2.0.0",
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
        return {
          status: result.status,
          statusText: result.statusText,
          url: result.url,
          contentType: result.headers.get("content-type") ?? "",
          body: await result.text(),
        };
      } catch (error) {
        return {
          status: 0,
          statusText: error instanceof Error ? error.message : String(error),
          url: request.url,
          contentType: "",
          body: "",
        };
      }
    },
    { csrf, request },
  );

  if (isAuthenticationResponse(response)) {
    throw new LinkedInAuthenticationError(
      `LinkedIn session is no longer authenticated (${describeResponse(response)}); re-authenticate the account`,
    );
  }
  return response;
}

function assertVoyagerSuccess(response: VoyagerResponse, operation: string): void {
  if (response.status >= 200 && response.status < 300) return;

  const detail = response.status === 0 ? response.statusText : summarizeResponseBody(response.body);
  const suffix = detail ? `: ${detail}` : "";
  throw new Error(`Failed to ${operation} (${describeResponse(response)})${suffix}`);
}

function describeResponse(response: VoyagerResponse): string {
  if (response.status === 0) return `network error: ${response.statusText || "request failed"}`;
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

function summarizeResponseBody(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const message = [parsed.message, parsed.errorMessage, parsed.status]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const code = parsed.serviceErrorCode ?? parsed.errorCode;
    if (message && (typeof code === "string" || typeof code === "number")) {
      return `${message.trim()} (code ${String(code)})`;
    }
    if (message) return message.trim();
  } catch {
    // Avoid returning login HTML or an unbounded upstream body in runner logs.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

function isAuthenticationResponse(response: VoyagerResponse): boolean {
  if (response.status === 401 || isAuthWallUrl(response.url)) return true;
  if (!response.contentType.toLowerCase().includes("text/html")) return false;
  return /(?:linkedin\s+(?:login|sign in)|\/checkpoint\/|\/authwall)/i.test(response.body);
}

function isAuthWallUrl(url: string): boolean {
  try {
    return AUTH_WALL_PATH.test(new URL(url).pathname);
  } catch {
    return AUTH_WALL_PATH.test(url);
  }
}

function reauthError(accountId: string, operation: string, url: string): LinkedInAuthenticationError {
  return new LinkedInAuthenticationError(
    `Cannot ${operation}: LinkedIn redirected account ${accountId} to an authentication/checkpoint wall (${url}); re-authenticate the account`,
  );
}

class LinkedInAuthenticationError extends Error {}

function assertAccountId(accountId: string): void {
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("LinkedIn accountId must be a non-empty string");
  }
}

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.includes("\0")) throw new Error(`${label} must not contain null characters`);
  return normalized;
}

function deduplicateMemberUrns(memberUrns: string[]): string[] {
  const deduplicated = new Set<string>();
  for (let index = 0; index < memberUrns.length; index++) {
    try {
      deduplicated.add(normalizeMemberUrn(memberUrns[index]));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid LinkedIn participant at index ${index}: ${detail}`);
    }
  }
  return [...deduplicated];
}

function normalizeMemberUrn(value: unknown): string {
  if (typeof value !== "string") throw new Error("member URN must be a string");
  let urn = value.trim();
  if (/^urn%3a/i.test(urn)) {
    try {
      urn = decodeURIComponent(urn);
    } catch {
      throw new Error("member URN has invalid percent encoding");
    }
  }

  const match = urn.match(PROFILE_URN);
  if (!match) {
    throw new Error(
      `expected urn:li:fsd_profile:<id> (legacy fs_miniProfile URNs are also accepted), received ${JSON.stringify(value)}`,
    );
  }
  return `urn:li:fsd_profile:${match[1]}`;
}

function normalizeConversationUrn(value: unknown): string {
  if (typeof value !== "string") throw new Error("LinkedIn conversation URN must be a string");
  let urn = value.trim();
  if (/^urn%3a/i.test(urn)) {
    try {
      urn = decodeURIComponent(urn);
    } catch {
      throw new Error("LinkedIn conversation URN has invalid percent encoding");
    }
  }
  if (!CONVERSATION_URN.test(urn)) {
    throw new Error(`Invalid LinkedIn conversation URN: ${JSON.stringify(value)}`);
  }
  return urn;
}

function collectProfileUrnCandidates(value: unknown): string[] {
  const preferred: string[] = [];
  const fallback: string[] = [];
  const seen = new Set<unknown>();

  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);

    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }

    const record = item as Record<string, unknown>;
    for (const key of ["miniProfile", "profile", "dashEntityUrn", "entityUrn"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && PROFILE_URN.test(candidate.trim())) {
        preferred.push(candidate);
      }
    }
    for (const candidate of Object.values(record)) {
      if (typeof candidate === "string" && PROFILE_URN.test(candidate.trim())) {
        fallback.push(candidate);
      } else {
        visit(candidate);
      }
    }
  };

  visit(value);
  return [...preferred, ...fallback];
}

function findConversationUrn(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }

  const seen = new Set<unknown>();
  const visit = (value: unknown): string | null => {
    if (typeof value === "string") return CONVERSATION_URN.test(value) ? value : null;
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const child of value) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["conversationUrn", "backendConversationUrn", "entityUrn"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && CONVERSATION_URN.test(candidate)) return candidate;
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };

  return visit(parsed);
}

function createTrackingId(): string {
  return randomBytes(12).toString("base64");
}
