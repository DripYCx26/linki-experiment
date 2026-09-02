import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

type AccountRole = "introducer" | "main";

function parseRole(value: unknown): AccountRole | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (value === "introducer" || value === "main") return value;
  throw new Error("invalid_role");
}

function parseMemberUrn(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("invalid_member_urn");
  return value.trim() || null;
}

// Excludes cookies_json — the frontend never uses the raw session blob, only
// is_authenticated, so there's no reason to ship it (even encrypted) to the client.
const ACCOUNT_COLUMNS = `id, name, email, is_authenticated, daily_connection_limit, daily_message_limit, daily_inmail_limit,
  active_hours_start, active_hours_end, timezone, working_days, created_at,
  inbox_synced_at, accepted_sync_at, li_connections, li_pending, li_profile_views,
  li_stats_synced_at, connections_synced_through_ms, role, linkedin_member_urn`;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;

  if (req.method === "GET") {
    const account = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id);
    if (!account) return res.status(404).json({ error: "Not found" });
    return res.json(account);
  }

  if (req.method === "PUT") {
    const { name, email, daily_connection_limit, daily_message_limit, daily_inmail_limit, active_hours_start, active_hours_end, timezone, working_days } = req.body;
    try {
      const role = parseRole(req.body.role);
      const linkedinMemberUrn = parseMemberUrn(req.body.linkedin_member_urn);
      db.prepare(
        `UPDATE accounts SET
          name = COALESCE(?, name),
          email = COALESCE(?, email),
          daily_connection_limit = COALESCE(?, daily_connection_limit),
          daily_message_limit = COALESCE(?, daily_message_limit),
          daily_inmail_limit = COALESCE(?, daily_inmail_limit),
          active_hours_start = COALESCE(?, active_hours_start),
          active_hours_end = COALESCE(?, active_hours_end),
          timezone = COALESCE(?, timezone),
          working_days = COALESCE(?, working_days),
          role = CASE WHEN ? THEN ? ELSE role END,
          linkedin_member_urn = CASE WHEN ? THEN ? ELSE linkedin_member_urn END
         WHERE id = ?`
      ).run(
        name, email, daily_connection_limit, daily_message_limit, daily_inmail_limit,
        active_hours_start, active_hours_end, timezone, working_days,
        role !== undefined ? 1 : 0, role ?? null,
        linkedinMemberUrn !== undefined ? 1 : 0, linkedinMemberUrn ?? null,
        id
      );
      return res.json(db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id));
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_role") {
        return res.status(400).json({ error: "role must be introducer, main, or null" });
      }
      if (error instanceof Error && error.message === "invalid_member_urn") {
        return res.status(400).json({ error: "linkedin_member_urn must be a string or null" });
      }
      if (error instanceof Error && error.message.includes("accounts.role")) {
        return res.status(409).json({ error: "role_already_assigned", message: "Only one account can have each LinkedIn handoff role." });
      }
      if (error instanceof Error && error.message.includes("accounts.email")) {
        return res.status(409).json({ error: "Email already exists" });
      }
      throw error;
    }
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
