import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Password" })
    .fill("pi-browser-test-only");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Cowork", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Email sending locked", { exact: true }),
  ).toBeVisible();
});

test("real settings show missing credentials and prevent autonomous sending", async ({
  page,
}) => {
  await expect(page.getByText(/Gmail: Not connected/)).toBeVisible();
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Settings JSON" });
  const settings = JSON.parse(await editor.inputValue());
  await editor.fill(
    JSON.stringify({
      ...settings,
      mode: "autonomous",
      killSwitch: false,
      sendDryRun: false,
    }),
  );
  await page
    .getByRole("button", { name: "Save settings version", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Deployment send lock");
  await page
    .getByRole("button", { name: "Connect Gmail read-only", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "PI_CREDENTIAL_ENCRYPTION_KEY",
  );
});

test("mock AR journey creates an approved task, with responsive case views and no external mail", async ({
  page,
}) => {
  const gmailRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("gmail.googleapis.com"))
      gmailRequests.push(request.url());
  });
  await page.getByRole("button", { name: "Test mode", exact: true }).click();
  await page
    .getByRole("button", { name: "Replay AR TYPE NOT POPULATED", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Synthetic journey completed",
  );
  await page.getByRole("button", { name: "task", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Download full task", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText('"approvalRecordId"');
  await expect(page.locator("main")).toContainText('"handoffStatus": "queued"');
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download full task", exact: true })
    .click();
  expect((await downloadPromise).suggestedFilename()).toMatch(
    /^task-.*\.json$/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of [
    "thread",
    "specifications",
    "approvals",
    "outbound",
    "evidence",
    "timeline",
    "task",
    "review",
  ]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  await page.getByRole("button", { name: "outbound", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Request send review", exact: true }),
  ).toHaveCount(0);
  expect(gmailRequests).toEqual([]);
});

test("PPO escalates, and existing Agents and Code modes still render", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Test mode", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Replay PPO authorization handling",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "high-risk case escalated",
  );
  await page.getByRole("button", { name: "task", exact: true }).click();
  await expect(page.locator("main")).toContainText("No approved task yet");
  await page
    .getByRole("button", { name: "Agents", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Code", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Code", exact: true }).first().click();
  await expect(
    page.getByRole("textbox", { name: "Type / for commands" }),
  ).toBeVisible();
});
