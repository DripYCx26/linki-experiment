import type { Page } from "playwright";

export class WeeklyLimitError extends Error {}
export class AlreadyConnectedError extends Error {}
export class PendingInviteError extends Error {}

/**
 * Sends a LinkedIn connection request without a note.
 * Navigates to the profile page and clicks the Connect button.
 * Throws WeeklyLimitError if the weekly limit popup appears.
 * Throws AlreadyConnectedError / PendingInviteError if already in that state.
 */
export async function sendConnectionRequest(page: Page, linkedinUrl: string): Promise<void> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000 + Math.random() * 1000);

  const targetVanity = (() => {
    try {
      return new URL(linkedinUrl).pathname.match(/^\/in\/([^/]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  if (!targetVanity) throw new Error(`Invalid LinkedIn profile URL: ${linkedinUrl}`);

  // LinkedIn's current SDUI profile renders the person's name as styled text,
  // not an h1. The target header is still the first content in <main>; stop at
  // Activity so degree badges from feed posts/recommendations cannot leak in.
  const mainText = await page.locator("main").innerText().catch(() => "");
  const profileHeaderText = mainText.split(/\bActivity\b/i, 1)[0] ?? "";

  // Only the target header's explicit degree badge is authoritative here.
  // Open-profile 2nd/3rd-degree members can expose a Message link too.
  if (/\b1st\b/.test(profileHeaderText)) throw new AlreadyConnectedError("Already connected");

  // Pending?
  if (/\bPending\b/.test(profileHeaderText)) throw new PendingInviteError("Invitation already pending");
  const pendingBtn = page.locator('main button[aria-label*="Pending"]:visible').first();
  if (await pendingBtn.count() > 0) throw new PendingInviteError("Invitation already pending");

  // Case 1: target-specific Connect link. Match the target vanity exactly: a
  // page-wide generic custom-invite selector can select an unrelated person in
  // "People you may know" and send the invitation to them instead.
  const directConnect = page.locator(`main a[href*="custom-invite"][href*="vanityName=${targetVanity}"]:visible`).first();
  if (await directConnect.count() > 0) {
    const href = await directConnect.getAttribute("href");
    if (!href) throw new Error("Connect link has no href");
    const inviteUrl = href.startsWith("http") ? href : `https://www.linkedin.com${href}`;
    await page.goto(inviteUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);
  } else {
    // Case 2: Connect is inside the target's "..." More menu. Open-profile
    // members can expose a Message link while still being 2nd/3rd degree, so
    // use that target-specific action row only as a scoping anchor.
    const targetMessageLink = page.locator(
      'main a[href*="/messaging/compose"][href*="screenContext=NON_SELF_PROFILE_VIEW"]:not([aria-label]):visible'
    ).first();
    const targetFollowButton = page.locator('main button[aria-label^="Follow "]:visible').first();
    const actionAnchor = await targetMessageLink.count() > 0 ? targetMessageLink : targetFollowButton;
    if (await actionAnchor.count() === 0) {
      throw new Error("Could not identify the target profile action row safely");
    }
    const actionRow = actionAnchor.locator('xpath=ancestor::div[.//button[@aria-label="More"]][1]');
    const scopedMore = actionRow.locator('button[aria-label="More"]:visible').first();
    if (await scopedMore.count() === 0) {
      throw new Error("Target profile action row has no More menu");
    }
    await scopedMore.click();
    await page.waitForTimeout(800);

    // Check for Pending in the menu — means invite was already sent
    const pendingMenuItem = page.locator('[role="menuitem"]:has-text("Pending"):visible');
    if (await pendingMenuItem.count() > 0) throw new PendingInviteError("Invitation already pending (found in More menu)");

    const connectOption = page.locator('[role="menuitem"]:visible').filter({ hasText: /^\s*Connect\s*$/ });
    if (await connectOption.count() === 0) throw new Error("Connect option not found in More menu");
    await connectOption.first().click();
  }

  await page.waitForTimeout(1000);

  // Click "Send without a note" / "Send now"
  const sendBtn = page.locator(
    'button:has-text("Send now"), button[aria-label*="Send without"], button[aria-label*="Send invitation"]:not([aria-label*="note"])'
  );
  if (await sendBtn.count() > 0) {
    await sendBtn.first().click({ force: true });
    await page.waitForTimeout(1500);
  }

  // Check for weekly limit popup
  const limitPopup = page.locator('div[class*="ip-fuse-limit-alert__warning"]');
  if (await limitPopup.count() > 0) throw new WeeklyLimitError("Weekly connection limit reached");

  // Check for error toast
  const errorToast = page.locator('div[data-test-artdeco-toast-item-type="error"]:visible');
  if (await errorToast.count() > 0) {
    const msg = await errorToast.innerText();
    throw new Error(`Connection error: ${msg.trim()}`);
  }
}
