import type { Page } from "playwright";

/**
 * Visits a LinkedIn profile page. This registers as a profile view on LinkedIn.
 * Navigates and waits, then reports whether the page shows a 1st-degree badge —
 * lets the runner backfill degree=1 for contacts that were already connected
 * before Linki ever sent them a connection request (e.g. manually added leads).
 *
 * The target header's explicit "1st" badge is the degree signal. LinkedIn open
 * profiles can expose Message to 2nd/3rd-degree viewers, so Message alone is
 * not proof of a connection. The target-specific Message href is still useful:
 * it carries the profile URN needed for safe direct messaging after acceptance.
 */
export async function visitProfile(page: Page, linkedinUrl: string): Promise<{ isFirstDegree: boolean; messagingUrn: string | null }> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);

  // Current LinkedIn SDUI pages no longer render the profile name as an h1.
  // The target's primary Message action is the non-labelled compose link; the
  // recommendation links below it carry person-specific aria-labels.
  const messageLink = page.locator(
    'main a[href*="/messaging/compose"][href*="screenContext=NON_SELF_PROFILE_VIEW"]:not([aria-label]):visible'
  ).first();
  const messageHref = (await messageLink.count()) > 0 ? await messageLink.getAttribute("href").catch(() => null) : null;
  const urnMatch = messageHref?.match(/profileUrn=([^&]+)/);
  const messagingUrn = urnMatch ? decodeURIComponent(urnMatch[1]) : null;

  // Open-profile members can expose Message while still being 2nd/3rd degree.
  // Only the target header's explicit degree badge proves first-degree status.
  const mainText = await page.locator("main").innerText().catch(() => "");
  const profileHeaderText = mainText.split(/\bActivity\b/i, 1)[0] ?? "";
  return { isFirstDegree: /\b1st\b/.test(profileHeaderText), messagingUrn };
}
